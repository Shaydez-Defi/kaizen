/**
 * LIVE test — T-3.2 FailureInjector against REAL portaldot_dev networks.
 *
 * Uses only disposable, Kaizen-created networks (designatedTest — DEC-008).
 * Every live fault claim is backed by an INDEPENDENT observation from the
 * test itself (its own RPC polling), not just the injector's result object:
 *
 *  - pause:      victim RPC unreachable while the process stays alive, then
 *                reachable again with the SAME pid and a resumed chain
 *                (R-22 A envelope)
 *  - terminate:  process exits, engine restore brings a NEW pid, peers
 *                reconverge, chain resumes (R-22 D envelope)
 *  - blocked:    peer-disconnect/partition refuse explicitly against live
 *                targets (FAULT_NOT_SUPPORTED, no substitution)
 *  - escape:     faults cannot target nodes of other networks
 *  - audit:      every fault record ends terminal; none left cleanup-failed
 */

import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createEngine,
  isPidAlive,
  type KaizenEngine,
  type KaizenEventMap,
  type KaizenEventName,
} from '@kaizen/engine';
import { createServer } from '../../apps/api/src/server';
import {
  LIVE,
  SHARED_BIN_CACHE,
  ensureSharedBinary,
  httpRpc,
  testRoot,
  waitFor,
} from './testkit';

interface Health {
  isSyncing: boolean;
  peers: number;
  shouldHavePeers: boolean;
}

