/**
 * Kaizen API — REST + WebSocket transport over the shared engine.
 *
 * Rules:
 *  - every route delegates to engine services; no operational logic here
 *  - inputs are validated with Zod; failures return structured errors
 *  - only implemented operations are exposed (nothing speculative)
 *  - binds to 127.0.0.1 by default; node RPC never proxied externally
 *
 * NOTE: routes are registered inside a plugin scope that loads AFTER
 * @fastify/websocket. The plugin installs an `onRoute` hook at load time;
 * routes added synchronously on the root instance BEFORE that would silently
 * ignore `websocket: true` (observed live: handshake → 500).
 */

import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  isKaizenError,
  KAIZEN_VERSION,
  SCENARIO_RUN_STATES,
  scenarioRunReplayNote,
  type KaizenEngine,
  type KaizenEventName,
  probeV3Connectivity,
  type V3ConnectivityReport,
} from '@kaizen/engine';

export const API_HOST = '127.0.0.1';
export const API_PORT = Number(process.env['PORT'] ?? 4310);

const createNetworkBody = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'name must match ^[a-z0-9][a-z0-9_-]{0,31}$'),
  preset: z
    .enum(['single-node', 'two-node', 'four-validator', 'validator-fullnode', 'custom'])
    .default('single-node'),
  /** Required (and only allowed) for preset === 'custom'. */
  custom: z
    .object({
      nodes: z
        .array(
          z.object({
            name: z.string().min(1).max(32),
            role: z.enum(['validator', 'full']),
            wellKnownKey: z
              .enum(['alice', 'bob', 'charlie', 'dave', 'eve', 'ferdie'])
              .optional(),
          }),
        )
        .min(1),
    })
    .optional(),
});

const idParam = z.object({ id: z.string().min(1) });
const nodeParam = z.object({ id: z.string().min(1), nodeId: z.string().min(1) });
const logsQuery = z.object({
  maxBytes: z.coerce.number().int().min(1_024).max(65_536).default(16_384),
});

// Fault request bodies (T-3.2). The engine re-validates everything
// server-side — these schemas only bound the wire format. Execution is a
// separate explicit action: /dry-run is the default surface and /execute
// demands an explicit mode:'execute' marker.
const faultBody = z.object({
  nodeId: z.string().min(1),
  type: z.enum(['pause', 'terminate', 'peer-disconnect', 'partition']),
  options: z
    .object({ durationMs: z.number().int().min(0).max(600_000).optional() })
    .optional(),
  requestedBy: z.string().min(1).max(64).optional(),
});
const faultExecuteBody = faultBody.extend({ mode: z.literal('execute') });
const faultIdParam = z.object({ faultId: z.string().min(1) });
const faultListQuery = z.object({ nodeId: z.string().min(1).optional() });

