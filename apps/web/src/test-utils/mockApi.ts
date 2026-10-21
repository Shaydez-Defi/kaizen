/**
 * Test-only API double: every KaizenApiClient method as a vi.fn(), primed
 * with fixture responses. Used via `vi.mock('../api/client', ...)` in jsdom
 * tests — never imported by production code.
 */

import { vi } from 'vitest';
import type { KaizenApiClient } from '../api/client';
import type { FaultRecord, NetworkWithCount, NodeRecord } from '../api/types';
import { makeHealth, makeNetwork, makeNode, makeSample, makeSnapshot } from './fixtures';

export type ApiMock = { [K in keyof KaizenApiClient]: ReturnType<typeof vi.fn> };

const METHODS = [
  'health', 'binaries', 'listNetworks', 'createNetwork', 'getNetwork', 'startNetwork', 'stopNetwork', 'purgeNetwork',
  'removeNetwork', 'monitorSnapshot', 'getNode', 'startNode', 'stopNode', 'nodeLogs', 'listScenarios', 'scenarioOperations',
  'validateScenario', 'createScenario', 'getScenario', 'updateScenario', 'deleteScenario', 'executeScenario', 'getScenarioRun',
  'listScenarioRuns', 'cancelScenarioRun', 'replayScenarioRun', 'dryRunFault', 'executeFault', 'listFaults', 'getFault',
  'cancelFault', 'v3Probe', 'v3Status', 'v3Anchors', 'anchorRun', 'verifyAnchor', 'runHash',
] as const;

export function makeApiMock(): ApiMock {
  const out: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of METHODS) out[m] = vi.fn();
  return out as ApiMock;
}

export const okOp = { ok: true, result: { ok: true, operationId: 1, kind: 'x', startedAt: '', finishedAt: '', durationMs: 1 } };

export const ALICE = makeNode({
  bootnodes: ['/ip4/127.0.0.1/tcp/30334/p2p/12D3KooWBzBzB'],
  status: 'running',
  pid: 4242,
});
export const BOB = makeNode({
  id: 'net_1-bob',
  name: 'demo-bob',
  wellKnownKey: 'bob',
  ports: { p2p: 30334, rpc: 9934, ws: 9945, prometheus: 9616 },
  bootnodes: ['/ip4/127.0.0.1/tcp/30333/p2p/12D3KooWAzAzA'],
  status: 'running',
  pid: 4343,
});

/** Prime a running two-node network with real-shaped monitoring data. */
export function primeApi(
  api: ApiMock,
  opts: { network?: Partial<NetworkWithCount>; nodes?: NodeRecord[]; faults?: FaultRecord[]; empty?: boolean } = {},
): void {
  const network = makeNetwork({ status: 'running', ...opts.network });
  const nodes = opts.nodes ?? [ALICE, BOB];
  api.health.mockResolvedValue({ ok: true, service: 'kaizen-api', version: '0.1.0', dataDir: '/data/.kaizen' });
  api.binaries.mockResolvedValue({ ok: true, status: { available: true, version: 'portaldot 1.0.0', sha256: 'abcdef0123456789' } });
  api.listNetworks.mockResolvedValue({ ok: true, networks: opts.empty ? [] : [network] });
  api.getNetwork.mockResolvedValue({ ok: true, network, nodes });
  api.listFaults.mockResolvedValue({ ok: true, faults: opts.faults ?? [] });
  api.monitorSnapshot.mockResolvedValue({
    ok: true,
    snapshot: makeSnapshot({
      samples: [
        makeSample({ head: { number: 120, hash: '0xa' }, finalized: { number: 118, hash: '0xb' }, peers: { count: 1, expected: 1, list: [{ peerId: '12D3KooWBzBzB', roles: 'AUTHORITY', bestHash: '0x', bestNumber: 120 }] } }),
        makeSample({ nodeId: 'net_1-bob', name: 'demo-bob', head: { number: 121, hash: '0xc' }, finalized: { number: 118, hash: '0xb' }, peers: { count: 1, expected: 1, list: [{ peerId: '12D3KooWAzAzA', roles: 'AUTHORITY', bestHash: '0x', bestNumber: 121 }] } }),
      ],
      health: [makeHealth(), makeHealth({ nodeId: 'net_1-bob' })],
    }),
  });
  api.getNode.mockImplementation((_n: string, id: string) =>
    Promise.resolve({
      ok: true,
      node: nodes.find((n) => n.id === id) ?? nodes[0],
      sample: makeSample({ nodeId: id }),
      health: makeHealth({ nodeId: id }),
    }),
  );
  api.nodeLogs.mockResolvedValue({ ok: true, nodeId: 'net_1-alice', lines: ['2026 INFO Imported #120', '2026 WARN slow block import'] });
  api.listScenarios.mockResolvedValue({ ok: true, scenarios: [], malformed: [], total: 0, limit: 50, offset: 0 });
  api.scenarioOperations.mockResolvedValue({ ok: true, operations: [] });
  api.listScenarioRuns.mockResolvedValue({ ok: true, runs: [], malformed: [], total: 0, limit: 10, offset: 0 });
}
