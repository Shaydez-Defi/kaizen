/**
 * LIVE test — T-1.5 PortaldotRpcClient against a real running node.
 * Verifies: WS connect via @polkadot/api, typed snapshot (spec 1002),
 * head subscription, close/reconnect semantics, structured errors.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildNodeArgs,
  KaizenError,
  NodeProcessManager,
  PortaldotRpcClient,
  PortAllocator,
  readSnapshot,
  wsUrlForPort,
  type ManagedNodeSpec,
} from '@kaizen/engine';
import { LIVE, ensureSharedBinary, testRoot, waitHealthy, waitFor } from './testkit';

describe.runIf(LIVE)('PortaldotRpcClient (live, real node)', () => {
  let mgr: NodeProcessManager;
  let nodePath: string;
  let dir: string;
  let ports: PortAllocator;
  let wsPort: number;
  let nodeSpec: ManagedNodeSpec;

  beforeAll(async () => {
    nodePath = await ensureSharedBinary();
    dir = testRoot('rpc');
    mgr = new NodeProcessManager();
    ports = new PortAllocator();
    const p = await ports.allocate();
    wsPort = p.ws;
    const baseDir = path.join(dir, 'n1');
    nodeSpec = {
      nodeId: 'n1',
      binaryPath: nodePath,
      args: buildNodeArgs({
        name: 'it-rpc',
        baseDir,
        ports: p,
        chain: 'dev',
        wellKnownKey: 'alice',
        nodeKeyFile: path.join(dir, 'n1.nodekey'),
      }),
      logFile: path.join(dir, 'n1.log'),
      baseDir,
    };
    await mgr.start(nodeSpec);
    await waitHealthy(p.rpc, 90_000);
  }, 180_000);

  afterAll(async () => {
    await mgr.killAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it(
    'reads a real typed snapshot: chain, health, sync, head, runtime (spec 1002)',
    async () => {
      const client = new PortaldotRpcClient(wsUrlForPort(wsPort));
      await client.connect();
      expect(client.isConnected).toBe(true);

      const snap = await client.getSnapshot();
      expect(snap.chain).toBe('Development');
      expect(snap.nodeName).toBe('Portaldot Node');
      expect(snap.nodeVersion).toMatch(/^2\.0\.0/); // system.version() real value
      expect(snap.runtime.specName).toBe('portaldot');
      expect(snap.runtime.specVersion).toBe(1002);
      expect(snap.health).toHaveProperty('isSyncing');
      expect(snap.head.number).toBeGreaterThanOrEqual(0);
      expect(snap.head.hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(snap.sync.currentBlock).toBeGreaterThanOrEqual(0);
      expect(snap.localPeerId).toMatch(/^1[2-9][A-Za-z0-9]+$/); // real libp2p peer id
      expect(snap.peers).toEqual([]); // single dev node: no peers
      // GRANDPA finality advances on the dev chain (Phase 0: Prometheus
      // finalized=2 on a solo dev node) — read via chain_getFinalizedHead.
      expect(snap.finalized).not.toBeNull();
      expect(snap.finalized?.number).toBeLessThanOrEqual(snap.head.number);
      expect(snap.finalized?.hash).toMatch(/^0x[0-9a-f]{64}$/);

      await client.close();
    },
    90_000,
  );

  it(
    'head subscription delivers advancing blocks; snapshot height advances',
    async () => {
      const client = new PortaldotRpcClient(wsUrlForPort(wsPort));
      await client.connect();

      const first = await client.getSnapshot();
      const heads: number[] = [];
      const unsub = await client.subscribeHeads((h) => heads.push(h.number));
      // The subscription pushes the CURRENT head immediately; wait for a head
      // strictly beyond the first snapshot (BABE slot ≈ 6 s on this chain).
      await waitFor(
        async () => (heads.some((n) => n > first.head.number) ? true : null),
        { timeoutMs: 90_000, intervalMs: 1_000, label: 'advancing head via subscription' },
      );
      await unsub();

      const second = await client.getSnapshot();
      expect(second.head.number).toBeGreaterThan(first.head.number); // chain advanced for real

      await client.close();
    },
    120_000,
  );

  it('connects to a dead port with a structured RPC_CONNECTION_FAILED error', async () => {
    const client = new PortaldotRpcClient('ws://127.0.0.1:39999', { connectTimeoutMs: 5_000 });
    await expect(client.connect()).rejects.toMatchObject({ code: 'RPC_CONNECTION_FAILED' });
    await client.close();
  });

  it('readSnapshot one-shot helper works against the live node', async () => {
    const snap = await readSnapshot(wsUrlForPort(wsPort));
    expect(snap.runtime.specName).toBe('portaldot');
  }, 60_000);

  it(
    'survives a node restart: WsProvider reconnects and reads resume on the same client',
    async () => {
      const client = new PortaldotRpcClient(wsUrlForPort(wsPort));
      await client.connect();
      expect((await client.getSnapshot()).runtime.specName).toBe('portaldot');

      // hard-stop the node; reads must fail with structured errors, not fabricate
      await mgr.stop('n1');
      const failure = await client.getSnapshot().then(
        () => null,
        (e: unknown) => e,
      );
      expect(failure).toBeInstanceOf(KaizenError);
      expect((failure as KaizenError).code).toMatch(/^RPC_/);

      // restart on the same ports/key; the SAME client should recover
      await mgr.start(nodeSpec);
      const snap = await waitFor(
        async () => {
          try {
            const s = await client.getSnapshot();
            return s.runtime.specName === 'portaldot' ? s : null;
          } catch {
            return null; // provider still reconnecting
          }
        },
        { timeoutMs: 90_000, intervalMs: 2_000, label: 'RPC reads resuming after restart' },
      );
      expect(snap.head.hash).toMatch(/^0x[0-9a-f]{64}$/);
      await client.close();
    },
    180_000,
  );
});
