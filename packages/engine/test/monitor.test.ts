/**
 * Monitoring unit tests (T-2.4): health state interpretation, the HTTP
 * sampler against a real local stub RPC server, and the polling service
 * (overlap prevention, event payloads, cleanup on network stop).
 */

import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createHttpSampler,
  evaluateNodeHealth,
  EventBus,
  MonitoringService,
  NodeProcessManager,
  StateStore,
  type HealthEvalOptions,
  type KaizenEventMap,
  type KaizenEventName,
  type NetworkRecord,
  type NodeConfig,
  type NodeHealthReport,
  type NodeMonitorSample,
  type NodeRecord,
  type NodeSampler,
  type RpcNodeObservation,
} from '@kaizen/engine';

const FAST: Partial<HealthEvalOptions> = {
  stallThresholdMs: 1_000,
  staleAfterFailuresMs: 1_000,
  unavailableAfterFailures: 3,
  peerGraceMs: 1_000,
};

const T0 = Date.parse('2026-10-10T12:00:00.000Z');

function sample(overrides: Partial<NodeMonitorSample> = {}): NodeMonitorSample {
  return {
    networkId: 'net_1',
    nodeId: 'net_1-a',
    name: 'alpha-alice',
    at: new Date(T0).toISOString(),
    process: { status: 'running', pid: 1234, startedAt: new Date(T0 - 60_000).toISOString() },
    rpc: { reachable: true },
    health: { isSyncing: false, peers: 3, shouldHavePeers: true },
    peers: { count: 3, expected: 3, list: [] },
    head: { number: 10, hash: '0xabc' },
    finalized: { number: 8, hash: '0xdef' },
    genesisHash: '0x00',
    sync: { startingBlock: 0, currentBlock: 10, highestBlock: 10 },
    uptimeMs: 60_000,
    warnings: [],
    ...overrides,
  };
}

function evalInput(overrides: Partial<Parameters<typeof evaluateNodeHealth>[0]> = {}) {
  return {
    nodeId: 'net_1-a',
    prev: undefined,
    prevHeadNumber: undefined,
    lastHeadAdvanceAt: undefined,
    sample: sample(),
    processAlive: true,
    now: T0,
    options: FAST,
    ...overrides,
  };
}