interface Header {
  number: string;
  hash: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function ping(port: number, timeoutMs = 800): Promise<boolean> {
  try {
    await httpRpc<Health>(port, 'system_health', [], timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function headNumber(port: number): Promise<number> {
  const h = await httpRpc<Header>(port, 'chain_getHeader');
  return Number.parseInt(h.number, 16);
}

describe.runIf(LIVE)('FailureInjector (live, real networks)', () => {
  let engine: KaizenEngine;
  let app: FastifyInstance;
  let dir: string;
  let networkId: string;
  let victimId: string;
  let victimPort: number;
  let observerPort: number;
  let victimPid: number;

  beforeAll(async () => {
    await ensureSharedBinary();
    dir = testRoot('faults');
    engine = createEngine({
      dataDir: dir,
      binaryCacheDir: SHARED_BIN_CACHE,
      healthTimeoutMs: 120_000,
    });
    app = createServer(engine);

    const net = await engine.networks.create({ name: 'faults-it', preset: 'two-node' });
    expect(net.designatedTest).toBe(true); // the DEC-008 gate basis
    networkId = net.id;
    const { nodes } = engine.networks.getNetwork(networkId);
    observerPort = nodes[0]!.ports.rpc;
    victimId = nodes[1]!.id;
    victimPort = nodes[1]!.ports.rpc;

    const start = await engine.networks.start(networkId);
    expect(start.ok, `start failed: ${JSON.stringify(start.error)}`).toBe(true);

    await waitFor(async () => (await httpRpc<Health>(victimPort, 'system_health')).peers >= 1, {
      timeoutMs: 90_000,
      label: 'victim peers >= 1',
    });
    victimPid = engine.store.getNode(victimId).pid!;
    expect(isPidAlive(victimPid)).toBe(true);
  }, 300_000);

  afterAll(async () => {
    try {
      for (const n of engine.networks.list()) {
        if (n.status === 'running' || n.status === 'starting') {
          await engine.networks.stop(n.id);
        }
      }
    } finally {
      await engine.processes.killAll();
      await engine.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'pause: dry-run first, then a verified fault with independent RPC observation of effect and recovery',
    async () => {
      // --- dry-run: the default surface, applies nothing
      const preview = await engine.faults.dryRun({
        networkIdOrName: networkId,
        nodeId: victimId,
        type: 'pause',
        options: { durationMs: 8_000 },
        requestedBy: 'it',
      });
      expect(preview.state).toBe('ready');
      expect(preview.preflight.target.designatedTest).toBe(true);
      expect(await ping(victimPort)).toBe(true); // still answering

      // --- execute with an INDEPENDENT observer (the test's own polling)
      const headBefore = await headNumber(victimPort);
      const samples: Array<{ at: number; reachable: boolean }> = [];
      let running = true;
      const watcher = (async () => {
        while (running) {
          samples.push({ at: Date.now(), reachable: await ping(victimPort) });
          await sleep(500);
        }
      })();

      const result = await engine.faults.execute({
        networkIdOrName: networkId,
        nodeId: victimId,
        type: 'pause',
        options: { durationMs: 8_000 },
        requestedBy: 'it',
      });
      running = false;
      await watcher;

      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('verified');
      expect(result.state).toBe('completed');
      expect(result.claims).toEqual({
        applied: true,
        effectObserved: true,
        faultRemoved: true,
        recovered: true,
        recoveryVerified: true,
      });
      expect(result.evidence.before?.rpcReachable).toBe(true);
      expect(result.evidence.effect?.observed).toBe(true);
      expect(result.evidence.recovery?.verified).toBe(true);

      // Independent proof: the test ITSELF saw the outage and the return.
      const unreachable = samples.filter((s) => !s.reachable);
      expect(unreachable.length, 'test never observed the pause effect').toBeGreaterThan(0);
      const outageMs = unreachable.at(-1)!.at - unreachable[0]!.at;
      expect(outageMs, `outage too short: ${outageMs}ms`).toBeGreaterThanOrEqual(5_000);
      expect(samples.at(-1)!.reachable, 'recovery not observed by the test').toBe(true);

      // Same process, chain resumes.
      expect(engine.store.getNode(victimId).pid).toBe(victimPid);
      expect(isPidAlive(victimPid)).toBe(true);
      await waitFor(async () => (await headNumber(victimPort)) > headBefore, {
        timeoutMs: 60_000,
        label: 'chain resumes after pause',
      });
    },
    180_000,
  );

  it(
    'terminate: verified exit + engine restore with a NEW pid, peers reconverge, chain resumes',
    async () => {
      const headBefore = await headNumber(victimPort);
      const oldPid = engine.store.getNode(victimId).pid!;

      const result = await engine.faults.execute({
        networkIdOrName: networkId,
        nodeId: victimId,
        type: 'terminate',
        requestedBy: 'it',
      });

      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('verified');
      expect(result.state).toBe('completed');
      expect(result.claims.effectObserved).toBe(true);
      expect(result.claims.recoveryVerified).toBe(true);
      expect(result.evidence.effect?.observation.rpcReachable).toBe(false);
      expect(result.evidence.recovery?.observation.rpcReachable).toBe(true);

      // Independent proof: old process dead, new pid serving real RPC.
      expect(isPidAlive(oldPid)).toBe(false);
      const newPid = engine.store.getNode(victimId).pid!;
      expect(newPid).not.toBe(oldPid);
      expect(result.evidence.recovery?.newPid).toBe(newPid);
      expect(await ping(victimPort)).toBe(true);

      // Mesh reconverges with the unaffected observer node (R-22 D).
      await waitFor(
        async () =>
          (await httpRpc<Health>(victimPort, 'system_health')).peers >= 1 &&
          (await httpRpc<Health>(observerPort, 'system_health')).peers >= 1,
        { timeoutMs: 90_000, label: 'peers reconverge after restart' },
      );
      await waitFor(async () => (await headNumber(victimPort)) > headBefore, {
        timeoutMs: 90_000,
        label: 'chain resumes after restart',
      });
    },
    240_000,
  );

  it(
    'REST surface: dry-run default, explicit execute marker, status queries, blocked-mechanism refusals',
    async () => {
      const faultUrl = `/api/networks/${networkId}/faults`;

      // Dry-run (default surface) → 200 ready.
      const dry = await app.inject({
        method: 'POST',
        url: `${faultUrl}/dry-run`,
        payload: { nodeId: victimId, type: 'pause', options: { durationMs: 3_000 } },
      });
      expect(dry.statusCode).toBe(200);
      const dryBody = dry.json() as { ok: boolean; preview: { state: string; faultId: string } };
      expect(dryBody.ok).toBe(true);
      expect(dryBody.preview.state).toBe('ready');

      // Execute WITHOUT the explicit marker → 400 (dry-run stays the default).
      const noMode = await app.inject({
        method: 'POST',
        url: `${faultUrl}/execute`,
        payload: { nodeId: victimId, type: 'pause' },
      });
      expect(noMode.statusCode).toBe(400);
      expect((noMode.json() as { error: { message: string } }).error.message).toContain('execute');

      // Execute WITH the marker → real fault, typed events emitted.
      const eventNames: KaizenEventName[] = [];
      const seenStates: string[] = [];
      const sub = engine.events.subscribe((name: KaizenEventName, payload) => {
        eventNames.push(name);
        if (name === 'fault.state') {
          seenStates.push((payload as KaizenEventMap['fault.state']).to);
        }
      });
      const exec = await app.inject({
        method: 'POST',
        url: `${faultUrl}/execute`,
        payload: { nodeId: victimId, type: 'pause', options: { durationMs: 3_000 }, mode: 'execute' },
      });
      sub();
      expect(exec.statusCode).toBe(200);
      const execBody = exec.json() as { ok: boolean; result: { state: string; outcome: string } };
      expect(execBody.ok).toBe(true);
      expect(execBody.result.state).toBe('completed');
      expect(execBody.result.outcome).toBe('verified');
      expect(eventNames).toContain('fault.state');
      expect(seenStates).toContain('cleaning-up');

      // Status queries + audit trail.
      const list = await app.inject({ method: 'GET', url: faultUrl });
      expect(list.statusCode).toBe(200);
      const faults = (list.json() as { faults: Array<{ id: string; state: string }> }).faults;
      expect(faults.length).toBeGreaterThanOrEqual(3); // pause + terminate + REST pause
      const one = await app.inject({ method: 'GET', url: `/api/faults/${dryBody.preview.faultId}` });
      expect(one.statusCode).toBe(200);
      expect((one.json() as { fault: { mode: string } }).fault.mode).toBe('dry-run');

      // Terminal records refuse further actions; unknown ids 404.
      const restPause = faults.find((f) => f.state === 'completed')!;
      const cancel = await app.inject({ method: 'POST', url: `/api/faults/${restPause.id}/cancel` });
      expect(cancel.statusCode).toBe(409);
      const missing = await app.inject({ method: 'GET', url: '/api/faults/flt-nope' });
      expect(missing.statusCode).toBe(404);

      // Blocked mechanisms refuse explicitly against LIVE targets too.
      for (const type of ['peer-disconnect', 'partition'] as const) {
        const res = await app.inject({
          method: 'POST',
          url: `${faultUrl}/execute`,
          payload: { nodeId: victimId, type, mode: 'execute' },
        });
        expect(res.statusCode).toBe(409);
        expect((res.json() as { error: { code: string } }).error.code).toBe('FAULT_NOT_SUPPORTED');
      }
      expect(await ping(victimPort)).toBe(true); // victim unaffected by refusals
    },
    120_000,
  );

  it(
    'refuses faults that would escape the designated network (cross-network, unknown node)',
    async () => {
      // A node that belongs to ANOTHER network cannot be targeted through this one.
      const other = await engine.networks.create({ name: 'faults-it-other', preset: 'single-node' });
      const otherNodeId = engine.networks.getNetwork(other.id).nodes[0]!.id;
      await expect(
        engine.faults.execute({
          networkIdOrName: networkId,
          nodeId: otherNodeId,
          type: 'pause',
        }),
      ).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
      // The other network's node was never touched (it was not even started).
      expect(engine.store.getNode(otherNodeId).status).toBe('created');
      await engine.networks.remove(other.id);
    },
    120_000,
  );

  it(
    'audit hygiene: every recorded fault is terminal; none left unresolved cleanup-failed',
    async () => {
      const all = engine.faults.list({ limit: 100 });
      expect(all.length).toBeGreaterThanOrEqual(5); // dry-runs, refusals, executions
      const terminal = new Set(['completed', 'cancelled', 'rejected', 'failed']);
      for (const f of all) {
        if (f.mode === 'dry-run') {
          // A preview record legitimately rests at 'ready' (never executed).
          expect(['ready', 'rejected'], `dry-run ${f.id} in ${f.state}`).toContain(f.state);
        } else {
          expect(terminal.has(f.state), `fault ${f.id} stuck in ${f.state}`).toBe(true);
        }
      }
      expect(all.filter((f) => f.state === 'cleanup-failed')).toHaveLength(0);
      // Node keys were never started for this victim; the store holds paths only.
      const node = engine.store.getNode(victimId);
      expect(fs.existsSync(node.nodeKeyFile)).toBe(true); // key material lives in a file, never in records
      expect(JSON.stringify(all)).not.toMatch(/BEGIN.*PRIVATE KEY/);
    },
    60_000,
  );
});