// Scenario execution requests (T-3.4). The engine re-validates EVERYTHING
// server-side with fresh reads (stored definition, DEC-008 target gates,
// label → node resolution, quarantine, conflicting executions, and the
// injector's own preflight) — these schemas only bound the wire format.
// Execution demands an explicit mode:'execute' marker plus an explicitly
// selected target: a saved scenario is never authorization to run it.
const runIdParam = z.object({ runId: z.string().min(1) });
const executeRunBody = z.object({
  mode: z.literal('execute'),
  networkIdOrName: z.string().min(1).max(64),
  requestedBy: z.string().min(1).max(64).optional(),
});
const runListQuery = z.object({
  scenarioId: z.string().min(1).max(64).optional(),
  networkId: z.string().min(1).max(64).optional(),
  state: z.enum(SCENARIO_RUN_STATES).optional(),
  /** Only runs replayed FROM this source run (T-3.5 provenance query). */
  replayOf: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
const cancelRunBody = z.object({ requestedBy: z.string().min(1).max(64).optional() });

// V3 anchoring (T-8.2). Anchoring spends testnet funds from the operator's
// env-configured signer, so it demands the same explicit mode:'execute'
// marker as fault/scenario execution. Registry deployment is deliberately
// NOT exposed over HTTP (one-time operator action: `kaizen v3 deploy-registry`).
const anchorBody = z.object({
  mode: z.literal('execute'),
  runId: z.string().min(1).max(64),
  method: z.enum(['contract', 'remark']).optional(),
  requestedBy: z.string().min(1).max(64).optional(),
});
const anchorIdParam = z.object({ anchorId: z.string().min(1).max(64) });
const anchorListQuery = z.object({
  runId: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export interface ServerOptions {
  /** V3 probe implementation (DI seam for tests). Default: real probe of the
   *  env/default-configured endpoints — never a caller-supplied URL. */
  probeV3?: () => Promise<V3ConnectivityReport>;
}

function statusFor(code: string): number {
  switch (code) {
    case 'INVALID_INPUT':
    case 'SCENARIO_INVALID':
      return 400;
    case 'FAULT_NOT_ALLOWED':
    case 'SCENARIO_EXEC_NOT_ALLOWED':
      return 403;
    case 'NETWORK_NOT_FOUND':
    case 'NODE_NOT_FOUND':
    case 'FAULT_NOT_FOUND':
    case 'SCENARIO_NOT_FOUND':
    case 'SCENARIO_RUN_NOT_FOUND':
    case 'V3_ANCHOR_NOT_FOUND':
      return 404;
    case 'NETWORK_ALREADY_EXISTS':
    case 'NETWORK_ALREADY_RUNNING':
    case 'NODE_ALREADY_RUNNING':
    case 'NODE_NOT_RUNNING':
    case 'BINARY_NOT_AVAILABLE':
    case 'FAULT_CONFLICT':
    case 'FAULT_NOT_SUPPORTED':
    case 'SCENARIO_ALREADY_EXISTS':
    case 'SCENARIO_VERSION_UNSUPPORTED':
    case 'SCENARIO_RUN_CONFLICT':
    case 'SCENARIO_RUN_NOT_REPLAYABLE':
    case 'V3_SIGNER_NOT_CONFIGURED':
    case 'V3_SIGNER_INVALID':
    case 'V3_REGISTRY_NOT_DEPLOYED':
    case 'V3_RUN_NOT_ANCHORABLE':
    case 'V3_ALREADY_ANCHORED':
    case 'V3_INSUFFICIENT_FUNDS':
      return 409;
    case 'V3_TX_FAILED':
      return 502;
    default:
      return 500;
  }
}

function requireParam<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  reply: { status: (code: number) => { send: (body: unknown) => void } },
): T | null {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    reply.status(400).send({ ok: false, error: { code: 'INVALID_INPUT', message: 'bad id' } });
    return null;
  }
  return parsed.data;
}

export function createServer(engine: KaizenEngine, options: ServerOptions = {}): FastifyInstance {
  const probeV3 = options.probeV3 ?? (() => probeV3Connectivity());
  const app = Fastify({ logger: false });

  // Ordered: websocket plugin FIRST so its onRoute hook exists for the
  // route scope registered immediately after.
  app.register(websocket);
  app.register(async (scope) => {
    // ---- WebSocket event stream --------------------------------------------
    scope.get('/api/events', { websocket: true }, (socket) => {
      socket.send(JSON.stringify({ type: 'hello', version: KAIZEN_VERSION }));
      const unsubscribe = engine.events.subscribe((name: KaizenEventName, payload) => {
        try {
          socket.send(JSON.stringify({ type: 'event', name, payload }));
        } catch {
          /* socket already closed */
        }
      });
      socket.on('close', () => unsubscribe());
    });

    // ---- meta --------------------------------------------------------------
    scope.get('/api/health', async () => ({
      ok: true,
      service: 'kaizen-api',
      version: KAIZEN_VERSION,
      dataDir: engine.dataDir,
    }));

    scope.get('/api/binaries', async () => ({
      ok: true,
      status: await engine.binaries.status(),
    }));

    // ---- networks ----------------------------------------------------------
    scope.get('/api/networks', async () => ({
      ok: true,
      networks: engine.networks.list(),
    }));

    scope.post('/api/networks', async (req, reply) => {
      const parsed = createNetworkBody.safeParse(req.body);
      if (!parsed.success) {
        reply.status(400).send({
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Invalid network creation request',
            details: { issues: parsed.error.issues },
          },
        });
        return;
      }
      const record = await engine.networks.create(parsed.data);
      reply.status(201).send({ ok: true, network: record });
    });

    scope.get('/api/networks/:id', async (req, reply) => {
      const id = requireParam(idParam, req.params, reply);
      if (!id) return;
      const { network, nodes } = engine.networks.getNetwork(id.id);
      reply.send({ ok: true, network, nodes });
    });

    scope.post('/api/networks/:id/start', async (req, reply) => {
      const id = requireParam(idParam, req.params, reply);
      if (!id) return;
      const result = await engine.networks.start(id.id);
      reply.send({ ok: result.ok, result });
    });

    scope.post('/api/networks/:id/stop', async (req, reply) => {
      const id = requireParam(idParam, req.params, reply);
      if (!id) return;
      const result = await engine.networks.stop(id.id);
      reply.send({ ok: result.ok, result });
    });

    scope.get('/api/networks/:id/status', async (req, reply) => {
      const id = requireParam(idParam, req.params, reply);
      if (!id) return;
      const inspection = await engine.networks.inspect(id.id);
      reply.send({ ok: true, inspection });
    });

    scope.delete('/api/networks/:id', async (req, reply) => {
      const id = requireParam(idParam, req.params, reply);
      if (!id) return;
      await engine.networks.remove(id.id);
      reply.send({ ok: true, removed: id.id });
    });

    scope.post('/api/networks/:id/purge', async (req, reply) => {
      const id = requireParam(idParam, req.params, reply);
      if (!id) return;
      const result = await engine.networks.purgeChain(id.id);
      reply.send({ ok: result.ok, result });
    });

    // ---- monitoring --------------------------------------------------------
    scope.get('/api/networks/:id/monitor', async (req, reply) => {
      const id = requireParam(idParam, req.params, reply);
      if (!id) return;
      // Prefer the live polling loop's snapshot; sample on demand otherwise.
      const snapshot =
        engine.monitoring.getLatest(id.id) ?? (await engine.monitoring.snapshotNow(id.id));
      reply.send({ ok: true, snapshot });
    });

    // ---- nodes -------------------------------------------------------------
    scope.get('/api/networks/:id/nodes/:nodeId', async (req, reply) => {
      const params = requireParam(nodeParam, req.params, reply);
      if (!params) return;
      const { network, nodes } = engine.networks.getNetwork(params.id);
      const node = nodes.find((n) => n.id === params.nodeId);
      if (!node) {
        reply.status(404).send({
          ok: false,
          error: { code: 'NODE_NOT_FOUND', message: `No node ${params.nodeId} in ${network.name}` },
        });
        return;
      }
      // Same fallback as the monitor route: after a fresh start the polling
      // loop may not have stored a snapshot yet — sample on demand instead
      // of reporting "no data" while the node is verifiably running.
      const snapshot =
        engine.monitoring.getLatest(params.id) ?? (await engine.monitoring.snapshotNow(params.id));
      const sample = snapshot?.samples.find((s) => s.nodeId === node.id) ?? null;
      const health = snapshot?.health.find((h) => h.nodeId === node.id) ?? null;
      reply.send({ ok: true, node, sample, health });
    });

    scope.post('/api/networks/:id/nodes/:nodeId/start', async (req, reply) => {
      const params = requireParam(nodeParam, req.params, reply);
      if (!params) return;
      const result = await engine.networks.startNode(params.nodeId);
      reply.send({ ok: result.ok, result });
    });

    scope.post('/api/networks/:id/nodes/:nodeId/stop', async (req, reply) => {
      const params = requireParam(nodeParam, req.params, reply);
      if (!params) return;
      const result = await engine.networks.stopNode(params.nodeId);
      reply.send({ ok: result.ok, result });
    });

    scope.get('/api/networks/:id/nodes/:nodeId/logs', async (req, reply) => {
      const params = requireParam(nodeParam, req.params, reply);
      if (!params) return;
      const parsed = logsQuery.safeParse(req.query);
      if (!parsed.success) {
        reply.status(400).send({
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Invalid log query',
            details: { issues: parsed.error.issues },
          },
        });
        return;
      }
      const tail = engine.networks.nodeLogTail(params.nodeId, parsed.data.maxBytes);
      reply.send({ ok: true, nodeId: tail.nodeId, lines: tail.lines });
    });

    // ---- faults (FailureInjector, T-3.2) -----------------------------------
    // Transport-only layer: body/params are Zod-validated, then the engine
    // re-validates the whole safety boundary (designatedTest chain gate
    // DEC-008, node ownership, managed-process identity, conflicts). No
    // generic execution surface — only typed fault methods on registered
    // disposable networks. Dry-run is the default; execute is a separate,
    // explicit call that must carry mode:'execute'.
    scope.post('/api/networks/:id/faults/preflight', async (req, reply) => {
      const params = requireParam(idParam, req.params, reply);
      if (!params) return;
      const body = faultBody.safeParse(req.body);
      if (!body.success) {
        reply.status(400).send({
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'Invalid fault request', details: { issues: body.error.issues } },
        });
        return;
      }
      const preflight = await engine.faults.preflight({
        networkIdOrName: params.id,
        nodeId: body.data.nodeId,
        type: body.data.type,
        options: body.data.options,
        requestedBy: body.data.requestedBy ?? 'api',
      });
      reply.send({ ok: preflight.ok, preflight });
    });

    scope.post('/api/networks/:id/faults/dry-run', async (req, reply) => {
      const params = requireParam(idParam, req.params, reply);
      if (!params) return;
      const body = faultBody.safeParse(req.body);
      if (!body.success) {
        reply.status(400).send({
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'Invalid fault request', details: { issues: body.error.issues } },
        });
        return;
      }
      const preview = await engine.faults.dryRun({
        networkIdOrName: params.id,
        nodeId: body.data.nodeId,
        type: body.data.type,
        options: body.data.options,
        requestedBy: body.data.requestedBy ?? 'api',
      });
      if (preview.state !== 'ready') {
        // Gate/capability denial: visible at the HTTP layer, preview keeps the
        // full check list + precise unblock path.
        reply.status(403).send({ ok: false, preview });
        return;
      }
      reply.send({ ok: true, preview });
    });

    scope.post('/api/networks/:id/faults/execute', async (req, reply) => {
      const params = requireParam(idParam, req.params, reply);
      if (!params) return;
      const body = faultExecuteBody.safeParse(req.body);
      if (!body.success) {
        reply.status(400).send({
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message:
              'Execution requires an explicit mode:"execute" marker — POST /faults/dry-run is the default surface',
            details: { issues: body.error.issues },
          },
        });
        return;
      }
      const result = await engine.faults.execute({
        networkIdOrName: params.id,
        nodeId: body.data.nodeId,
        type: body.data.type,
        options: body.data.options,
        requestedBy: body.data.requestedBy ?? 'api',
      });
      // The fault RAN: 200 with the structured result. ok/outcome/claims
      // distinguish accepted vs applied vs observed vs recovered.
      reply.send({ ok: result.ok, result });
    });

    scope.get('/api/networks/:id/faults', async (req, reply) => {
      const params = requireParam(idParam, req.params, reply);
      if (!params) return;
      const { network } = engine.networks.getNetwork(params.id); // throws NOT_FOUND
      const query = faultListQuery.safeParse(req.query);
      if (!query.success) {
        reply.status(400).send({
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'Invalid fault query', details: { issues: query.error.issues } },
        });
        return;
      }
      const faults = engine.faults.list({
        networkId: network.id,
        nodeId: query.data.nodeId,
      });
      reply.send({ ok: true, faults });
    });

    scope.get('/api/faults/:faultId', async (req, reply) => {
      const params = requireParam(faultIdParam, req.params, reply);
      if (!params) return;
      reply.send({ ok: true, fault: engine.faults.get(params.faultId) });
    });

    scope.post('/api/faults/:faultId/cancel', async (req, reply) => {
      const params = requireParam(faultIdParam, req.params, reply);
      if (!params) return;
      const fault = await engine.faults.cancel(params.faultId);
      reply.send({ ok: true, fault });
    });

    scope.post('/api/faults/:faultId/reconcile', async (req, reply) => {
      const params = requireParam(faultIdParam, req.params, reply);
      if (!params) return;
      const fault = await engine.faults.reconcile(params.faultId);
      reply.send({ ok: fault.reconciled === true, fault });
    });

    // ---- scenarios (authoring, T-3.3) --------------------------------------
    // CRUD + validate ONLY. Saving, updating, or validating a scenario NEVER
    // runs anything: authoring endpoints have no execution path, no fault
    // target, and no process power. Execution lives in the separate T-3.4
    // run endpoints below — always through the engine's own gates + the
    // FailureInjector (never through an authoring route). Authorization is
    // the existing DEC-019 posture: loopback-only binding, JSON-only, no
    // browser invocation; scenario endpoints add no host-execution power.

    const scenarioListQuery = z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      tag: z.string().min(1).max(24).optional(),
      q: z.string().min(1).max(64).optional(),
      status: z.enum(['valid', 'warning']).optional(),
    });

    scope.get('/api/scenarios', async (req, reply) => {
      const query = scenarioListQuery.safeParse(req.query);
      if (!query.success) {
        reply.status(400).send({
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Invalid scenario query',
            details: { issues: query.error.issues },
          },
        });
        return;
      }
      reply.send({ ok: true, ...engine.scenarios.list(query.data) });
    });

    // Safe operation registry (descriptive; static route matches before /:id).
    scope.get('/api/scenarios/operations', async () => ({
      ok: true,
      operations: engine.scenarios.describeOperations(),
    }));

    // Validate a scenario WITHOUT saving it (and without executing anything).
    scope.post('/api/scenarios/validate', async (req, reply) => {
      const result = engine.scenarios.validate(req.body);
      // Always 200: this reports validity, it is not an operation failure.
      reply.send({ ok: result.valid, result });
    });

    scope.post('/api/scenarios', async (req, reply) => {
      const scenario = engine.scenarios.create(req.body, 'api');
      reply.status(201).send({ ok: true, scenario });
    });

    scope.get('/api/scenarios/:id', async (req, reply) => {
      const params = requireParam(idParam, req.params, reply);
      if (!params) return;
      reply.send({ ok: true, scenario: engine.scenarios.get(params.id) });
    });

    scope.put('/api/scenarios/:id', async (req, reply) => {
      const params = requireParam(idParam, req.params, reply);
      if (!params) return;
      const scenario = engine.scenarios.update(params.id, req.body, 'api');
      reply.send({ ok: true, scenario });
    });

    scope.delete('/api/scenarios/:id', async (req, reply) => {
      const params = requireParam(idParam, req.params, reply);
      if (!params) return;
      engine.scenarios.remove(params.id, 'api');
      reply.send({ ok: true, removed: params.id });
    });

    // ---- scenario runs (T-3.4, execution surface) --------------------------
    // Separate from authoring on purpose: an execute request is an explicit,
    // target-selected action (mode:'execute'), the run is persisted BEFORE
    // any side effect, and gate failures come back as structured 4xx with
    // the rejected run id — never as an executed fault. Runs execute in the
    // background (bounded); clients poll run status or cancel — no held
    // connections, no arbitrary parameters, no registry bypass.

    scope.post('/api/scenarios/:id/execute', async (req, reply) => {
      const params = requireParam(idParam, req.params, reply);
      if (!params) return;
      const body = executeRunBody.safeParse(req.body);
      if (!body.success) {
        reply.status(400).send({
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Invalid scenario execution request',
            details: {
              issues: body.error.issues,
              hint: 'execution requires mode:"execute" and an explicit networkIdOrName target',
            },
          },
        });
        return;
      }
      const run = engine.scenarioRuns.execute({
        scenarioId: params.id,
        ...body.data,
      });
      // 202: the run is persisted and executing in the background.
      reply.status(202).send({ ok: true, run });
    });

    scope.get('/api/scenarios/runs', async (req, reply) => {
      const query = runListQuery.safeParse(req.query);
      if (!query.success) {
        reply.status(400).send({
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Invalid scenario run query',
            details: { issues: query.error.issues },
          },
        });
        return;
      }
      reply.send({ ok: true, ...engine.scenarioRuns.list(query.data) });
    });

    scope.get('/api/scenarios/runs/:runId', async (req, reply) => {
      const params = requireParam(runIdParam, req.params, reply);
      if (!params) return;
      reply.send({ ok: true, run: engine.scenarioRuns.get(params.runId) });
    });

    scope.post('/api/scenarios/runs/:runId/cancel', async (req, reply) => {
      const params = requireParam(runIdParam, req.params, reply);
      if (!params) return;
      const body = cancelRunBody.safeParse(req.body ?? {});
      if (!body.success) {
        reply.status(400).send({
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Invalid cancellation request',
            details: { issues: body.error.issues },
          },
        });
        return;
      }
      const run = await engine.scenarioRuns.cancel(params.runId, body.data.requestedBy ?? 'api');
      reply.send({ ok: true, run });
    });

    // ---- scenario run replay (T-3.5) ---------------------------------------
    // Re-executes the SOURCE run's immutable snapshot as a NEW run through
    // the same engine path (gates -> injector -> evidence). The target must
    // be explicitly confirmed again (same mode:'execute' posture as
    // execute): a historical run is provenance, never authorization. Replay
    // repeats actions — it does not promise identical outcomes, and the
    // response carries the NEW run (fresh evidence), never a copy of the
    // source run's results.
    scope.post('/api/scenarios/runs/:runId/replay', async (req, reply) => {
      const params = requireParam(runIdParam, req.params, reply);
      if (!params) return;
      const body = executeRunBody.safeParse(req.body);
      if (!body.success) {
        reply.status(400).send({
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Invalid replay request',
            details: { issues: body.error.issues },
          },
        });
        return;
      }
      const run = engine.scenarioRuns.replay({
        runId: params.runId,
        networkIdOrName: body.data.networkIdOrName,
        mode: 'execute',
        ...(body.data.requestedBy !== undefined ? { requestedBy: body.data.requestedBy } : {}),
      });
      // 202: the NEW run is persisted and executing in the background.
      // `replayNote` states the honest contract inline: replay repeats the
      // source run's actions; it never promises identical outcomes, and the
      // run's evidence is freshly observed (never a copy of the source).
      reply.status(202).send({ ok: true, run, replayNote: scenarioRunReplayNote(run) });
    });

    // ---- Portaldot V3 (T-8.1 probe + T-8.2 anchoring) -----------------------
    scope.get('/api/v3/probe', async () => {
      const report = await probeV3();
      return { ok: true, report };
    });

    scope.get('/api/v3/status', async () => ({
      ok: true,
      status: await engine.v3Anchors.status(),
    }));

    scope.get('/api/v3/anchors', async (req, reply) => {
      const q = anchorListQuery.safeParse(req.query ?? {});
      if (!q.success) {
        reply.status(400).send({
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'Invalid anchor query', details: { issues: q.error.issues } },
        });
        return;
      }
      reply.send({
        ok: true,
        anchors: engine.v3Anchors.list({
          ...(q.data.runId !== undefined ? { runId: q.data.runId } : {}),
          ...(q.data.limit !== undefined ? { limit: q.data.limit } : {}),
        }),
        contracts: engine.v3Anchors.contracts(),
        explorerBlockUrlTemplate: engine.v3Anchors.explorerBlockUrlTemplate(),
      });
    });

    scope.get('/api/v3/anchors/:anchorId', async (req, reply) => {
      const params = requireParam(anchorIdParam, req.params, reply);
      if (!params) return;
      reply.send({ ok: true, anchor: engine.v3Anchors.get(params.anchorId) });
    });

    scope.post('/api/v3/anchors', async (req, reply) => {
      const body = anchorBody.safeParse(req.body);
      if (!body.success) {
        reply.status(400).send({
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'Invalid anchor request', details: { issues: body.error.issues } },
        });
        return;
      }
      const anchor = await engine.v3Anchors.anchorRun(body.data.runId, {
        requestedBy: body.data.requestedBy ?? 'api',
        ...(body.data.method !== undefined ? { method: body.data.method } : {}),
      });
      reply.status(201).send({ ok: anchor.status !== 'failed', anchor });
    });

    scope.post('/api/v3/anchors/:anchorId/verify', async (req, reply) => {
      const params = requireParam(anchorIdParam, req.params, reply);
      if (!params) return;
      reply.send({ ok: true, verification: await engine.v3Anchors.verify(params.anchorId) });
    });

    scope.get('/api/v3/runs/:runId/hash', async (req, reply) => {
      const params = requireParam(runIdParam, req.params, reply);
      if (!params) return;
      reply.send({ ok: true, ...engine.v3Anchors.hashRun(params.runId) });
    });
  });
  // Never expose setup/download over the API: binary acquisition is an
  // explicit CLI-only decision (`kaizen setup`).

  // ---- error handling (structured, no stack leaks) -------------------------
  app.setErrorHandler((error, _req, reply) => {
    if (isKaizenError(error)) {
      const json = error.toJSON();
      reply.status(statusFor(json.code)).send({ ok: false, error: json });
      return;
    }
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    if (statusCode >= 400 && statusCode < 500) {
      // Framework-level client errors (e.g. malformed JSON bodies) — honor
      // the 4xx classification with a structured envelope, never a 500.
      const message = error instanceof Error ? error.message : String(error);
      reply.status(statusCode).send({
        ok: false,
        error: { code: 'INVALID_INPUT', message },
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    reply.status(500).send({ ok: false, error: { code: 'INTERNAL', message } });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({
      ok: false,
      error: { code: 'NETWORK_NOT_FOUND', message: 'Unknown API route' },
    });
  });

  return app;
}