describe('evaluateNodeHealth', () => {
  it('is unknown before any sample (process still alive)', () => {
    const out = evaluateNodeHealth(evalInput({ sample: null }));
    expect(out.report.state).toBe('unknown');
    expect(out.report.lastSampleAt).toBeNull();
  });

  it('a never-started node is unhealthy (not unavailable) even with unreachable RPC', () => {
    // Process evidence takes precedence: nothing is running, so RPC failures
    // must not relabel it as 'unavailable' (process claims to run).
    const out = evaluateNodeHealth(
      evalInput({
        processAlive: false,
        sample: sample({
          rpc: { reachable: false, error: 'ECONNREFUSED' },
          health: null,
          peers: null,
          process: { status: 'created' },
        }),
      }),
    );
    expect(out.report.state).toBe('unhealthy');
    expect(out.report.reasons[0]).toMatch(/not running \(status: created\)/);
  });

  it('is healthy with fresh RPC, advancing head, and expected peers', () => {
    const out = evaluateNodeHealth(evalInput({ lastHeadAdvanceAt: T0 }));
    expect(out.report.state).toBe('healthy');
    expect(out.report.lastHealthyAt).toBe(sample().at);
    expect(out.report.reasons.join(' ')).toMatch(/peers 3\/3/);
    expect(out.report.reasons.join(' ')).toMatch(/head #10, finalized #8/);
  });

  it('process death is unhealthy regardless of a stale good sample', () => {
    const out = evaluateNodeHealth(
      evalInput({ processAlive: false, sample: sample({ process: { status: 'crashed' } }) }),
    );
    expect(out.report.state).toBe('unhealthy');
    expect(out.report.reasons[0]).toMatch(/crashed/);
  });

  it('tolerates <3 RPC failures, then reports unavailable', () => {
    const down = sample({ rpc: { reachable: false, error: 'ECONNREFUSED' }, health: null, peers: null });
    const prev: NodeHealthReport = {
      nodeId: 'net_1-a',
      state: 'healthy',
      reasons: [],
      since: new Date(T0 - 5_000).toISOString(),
      lastSampleAt: new Date(T0 - 5_000).toISOString(),
      lastHealthyAt: new Date(T0 - 5_000).toISOString(),
      rpcFailures: 0,
    };
    const first = evaluateNodeHealth(evalInput({ prev, sample: down, now: T0 }));
    expect(first.report.state).toBe('healthy'); // judged on last good data
    expect(first.report.rpcFailures).toBe(1);

    const third = evaluateNodeHealth(
      evalInput({ prev: { ...prev, rpcFailures: 2 }, sample: down, now: T0 }),
    );
    expect(third.report.state).toBe('unavailable');
    expect(third.report.reasons[0]).toMatch(/3 consecutive checks: ECONNREFUSED/);
  });

  it('detects a stalled chain (RPC answers, head frozen)', () => {
    const out = evaluateNodeHealth(
      evalInput({
        prev: undefined,
        prevHeadNumber: 10,
        lastHeadAdvanceAt: T0 - 5_000, // frozen for 5s > 1s threshold
        now: T0,
      }),
    );
    expect(out.report.state).toBe('unhealthy');
    expect(out.report.reasons[0]).toMatch(/stalled: best block #10 unchanged/);
  });

  it('a new head resets the stall clock', () => {
    const out = evaluateNodeHealth(
      evalInput({
        prevHeadNumber: 9,
        lastHeadAdvanceAt: T0 - 5_000,
        sample: sample({ head: { number: 10, hash: '0xabc' } }),
        now: T0,
      }),
    );
    expect(out.report.state).toBe('healthy');
    expect(out.lastHeadAdvanceAt).toBe(T0);
  });

  it('peer shortfall is healthy within grace, unhealthy beyond it', () => {
    const short = sample({ peers: { count: 1, expected: 3, list: [] } });
    const within = evaluateNodeHealth(
      evalInput({ sample: short, now: T0, lastHeadAdvanceAt: T0 }), // started 60s ago > grace 1s
    );
    expect(within.report.state).toBe('unhealthy');
    expect(within.report.reasons[0]).toMatch(/peer shortfall: 1\/3/);

    const freshStart = sample({
      peers: { count: 1, expected: 3, list: [] },
      process: { status: 'running', startedAt: new Date(T0 - 200).toISOString() },
    });
    const during = evaluateNodeHealth(
      evalInput({ sample: freshStart, now: T0, lastHeadAdvanceAt: T0 }),
    );
    expect(during.report.state).toBe('healthy');
    expect(during.report.reasons[0]).toMatch(/within .* startup grace/);
  });

  it('large gaps between successful samples are stale, not healthy', () => {
    const prev: NodeHealthReport = {
      nodeId: 'net_1-a',
      state: 'healthy',
      reasons: [],
      since: new Date(T0 - 30_000).toISOString(),
      lastSampleAt: new Date(T0 - 30_000).toISOString(),
      lastHealthyAt: new Date(T0 - 30_000).toISOString(),
      rpcFailures: 0,
    };
    const out = evaluateNodeHealth(evalInput({ prev, now: T0, lastHeadAdvanceAt: T0 }));
    expect(out.report.state).toBe('stale');
    expect(out.report.reasons[0]).toMatch(/stale: last successful sample 30s ago/);
  });

  it('keeps `since` across same-state runs and resets it on transitions', () => {
    const since = new Date(T0 - 9_000).toISOString();
    const prev: NodeHealthReport = {
      nodeId: 'net_1-a',
      state: 'healthy',
      reasons: [],
      since,
      lastSampleAt: new Date(T0 - 500).toISOString(),
      lastHealthyAt: since,
      rpcFailures: 0,
    };
    const same = evaluateNodeHealth(evalInput({ prev, now: T0, lastHeadAdvanceAt: T0 }));
    expect(same.report.since).toBe(since);

    const crashed = evaluateNodeHealth(
      evalInput({ prev, processAlive: false, sample: sample({ process: { status: 'stopped' } }), now: T0 }),
    );
    expect(crashed.report.since).toBe(new Date(T0).toISOString());
  });
});

// ---------------------------------------------------------------------------
// HTTP sampler against a real stub JSON-RPC server

async function stubRpcServer(
  handlers: Record<string, (params: unknown[]) => unknown>,
): Promise<{ url: string; close: () => Promise<void>; hits: Map<string, number> }> {
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { method, id } = JSON.parse(body) as { method: string; id: number };
      hits.set(method, (hits.get(method) ?? 0) + 1);
      const handler = handlers[method];
      res.setHeader('Content-Type', 'application/json');
      if (!handler) {
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: handler([]) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    hits,
  };
}

const HEIGHT = { value: 0 };
function baseHandlers() {
  return {
    system_health: () => ({ isSyncing: false, peers: 2, shouldHavePeers: true }),
    chain_getHeader: () => ({
      number: '0x' + HEIGHT.value.toString(16),
      hash: '0xheadhash',
      parentHash: '0xparent',
    }),
    system_peers: () => [
      { peerId: '12D3KooWpeer1', bestHash: '0xaaa', bestNumber: '0x9', roles: 'FULL' },
      { peerId: '12D3KooWpeer2', bestHash: '0xbbb', bestNumber: '0xa', roles: 'FULL' },
    ],
    system_syncState: () => ({ startingBlock: '0x0', currentBlock: '0xa', highestBlock: '0xb' }),
    chain_getFinalizedHead: () => '0xfinalizedhash',
    chain_getBlockHash: () => '0xgenesis',
  };
}

function nodeRecord(ports: { rpc: number }): NodeRecord {
  const config: NodeConfig = {
    id: 'net_1-a',
    networkId: 'net_1',
    name: 'alpha-alice',
    role: 'validator',
    chain: 'local-spec',
    wellKnownKey: 'alice',
    bootnodes: [],
    baseDir: '/tmp/none',
    nodeKeyFile: '/tmp/none.key',
    logFile: '/tmp/none.log',
    ports: { p2p: 1, rpc: ports.rpc, ws: 2, prometheus: 3 },
    expectedPeers: 3,
  };
  return { ...config, status: 'running' as const, pid: undefined, startedAt: undefined };
}

describe('createHttpSampler', () => {
  it('collects real RPC values (hex quantities decoded, peer details parsed)', async () => {
    HEIGHT.value = 26; // 0x1a
    const server = await stubRpcServer(baseHandlers());
    try {
      const sampler = createHttpSampler();
      const obs: RpcNodeObservation = await sampler(nodeRecord({ rpc: Number(server.url.split(':')[2]) }));
      expect(obs.rpc.reachable).toBe(true);
      expect(obs.health).toEqual({ isSyncing: false, peers: 2, shouldHavePeers: true });
      expect(obs.head).toEqual({ number: 26, hash: '0xheadhash' });
      expect(obs.peers?.count).toBe(2);
      expect(obs.peers?.list[0]).toEqual({ peerId: '12D3KooWpeer1', bestHash: '0xaaa', bestNumber: 9, roles: 'FULL' });
      expect(obs.finalized).toEqual({ number: 26, hash: '0xfinalizedhash' });
      expect(obs.sync).toEqual({ startingBlock: 0, currentBlock: 10, highestBlock: 11 });
      expect(obs.genesisHash).toBe('0xgenesis');
      expect(obs.warnings).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('reports transport failure as unreachable — never fabricated values', async () => {
    const sampler = createHttpSampler({ requestTimeoutMs: 500 });
    // Port 1: nothing listens there.
    const obs = await sampler(nodeRecord({ rpc: 1 }));
    expect(obs.rpc.reachable).toBe(false);
    expect(obs.rpc.error).toBeTruthy();
    expect(obs.health).toBeNull();
    expect(obs.peers).toBeNull();
    expect(obs.head).toBeNull();
  });

  it('keeps sampling when one method is disabled (warning, no fabrication)', async () => {
    const handlers = baseHandlers();
    delete (handlers as Record<string, unknown>)['system_peers'];
    const server = await stubRpcServer(handlers);
    try {
      const sampler = createHttpSampler();
      const obs = await sampler(nodeRecord({ rpc: Number(server.url.split(':')[2]) }));
      expect(obs.rpc.reachable).toBe(true);
      expect(obs.peers).toBeNull();
      expect(obs.warnings.join(' ')).toMatch(/system_peers failed: .*Method not found/);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// MonitoringService with an injected sampler

function insertNetworkAndNode(store: StateStore, id = 'net_1'): void {
  const network: Omit<NetworkRecord, 'updatedAt'> = {
    id,
    name: 'alpha',
    preset: 'four-validator',
    status: 'running',
    designatedTest: true,
    chain: 'local-spec',
    baseDir: `/tmp/monitor-test/${id}`,
    createdAt: new Date().toISOString(),
  };
  store.insertNetwork({ ...network, status: 'created' });
  store.updateNetworkStatus(id, 'running');
  const config: NodeConfig = {
    id: `${id}-a`,
    networkId: id,
    name: 'alpha-alice',
    role: 'validator',
    chain: 'local-spec',
    wellKnownKey: 'alice',
    bootnodes: [],
    baseDir: `/tmp/monitor-test/${id}/node-a`,
    nodeKeyFile: `/tmp/monitor-test/${id}/a.key`,
    logFile: `/tmp/monitor-test/${id}/a.log`,
    ports: { p2p: 31101, rpc: 32101, ws: 33101, prometheus: 34101 },
    expectedPeers: 3,
  };
  store.insertNode({
    config,
    status: 'running',
    createdAt: new Date().toISOString(),
  });
  // process.pid is the (alive) vitest worker — stands in for a running node.
  store.updateNodeStatus(
    `${id}-a`,
    'running',
    process.pid,
    new Date(Date.now() - 120_000).toISOString(),
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

describe('MonitoringService', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  function setup(sampler: NodeSampler, intervalMs = 30) {
    const store = new StateStore(':memory:');
    const events = new EventBus();
    const processes = new NodeProcessManager();
    insertNetworkAndNode(store);
    const monitoring = new MonitoringService({ store, processes, events, intervalMs, sampler, health: FAST });
    cleanups.push(() => {
      monitoring.stopAll();
      store.close();
    });
    const seen: Array<{ name: KaizenEventName; payload: unknown }> = [];
    events.subscribe((name, payload) => seen.push({ name, payload }));
    return { store, events, processes, monitoring, seen };
  }

  const goodObservation = (): RpcNodeObservation => ({
    at: new Date().toISOString(),
    rpc: { reachable: true },
    health: { isSyncing: false, peers: 3, shouldHavePeers: true },
    peers: { count: 3, list: [{ peerId: 'p1', bestHash: '0x1', bestNumber: 9, roles: 'FULL' }] },
    head: { number: 12, hash: '0xh' },
    finalized: { number: 10, hash: '0xf' },
    genesisHash: '0xg',
    sync: { startingBlock: 0, currentBlock: 12, highestBlock: 12 },
    warnings: [],
  });

  it('samples on the loop and emits monitor.sample with real data', async () => {
    let calls = 0;
    const { monitoring, seen } = setup(async () => {
      calls++;
      return { ...goodObservation(), at: new Date().toISOString(), head: { number: 12 + calls, hash: '0xh' } };
    });
    monitoring.start('net_1');
    await waitFor(() => seen.some((s) => s.name === 'monitor.sample'));

    const event = seen.find((s) => s.name === 'monitor.sample')?.payload as KaizenEventMap['monitor.sample'];
    expect(event.networkId).toBe('net_1');
    expect(event.at).toBeTruthy();
    expect(event.snapshot.samples).toHaveLength(1);
    expect(event.snapshot.samples[0]?.head?.number).toBeGreaterThanOrEqual(13);
    expect(event.snapshot.samples[0]?.peers?.expected).toBe(3);
    expect(event.snapshot.health[0]?.state).toBe('healthy');
    expect(monitoring.getLatest('net_1')).not.toBeNull();
  });

  it('prevents overlapping polls when a tick is slower than the interval', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { monitoring, seen } = setup(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 120)); // slower than intervalMs
      inFlight--;
      return goodObservation();
    });
    monitoring.start('net_1');
    await waitFor(() => seen.filter((s) => s.name === 'monitor.sample').length >= 2, 5_000);
    expect(maxInFlight).toBe(1);
  });

  it('emits monitor.health on state transitions with reasons', async () => {
    let fail = false;
    const { monitoring, seen } = setup(async () => {
      if (fail) {
        return {
          ...goodObservation(),
          rpc: { reachable: false, error: 'ECONNREFUSED' },
          health: null,
          peers: null,
          head: null,
          finalized: null,
          sync: null,
        };
      }
      return goodObservation();
    });
    monitoring.start('net_1');
    await waitFor(() =>
      seen.some((s) => s.name === 'monitor.health' && (s.payload as KaizenEventMap['monitor.health']).to === 'unhealthy'),
    );
    // Process is 'running' in the store but no pid is alive → unhealthy path;
    // then flip to unreachable to also cross the unavailable threshold.
    fail = true;
    await waitFor(() =>
      seen.some((s) => s.name === 'monitor.health' && (s.payload as KaizenEventMap['monitor.health']).to === 'unavailable'),
    );
    const event = seen.find(
      (s) => s.name === 'monitor.health' && (s.payload as KaizenEventMap['monitor.health']).to === 'unavailable',
    )?.payload as KaizenEventMap['monitor.health'];
    expect(event.networkId).toBe('net_1');
    expect(event.nodeId).toBe('net_1-a');
    expect(event.reasons.join(' ')).toMatch(/RPC unreachable/);
  });

  it('emits monitor.peers when the peer count changes', async () => {
    let count = 0;
    const { monitoring, seen } = setup(async () => {
      count++; // 1, 2, 3… each tick observes a higher count
      return {
        ...goodObservation(),
        health: { isSyncing: false, peers: count, shouldHavePeers: true },
        peers: { count, list: [] },
      };
    });
    monitoring.start('net_1');
    await waitFor(() => seen.some((s) => s.name === 'monitor.peers'));
    const event = seen.find((s) => s.name === 'monitor.peers')?.payload as KaizenEventMap['monitor.peers'];
    expect(event.from).toBe(1);
    expect(event.to).toBe(2); // second tick observed the new count
    expect(event.expected).toBe(3);
    expect(event.nodeId).toBe('net_1-a');
  });

  it('stops polling when the network reports stopping/stopped (cleanup)', async () => {
    let calls = 0;
    const { monitoring, events, seen } = setup(async () => {
      calls++;
      return goodObservation();
    });
    monitoring.start('net_1');
    await waitFor(() => calls >= 1);
    expect(monitoring.isRunning('net_1')).toBe(true);

    events.emit('network.status', {
      networkId: 'net_1',
      name: 'alpha',
      status: 'stopping',
      at: new Date().toISOString(),
    });
    expect(monitoring.isRunning('net_1')).toBe(false);
    expect(monitoring.getLatest('net_1')).toBeNull();
    const callsAfterStop = calls;
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toBe(callsAfterStop); // no further sampling
    void seen;
  });

  it('auto-starts monitoring when a network becomes running (bus-driven)', async () => {
    const { monitoring, events } = setup(async () => goodObservation());
    expect(monitoring.isRunning('net_1')).toBe(false);
    events.emit('network.status', {
      networkId: 'net_1',
      name: 'alpha',
      status: 'running',
      at: new Date().toISOString(),
    });
    expect(monitoring.isRunning('net_1')).toBe(true);
  });

  it('contains sampler crashes per node — the node goes unavailable, the loop continues', async () => {
    let boom = true;
    const { monitoring, seen } = setup(async () => {
      if (boom) throw new Error('sampler exploded');
      return goodObservation();
    });
    monitoring.start('net_1');
    // Sampler failures become honest unreachable samples → unavailable.
    await waitFor(() =>
      (monitoring.getLatest('net_1')?.health ?? []).some((h) => h.state === 'unavailable'),
    );
    expect(monitoring.isRunning('net_1')).toBe(true);
    boom = false;
    await waitFor(() =>
      (monitoring.getLatest('net_1')?.health ?? []).some((h) => h.state === 'healthy'),
    );
    void seen;
  });

  it('emits monitor.error when the tick itself fails (store gone) and keeps the loop alive', async () => {
    const { monitoring, store, seen } = setup(async () => goodObservation());
    monitoring.start('net_1');
    await waitFor(() => monitoring.getLatest('net_1') !== null);
    // Closing the store makes the next tick's network lookup throw — a
    // tick-level failure the loop must survive and report.
    store.close();
    await waitFor(() => seen.some((s) => s.name === 'monitor.error'));
    const event = seen.find((s) => s.name === 'monitor.error')?.payload as KaizenEventMap['monitor.error'];
    expect(event.networkId).toBe('net_1');
    expect(event.message).toBeTruthy();
  });
});
