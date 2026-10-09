/**
 * LIVE test — T-1.6 NetworkService against real Portaldot nodes.
 * single-node: create → start (health-gated) → inspect (real RPC) → stop.
 * two-node:    create → start → BOTH nodes peered (peers>=1) with MATCHING
 *              chain progress (same best hash) → stop. This is the bar set by
 *              the Phase 1 brief before multi-node may be called verified.
 */

import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine, isPidAlive, type KaizenEngine } from '@kaizen/engine';
import { LIVE, SHARED_BIN_CACHE, ensureSharedBinary, testRoot, waitFor } from './testkit';

describe.runIf(LIVE)('NetworkService (live, real networks)', () => {
  let engine: KaizenEngine;
  let dir: string;

  beforeAll(async () => {
    await ensureSharedBinary();
    dir = testRoot('net');
    engine = createEngine({
      dataDir: dir,
      binaryCacheDir: SHARED_BIN_CACHE,
      healthTimeoutMs: 120_000,
    });
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
    'single-node: create → start → real RPC inspection → stop, full cleanup',
    async () => {
      const net = await engine.networks.create({ name: 'it-single', preset: 'single-node' });
      expect(net.status).toBe('created');
      expect(net.designatedTest).toBe(true); // DEC-008 gate basis
      const { nodes } = engine.networks.getNetwork(net.id);
      expect(nodes).toHaveLength(1);
      // creation records config in the store (ports, key file paths, no secrets)
      expect(nodes[0]?.ports.p2p).toBeGreaterThan(0);
      expect(fs.existsSync(nodes[0]?.nodeKeyFile ?? '')).toBe(true); // stable peer id pre-generated

      const start = await engine.networks.start(net.id);
      expect(start.ok, `start failed: ${JSON.stringify(start.error)}`).toBe(true);

      const inspection = await engine.networks.inspect(net.id);
      expect(inspection.nodes).toHaveLength(1);
      const node = inspection.nodes[0];
      expect(node?.process.state).toBe('running');
      expect(node?.snapshot, `rpc error: ${node?.rpcError}`).not.toBeNull();
      expect(node?.snapshot?.chain).toBe('Development');
      expect(node?.snapshot?.runtime.specName).toBe('portaldot');
      expect(node?.snapshot?.runtime.specVersion).toBe(1002);

      // block production is real: height advances
      const h1 = node?.snapshot?.head.number ?? 0;
      await new Promise((r) => setTimeout(r, 15_000));
      const inspection2 = await engine.networks.inspect(net.id);
      const h2 = inspection2.nodes[0]?.snapshot?.head.number ?? 0;
      expect(h2).toBeGreaterThan(h1);

      const stop = await engine.networks.stop(net.id);
      expect(stop.ok).toBe(true);
      const after = engine.networks.getNetwork(net.id);
      expect(after.network.status).toBe('stopped');
      for (const n of after.nodes) {
        expect(engine.processes.isRunning(n.id)).toBe(false);
        expect(isPidAlive(n.pid ?? 0)).toBe(false);
      }

      // operation history persisted
      const history = engine.store.listOperations({ networkId: net.id });
      expect(history.map((o) => o.kind)).toEqual(
        expect.arrayContaining(['network.create', 'network.start', 'network.stop']),
      );
      expect(history.every((o) => o.status === 'ok')).toBe(true);

      await engine.networks.remove(net.id);
      expect(engine.networks.list().find((n) => n.id === net.id)).toBeUndefined();
    },
    300_000,
  );

  it(
    'two-node: both nodes peer with each other and share chain progress',
    async () => {
      const net = await engine.networks.create({ name: 'it-two', preset: 'two-node' });
      const { nodes } = engine.networks.getNetwork(net.id);
      expect(nodes).toHaveLength(2);
      expect(nodes[0]?.chainSpecPath && fs.existsSync(nodes[0].chainSpecPath)).toBe(true);
      // bob is statically wired to alice's pre-generated node key
      expect(nodes[1]?.bootnodes[0]).toMatch(/^\/ip4\/127\.0\.0\.1\/tcp\/\d+\/p2p\/1/);

      const start = await engine.networks.start(net.id);
      expect(start.ok, `start failed: ${JSON.stringify(start.error)}`).toBe(true);

      // The verification bar: both nodes reachable, each sees ≥1 peer, both
      // report the SAME best hash (matching chain progress), finality is
      // progressing on both (R-04: finalized #5 on both in Phase 0), and
      // snapshots are complete (peer ids present — retried until the sync
      // storm settles).
      const converged = await waitFor(
        async () => {
          const ins = await engine.networks.inspect(net.id);
          const [a, b] = ins.nodes;
          if (!a?.snapshot || !b?.snapshot) return null;
          if ((a.snapshot.health.peers ?? 0) < 1 || (b.snapshot.health.peers ?? 0) < 1) return null;
          if (a.snapshot.head.hash !== b.snapshot.head.hash) return null;
          if (a.snapshot.head.number < 1) return null;
          if (!a.snapshot.localPeerId || !b.snapshot.localPeerId) return null;
          if (!a.snapshot.peers?.length || !b.snapshot.peers?.length) return null;
          const fa = a.snapshot.finalized;
          const fb = b.snapshot.finalized;
          if (!fa || !fb || fa.number < 1) return null;
          if (fa.number !== fb.number) return null;
          return ins;
        },
        { timeoutMs: 120_000, intervalMs: 3_000, label: 'two-node convergence' },
      );

      const [a, b] = converged.nodes;
      expect(a?.snapshot?.health.peers).toBeGreaterThanOrEqual(1);
      expect(b?.snapshot?.health.peers).toBeGreaterThanOrEqual(1);
      expect(a?.snapshot?.head.hash).toBe(b?.snapshot?.head.hash);
      // cross-check: each node's observed peer IS the other node (bidirectional)
      expect(a?.snapshot?.peers?.[0]?.peerId).toBe(b?.snapshot?.localPeerId);
      expect(b?.snapshot?.peers?.[0]?.peerId).toBe(a?.snapshot?.localPeerId);
      expect(a?.snapshot?.peers?.[0]?.roles).toContain('AUTHORITY');
      expect(b?.snapshot?.peers?.[0]?.roles).toContain('AUTHORITY');
      // finality progresses on both nodes (AC: "peers and finalizes")
      expect(a?.snapshot?.finalized?.number).toBeGreaterThanOrEqual(1);
      expect(a?.snapshot?.finalized?.number).toBe(b?.snapshot?.finalized?.number);

      const stop = await engine.networks.stop(net.id);
      expect(stop.ok).toBe(true);
      for (const n of engine.networks.getNetwork(net.id).nodes) {
        expect(engine.processes.isRunning(n.id)).toBe(false);
      }

      await engine.networks.remove(net.id);
    },
    420_000,
  );
});
