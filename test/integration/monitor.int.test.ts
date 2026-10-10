/**
 * LIVE test — T-2.4 MonitoringService against real nodes and real RPC.
 *
 * Verifies: auto-attach on network start, real-RPC samples (head/finalized/
 * peers/genesis), health reaching 'healthy' with evidence, crash detection
 * ('unhealthy' with reason), and monitoring cleanup when networks stop.
 */

import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEngine,
  isPidAlive,
  type KaizenEngine,
  type KaizenEventMap,
  type KaizenEventName,
} from '@kaizen/engine';
import { LIVE, SHARED_BIN_CACHE, ensureSharedBinary, testRoot, waitFor } from './testkit';

describe.runIf(LIVE)('Monitoring (live, real RPC)', () => {
  let engine: KaizenEngine;
  let dir: string;
  const events: Array<{ name: KaizenEventName; payload: unknown }> = [];

  beforeAll(async () => {
    await ensureSharedBinary();
    dir = testRoot('mon');
    engine = createEngine({
      dataDir: dir,
      binaryCacheDir: SHARED_BIN_CACHE,
      healthTimeoutMs: 120_000,
      monitorIntervalMs: 2_000,
    });
    engine.events.subscribe((name, payload) => events.push({ name, payload }));
  }, 300_000);

  afterAll(async () => {
    try {
      for (const n of engine.networks.list()) {
        if (n.status === 'running' || n.status === 'starting') {
          await engine.networks.stop(n.id).catch(() => undefined);
        }
      }
    } finally {
      await engine.processes.killAll();
      await engine.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'monitors a two-node network with real data, detects an external crash, cleans up on stop',
    async () => {
      const net = await engine.networks.create({ name: 'it-mon', preset: 'two-node' });
      const { nodes } = engine.networks.getNetwork(net.id);

      const start = await engine.networks.start(net.id);
      expect(start.ok, `start failed: ${JSON.stringify(start.error)}`).toBe(true);

      // Auto-attach: the 'running' status event started a polling job.
      await waitFor(async () => (engine.monitoring.isRunning(net.id) ? true : null), {
        timeoutMs: 15_000,
        label: 'monitoring auto-start',
      });

      // Real samples arrive with real chain data.
      const sampleEvent = await waitFor<KaizenEventMap['monitor.sample']>(
        async () =>
          (events
            .filter((e) => e.name === 'monitor.sample')
            .map((e) => e.payload as KaizenEventMap['monitor.sample'])
            .find(
              (p) =>
                p.networkId === net.id &&
                p.snapshot.samples.every((s) => s.rpc.reachable && s.head !== null),
            ) ?? null),
        { timeoutMs: 120_000, label: 'monitor.sample with reachable nodes' },
      );
      expect(sampleEvent.snapshot.samples).toHaveLength(2);
      for (const s of sampleEvent.snapshot.samples) {
        expect(s.head?.number).toBeGreaterThanOrEqual(0);
        expect(s.genesisHash).toMatch(/^0x/);
        expect(s.peers?.expected).toBe(1); // two-node: each expects the other
        expect(s.uptimeMs).toBeGreaterThan(0);
      }
      // Real connectivity observed over RPC: each node reports its peer.
      // (monitor.peers only fires on a COUNT CHANGE — a steady network has
      // none — so connectivity is asserted from sample data here, and the
      // 1→0 transition is asserted after the crash below.)
      await waitFor(
        async () => {
          const snap = engine.monitoring.getLatest(net.id);
          const counts = snap?.samples.map((s) => s.peers?.count ?? 0) ?? [];
          return counts.length === 2 && counts.every((c) => c >= 1) ? true : null;
        },
        { timeoutMs: 120_000, label: 'both nodes observe their peer over RPC' },
      );

      // Health reaches 'healthy' with evidence-based reasons.
      await waitFor(
        async () =>
          (engine.monitoring.getLatest(net.id)?.health.every((h) => h.state === 'healthy') ?? false)
            ? true
            : null,
        { timeoutMs: 180_000, label: 'all nodes healthy' },
      );

      // External crash: SIGKILL one node behind the engine's back.
      // (Re-read: the records captured before start() are stale — start
      // assigns pids in the store, not on already-returned objects.)
      const victim = engine.networks.getNetwork(net.id).nodes[1]!;
      expect(victim.pid).toBeGreaterThan(0);
      process.kill(victim.pid, 'SIGKILL');
      await waitFor(async () => (isPidAlive(victim.pid ?? 0) ? null : true), {
        timeoutMs: 30_000,
        label: 'victim death',
      });

      const healthEvent = await waitFor<KaizenEventMap['monitor.health']>(
        async () =>
          (events
            .filter((e) => e.name === 'monitor.health')
            .map((e) => e.payload as KaizenEventMap['monitor.health'])
            .find((p) => p.nodeId === victim.id && p.to === 'unhealthy') ?? null),
        { timeoutMs: 120_000, label: 'monitor.health unhealthy after crash' },
      );
      expect(healthEvent.reasons.join(' ')).toMatch(/crashed|not running/);
      expect(healthEvent.networkId).toBe(net.id);

      // Real peer-count transition: the survivor loses its only peer (1→0)
      // once the killed node's connection drops — observed over RPC.
      await waitFor<KaizenEventMap['monitor.peers']>(
        async () =>
          (events
            .filter((e) => e.name === 'monitor.peers')
            .map((e) => e.payload as KaizenEventMap['monitor.peers'])
            .find((p) => p.networkId === net.id && p.nodeId === nodes[0]!.id && p.to === 0) ??
          null),
        { timeoutMs: 120_000, label: 'monitor.peers drop after crash' },
      );

      // The surviving node keeps being monitored (per-node failure isolation).
      await waitFor(
        async () =>
          (engine.monitoring
            .getLatest(net.id)
            ?.health.find((h) => h.nodeId === nodes[0]!.id)?.state === 'healthy'
            ? true
            : null),
        { timeoutMs: 120_000, label: 'survivor still healthy' },
      );

      // Cleanup: stopping the network stops the polling job.
      const stop = await engine.networks.stop(net.id);
      expect(stop.ok).toBe(true);
      expect(engine.monitoring.isRunning(net.id)).toBe(false);
      expect(engine.monitoring.getLatest(net.id)).toBeNull();

      // snapshotNow works on demand even with no job (honest unavailable data).
      const onDemand = await engine.monitoring.snapshotNow(net.id);
      expect(onDemand.samples).toHaveLength(2);
      for (const s of onDemand.samples) {
        expect(s.rpc.reachable).toBe(false); // nothing is running
        expect(s.process.status).toBe('stopped');
      }
      for (const h of onDemand.health) {
        expect(h.state).toBe('unhealthy'); // process not running = unhealthy, not "healthy"
      }

      await engine.networks.remove(net.id);
    },
    600_000,
  );
});
