/** Record builders for jsdom tests (test fixtures only — never in prod). */

import type {
  NetworkMonitorSnapshot,
  NetworkWithCount,
  NodeHealthReport,
  NodeMonitorSample,
  NodeRecord,
} from '../api/types';

export function makeNetwork(over: Partial<NetworkWithCount> = {}): NetworkWithCount {
  return {
    id: 'net_1',
    name: 'demo',
    preset: 'two-node',
    status: 'created',
    designatedTest: true,
    chain: 'local-spec',
    chainSpecPath: '/tmp/x/chain-spec-raw.json',
    baseDir: '/tmp/x',
    createdAt: '2026-10-10T12:00:00.000Z',
    updatedAt: '2026-10-10T12:00:00.000Z',
    nodeCount: 2,
    ...over,
  };
}

export function makeNode(over: Partial<NodeRecord> = {}): NodeRecord {
  const id = over.id ?? 'net_1-alice';
  return {
    id,
    networkId: 'net_1',
    name: 'demo-alice',
    role: 'validator',
    chain: 'local-spec',
    wellKnownKey: 'alice',
    bootnodes: [],
    baseDir: `/tmp/x/node-${id}`,
    nodeKeyFile: `/tmp/x/node-${id}/node.key`,
    logFile: `/tmp/x/logs/node-${id}.log`,
    ports: { p2p: 30333, rpc: 9933, ws: 9944, prometheus: 9615 },
    expectedPeers: 1,
    status: 'created',
    ...over,
  };
}

export function makeSample(over: Partial<NodeMonitorSample> = {}): NodeMonitorSample {
  return {
    networkId: 'net_1',
    nodeId: 'net_1-alice',
    name: 'demo-alice',
    at: '2026-10-10T12:00:10.000Z',
    process: { status: 'running', pid: 4242, startedAt: '2026-10-10T12:00:00.000Z' },
    rpc: { reachable: true },
    health: { isSyncing: false, peers: 1, shouldHavePeers: true },
    peers: { count: 1, expected: 1, list: [] },
    head: { number: 12, hash: '0xabc' },
    finalized: { number: 10, hash: '0xdef' },
    genesisHash: '0x00',
    sync: { startingBlock: 0, currentBlock: 12, highestBlock: 12 },
    uptimeMs: 10_000,
    warnings: [],
    ...over,
  };
}

export function makeHealth(over: Partial<NodeHealthReport> = {}): NodeHealthReport {
  return {
    nodeId: 'net_1-alice',
    state: 'healthy',
    reasons: ['peers 1/1', 'head #12'],
    since: '2026-10-10T12:00:10.000Z',
    lastSampleAt: '2026-10-10T12:00:10.000Z',
    lastHealthyAt: '2026-10-10T12:00:10.000Z',
    rpcFailures: 0,
    ...over,
  };
}

export function makeSnapshot(over: Partial<NetworkMonitorSnapshot> = {}): NetworkMonitorSnapshot {
  return {
    networkId: 'net_1',
    name: 'demo',
    at: '2026-10-10T12:00:10.000Z',
    intervalMs: 2000,
    samples: [makeSample()],
    health: [makeHealth()],
    ...over,
  };
}
