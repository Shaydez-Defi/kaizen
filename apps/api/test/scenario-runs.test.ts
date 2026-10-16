/**
 * Scenario RUN API tests (T-3.4).
 *
 * Real Fastify app + real SQLite (temp dataDir), driven via app.inject — no
 * portaldot binary and no live node: the run pipeline itself is exercised
 * end-to-end through steps whose preconditions legitimately FAIL and are
 * skipped by policy, so the full 202 → background run → terminal record →
 * history → cancel flow is covered WITHOUT ever reaching the injector.
 * The live-portaldot execution coverage lives in
 * test/integration/scenario-runs.int.test.ts.
 *
 * Covered: execute request validation (mode marker + explicit target), gate
 * refusals as structured 4xx with a PERSISTED rejected run (audit), run
 * status endpoint, paginated + filterable history, per-step evidence over
 * the wire, cancellation (explicit + persisted + terminal), cancel of a
 * finished run (409), unknown run ids (404), and the hard guarantee that a
 * refused or skipped execution never invokes the injector.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createEngine,
  type KaizenEngine,
  type KaizenEventName,
  type NodeConfig,
  type ScenarioRunRecord,
} from '@kaizen/engine';
import { createServer } from '../src/server';

interface RunEnvelope {
  ok: boolean;
  run: ScenarioRunRecord;
}

interface RunListEnvelope {
  ok: boolean;
  runs: Array<{ id: string; state: string; scenarioId: string; networkId: string }>;
  malformed: unknown[];
  total: number;
  limit: number;
  offset: number;
}

function skipScenario(name: string): Record<string, unknown> {
  return {
    name,
    description: 'skip when the unreachable-target baseline fails',
    requires: { designatedTest: true, preset: 'two-node' },
    steps: [
      {
        id: 'pause-alice',
        operation: { type: 'pause', config: { node: 'alice' } },
        preconditions: [
          // tight budgets: these baselines conclusively FAIL here (no RPC
          // listener, no alive pid), so the drill finishes quickly
          { kind: 'rpc-reachable', node: 'alice', expect: true, timeoutMs: 500 },
          { kind: 'process-state', node: 'alice', expect: ['running'], timeoutMs: 500 },
          // never true, never even conclusive — recorded as the skip reason
          { kind: 'peers', node: 'alice', op: 'gte', value: 999, timeoutMs: 300 },
        ],
        postconditions: [{ kind: 'recovery-verified', node: 'alice' }],
      },
    ],
    execution: { onPreconditionFailed: 'skip-step' },
  };
}

function delayedScenario(name: string): Record<string, unknown> {
  return {
    name,
    description: 'waits in its pre-step delay so it can be cancelled',
    requires: { designatedTest: true, preset: 'two-node' },
    steps: [
      {
        id: 'pause-alice',
        operation: { type: 'pause', config: { node: 'alice' } },
        delayBeforeMs: 60_000,
        preconditions: [
          { kind: 'rpc-reachable', node: 'alice', expect: true, timeoutMs: 500 },
          { kind: 'process-state', node: 'alice', expect: ['running'], timeoutMs: 500 },
        ],
        postconditions: [{ kind: 'recovery-verified', node: 'alice' }],
      },
    ],
  };
}

describe('Scenario run API (real app + real SQLite)', () => {
  let engine: KaizenEngine;
  let app: FastifyInstance;
  let dir: string;
  const faultEvents: string[] = [];
  let skipId = '';
  let delayedId = '';

  async function createScenarioApi(payload: Record<string, unknown>): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/scenarios', payload });
    expect(res.statusCode).toBe(201);
    return (res.json() as { scenario: { id: string } }).scenario.id;
  }

  async function waitForTerminal(runId: string, timeoutMs = 30_000): Promise<ScenarioRunRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await app.inject({ method: 'GET', url: `/api/scenarios/runs/${runId}` });
      expect(res.statusCode).toBe(200);
      const run = (res.json() as RunEnvelope).run;
      if (['completed', 'completed-with-warnings', 'failed', 'cancelled', 'cleanup-failed'].includes(run.state)) {
        return run;
      }
      if (Date.now() > deadline) throw new Error(`run ${runId} not terminal: ${run.state}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-scrun-api-'));
    engine = createEngine({ dataDir: dir, binaryCacheDir: path.join(dir, 'bin') });
    engine.events.subscribe((name) => {
      if (name.startsWith('fault.')) faultEvents.push(name as KaizenEventName);
    });
    app = createServer(engine);
    await app.ready();

    // A designated-test target whose nodes are registered but NOT running:
    // baseline preconditions conclusively fail (no RPC listener, no alive
    // pid), which is exactly what the skip-policy drills need.
    const net = { id: 'api_net', name: 'api-runs', preset: 'two-node' as const, chain: 'local-spec' as const };
    engine.store.insertNetwork({
      ...net,
      status: 'created' as const,
      designatedTest: true,
      baseDir: path.join(dir, 'net'),
      createdAt: new Date().toISOString(),
    });
    engine.store.updateNetworkStatus(net.id, 'running');
    const insertNode = (id: string, label: string, port: number): void => {
      const config: NodeConfig = {
        id,
        networkId: net.id,
        name: `api-runs-${label}`,
        role: 'validator',
        chain: 'local-spec',
        wellKnownKey: label === 'alice' ? 'alice' : 'bob',
        bootnodes: [],
        baseDir: path.join(dir, label),
        nodeKeyFile: path.join(dir, `${label}.key`),
        logFile: path.join(dir, `${label}.log`),
        ports: { p2p: port + 1, rpc: port, ws: port + 2, prometheus: port + 3 },
        expectedPeers: 1,
      };
      engine.store.insertNode({
        config,
        status: 'running' as const,
        createdAt: new Date().toISOString(),
      });
    };
    insertNode('api_net-alice', 'alice', 59901);
    insertNode('api_net-bob', 'bob', 59911);

    // A NON-designated network for the DEC-008 gate refusal.
    engine.store.insertNetwork({
      id: 'prod_net',
      name: 'prod-like',
      preset: 'single-node' as const,
      status: 'running' as const,
      designatedTest: false,
      chain: 'local-spec' as const,
      baseDir: path.join(dir, 'prod'),
      createdAt: new Date().toISOString(),
    });
    const prodConfig: NodeConfig = {
      id: 'prod_net-alice',
      networkId: 'prod_net',
      name: 'prod-like-alice',
      role: 'validator',
      chain: 'local-spec',
      wellKnownKey: 'alice',
      bootnodes: [],
      baseDir: path.join(dir, 'prod', 'alice'),
      nodeKeyFile: path.join(dir, 'prod.key'),
      logFile: path.join(dir, 'prod.log'),
      ports: { p2p: 59931, rpc: 59930, ws: 59932, prometheus: 59933 },
      expectedPeers: 0,
    };
    engine.store.insertNode({
      config: prodConfig,
      status: 'running' as const,
      createdAt: new Date().toISOString(),
    });

    skipId = await createScenarioApi(skipScenario('api skip drill'));
    delayedId = await createScenarioApi(delayedScenario('api delayed drill'));
  });

  afterAll(async () => {
    await app.close();
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---- execute request validation -----------------------------------------

  it('refuses execution without the explicit mode marker or target (400)', async () => {
    for (const payload of [{}, { mode: 'execute' }, { networkIdOrName: net0() }]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/scenarios/${skipId}/execute`,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
    }
    expect(engine.scenarioRuns.list().total).toBe(0);
  });

  it('refuses execution of an unknown scenario (404, no run persisted)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scenarios/ghost-scenario/execute',
      payload: { mode: 'execute', networkIdOrName: 'api-runs' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('SCENARIO_NOT_FOUND');
    expect(engine.scenarioRuns.list().total).toBe(0);
    expect(faultEvents).toEqual([]);
  });

  // ---- gate refusals are persisted, structured, and execute nothing -------

  it('refuses a non-designated target (403) and persists the rejected run (DEC-008)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/scenarios/${skipId}/execute`,
      payload: { mode: 'execute', networkIdOrName: 'prod-like' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('SCENARIO_EXEC_NOT_ALLOWED');
    expect(body.error.message).toContain('designated test network');

    const runs = engine.scenarioRuns.list({ limit: 10 });
    expect(runs.total).toBe(1);
    const rejected = engine.scenarioRuns.get(runs.runs[0]!.id);
    expect(rejected.state).toBe('rejected');
    expect(rejected.error?.code).toBe('GATE_REFUSED');

    // nothing was executed — the refusal is an audit record, not a fault
    expect(faultEvents).toEqual([]);
    expect(engine.store.listFaults({ limit: 10 })).toEqual([]);
  });

  it('refuses an unknown target network (404) with a persisted rejection', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/scenarios/${skipId}/execute`,
      payload: { mode: 'execute', networkIdOrName: 'nowhere' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('NETWORK_NOT_FOUND');
    const runs = engine.scenarioRuns.list({ limit: 10 });
    expect(runs.runs.some((r) => r.state === 'rejected')).toBe(true);
    expect(faultEvents).toEqual([]);
  });

  // ---- the full execute → background run → terminal flow ------------------

  it('executes a scenario (202), persists per-step evidence, and completes without touching the injector when steps are skipped', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/scenarios/${skipId}/execute`,
      payload: { mode: 'execute', networkIdOrName: 'api-runs', requestedBy: 'api-test' },
    });
    expect(res.statusCode).toBe(202);
    const accepted = (res.json() as RunEnvelope).run;
    expect(accepted.id).toMatch(/^run-/);
    expect(['running', 'waiting']).toContain(accepted.state);
    expect(accepted.requestedBy).toBe('api-test');
    expect(accepted.snapshot.name).toBe('api skip drill');
    expect(accepted.validation?.valid).toBe(true);

    const run = await waitForTerminal(accepted.id);
    expect(run.state).toBe('completed-with-warnings');
    expect(run.steps).toHaveLength(1);
    const step = run.steps[0]!;
    expect(step.state).toBe('skipped');
    expect(step.policyApplied).toBe('onPreconditionFailed=skip-step');
    const peers = step.preconditions.find((p) => p.kind === 'peers');
    expect(peers?.verdict).not.toBe('satisfied'); // conclusive or inconclusive — never satisfied
    expect(peers?.detail).toBeTruthy();
    expect(step.faultId).toBeNull(); // skipped steps never reach the injector
    expect(run.warnings.some((w) => w.includes('skipped'))).toBe(true);
    expect(run.cleanup).toMatchObject({ verified: true, quarantined: false });

    // the hard guarantee: a skipped run never invoked any fault mechanism
    expect(faultEvents).toEqual([]);
    expect(engine.store.listFaults({ limit: 20 })).toEqual([]);
  }, 60_000);

  it('serves run status and paginated, filterable history', async () => {
    // one more run so pagination has substance
    const res = await app.inject({
      method: 'POST',
      url: `/api/scenarios/${skipId}/execute`,
      payload: { mode: 'execute', networkIdOrName: 'api-runs' },
    });
    expect(res.statusCode).toBe(202);
    await waitForTerminal((res.json() as RunEnvelope).run.id);

    const all = await app.inject({ method: 'GET', url: '/api/scenarios/runs?limit=50' });
    expect(all.statusCode).toBe(200);
    const list = all.json() as RunListEnvelope;
    expect(list.ok).toBe(true);
    expect(list.total).toBeGreaterThanOrEqual(3); // 1 rejected target + 2 skips
    expect(list.malformed).toEqual([]);
    expect(list.limit).toBe(50);
    expect(list.runs.every((r) => r.state !== 'running')).toBe(true);

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/scenarios/runs?scenarioId=${skipId}&state=completed-with-warnings&networkId=${engine.scenarioRuns.get(list.runs.find((r) => r.scenarioId === skipId)!.id).networkId}&limit=1&offset=0`,
    });
    expect(filtered.statusCode).toBe(200);
    const page = filtered.json() as RunListEnvelope;
    expect(page.total).toBe(2);
    expect(page.runs).toHaveLength(1);
    expect(page.offset).toBe(0);

    const badQuery = await app.inject({ method: 'GET', url: '/api/scenarios/runs?state=nonsense' });
    expect(badQuery.statusCode).toBe(400);
    expect((badQuery.json() as { error: { code: string } }).error.code).toBe('INVALID_INPUT');

    const unknown = await app.inject({ method: 'GET', url: '/api/scenarios/runs/run_nothing' });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe('SCENARIO_RUN_NOT_FOUND');
  });

  // ---- cancellation --------------------------------------------------------

  it('cancels a waiting run explicitly and persistently (200 → terminal cancelled)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/scenarios/${delayedId}/execute`,
      payload: { mode: 'execute', networkIdOrName: 'api-runs' },
    });
    expect(res.statusCode).toBe(202);
    const accepted = (res.json() as RunEnvelope).run;
    expect(accepted.state).toBe('waiting'); // inside its pre-step delay

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/scenarios/runs/${accepted.id}/cancel`,
      payload: { requestedBy: 'api-operator' },
    });
    expect(cancel.statusCode).toBe(200);
    const requested = (cancel.json() as RunEnvelope).run;
    expect(requested.state).toBe('cancel-requested');
    expect(requested.cancellation?.requestedBy).toBe('api-operator');

    const run = await waitForTerminal(accepted.id);
    expect(run.state).toBe('cancelled');
    expect(run.steps[0]!.state).toBe('cancelled');
    expect(run.steps[0]!.faultId).toBeNull(); // cancelled before any side effect
    expect(run.cleanup).toMatchObject({ verified: true, activeFaultsFound: 0 });
    expect(faultEvents).toEqual([]);
    expect(engine.store.listFaults({ limit: 20 })).toEqual([]);
  }, 60_000);

  it('refuses to cancel a finished run (409) and unknown runs (404)', async () => {
    const finished = engine.scenarioRuns
      .list({ state: 'completed-with-warnings', limit: 1 })
      .runs[0]!;
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/scenarios/runs/${finished.id}/cancel`,
      payload: {},
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe('SCENARIO_RUN_CONFLICT');

    const missing = await app.inject({
      method: 'POST',
      url: '/api/scenarios/runs/run_missing/cancel',
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: { code: string } }).error.code).toBe('SCENARIO_RUN_NOT_FOUND');
  });

  it('keeps the DEC-019 posture on run endpoints (structured errors, no stack leaks)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/scenarios/${skipId}/execute`,
      payload: 'not json at all',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain('at Object');
    expect(res.body).not.toContain('.ts:');
  });
});

/** Helper for the marker/target validation loop (unknown target is fine — the
 *  request is rejected before any lookup). */
function net0(): string {
  return 'api-runs';
}
