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
  type KaizenEngine,
  type KaizenEventName,
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

function statusFor(code: string): number {
  switch (code) {
    case 'INVALID_INPUT':
      return 400;
    case 'NETWORK_NOT_FOUND':
    case 'NODE_NOT_FOUND':
      return 404;
    case 'NETWORK_ALREADY_EXISTS':
    case 'NETWORK_ALREADY_RUNNING':
    case 'NODE_ALREADY_RUNNING':
    case 'NODE_NOT_RUNNING':
    case 'BINARY_NOT_AVAILABLE':
      return 409;
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

export function createServer(engine: KaizenEngine): FastifyInstance {
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
      const snapshot = engine.monitoring.getLatest(params.id);
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
