/**
 * `kaizen up` orchestration tests (T-3.6C) with a FAKE engine: no binary is
 * downloaded and no node process is spawned. They pin the order of engine
 * calls, reuse of an existing network, the --no-setup refusal, honest
 * Phase-6 refusal for docker/kubernetes, and failure propagation.
 * A live run against a real portaldot binary needs an x86_64 host
 * (KAIZEN_TEST_LIVE=1; the arm64 CI sandbox cannot run portaldot_dev).
 */

import { describe, expect, it, vi } from 'vitest';
import { isKaizenError, type NetworkRecord, type NodeRecord, type OperationResult } from '@kaizen/engine';
import { formatUpSummary, kaizenUp, type UpEngine, type UpOptions } from '../src/up';

const OPTS: UpOptions = { name: 'kaizen-local', preset: 'four-validator', target: 'local', setup: true };

function node(i: number): NodeRecord {
  return {
    id: `net_1-n${i}`,
    networkId: 'net_1',
    name: `kaizen-local-v${i}`,
    role: 'validator',
    chain: 'local',
    bootnodes: [],
    baseDir: '/x',
    nodeKeyFile: '/x/k',
    logFile: '/x/l',
    ports: { p2p: 30333 + i, rpc: 9933 + i, ws: 9944 + i, prometheus: 9615 + i },
    expectedPeers: 3,
    status: 'created',
  } as unknown as NodeRecord;
}

function fakeEngine(over: { available?: boolean; existing?: boolean; running?: boolean; startOk?: boolean } = {}) {
  const calls: string[] = [];
  let status: NetworkRecord['status'] = over.running ? 'running' : 'created';
  const net = () => ({ id: 'net_1', name: 'kaizen-local', preset: 'four-validator', status }) as unknown as NetworkRecord;
  const nodes = [0, 1, 2, 3].map(node);
  const result = (ok: boolean): OperationResult =>
    ({ ok, operationId: 1, kind: 'network.start', startedAt: '', finishedAt: '', durationMs: 4200, ...(ok ? {} : { error: { code: 'HEALTH_TIMEOUT', message: 'nodes never became healthy' } }) }) as unknown as OperationResult;
  const engine = {
    binaries: {
      status: vi.fn(async () => {
        calls.push('binaries.status');
        return over.available === false ? { available: false, problems: ['binary missing'] } : { available: true, problems: [], entry: { binaryVersion: '1.0.0' } };
      }),
      setup: vi.fn(async () => {
        calls.push('binaries.setup');
        return { binaryVersion: '1.0.0', sha256: 'abcdef0123456789abcdef', platform: 'linux-x64', sourceUrl: 'https://x' };
      }),
    },
    networks: {
      list: vi.fn(() => {
        calls.push('networks.list');
        return over.existing ? [{ ...net(), nodeCount: 4 }] : [];
      }),
      create: vi.fn(async (input: { name: string; preset: string }) => {
        calls.push(`networks.create:${input.name}:${input.preset}`);
        return net();
      }),
      getNetwork: vi.fn(() => ({ network: net(), nodes })),
      start: vi.fn(async () => {
        calls.push('networks.start');
        const ok = over.startOk !== false;
        if (ok) status = 'running';
        return result(ok);
      }),
    },
  } as unknown as UpEngine;
  return { engine, calls };
}

describe('kaizen up', () => {
  it('sets up a missing binary, creates the preset network, starts it and reports real endpoints', async () => {
    const { engine, calls } = fakeEngine({ available: false });
    const lines: string[] = [];
    const s = await kaizenUp(engine, OPTS, (l) => lines.push(l));
    expect(calls).toEqual(['binaries.status', 'binaries.setup', 'networks.list', 'networks.create:kaizen-local:four-validator', 'networks.start']);
    expect(s.ok).toBe(true);
    expect(s.steps.map((x) => `${x.id}:${x.done}`)).toEqual(['binary:performed', 'network:performed', 'start:performed']);
    expect(s.nodes).toHaveLength(4);
    expect(s.nodes[0]).toMatchObject({ rpc: 'http://127.0.0.1:9933', ws: 'ws://127.0.0.1:9944' });
    expect(lines.some((l) => l.includes('4 nodes started and healthy'))).toBe(true);
    const box = formatUpSummary(s).join('\n');
    expect(box).toContain('ws://127.0.0.1:9944');
    expect(box).toContain('http://127.0.0.1:5173');
    expect(box).toContain('kaizen network stop kaizen-local');
  });

  it('reuses an existing running network without creating or starting', async () => {
    const { engine, calls } = fakeEngine({ existing: true, running: true });
    const s = await kaizenUp(engine, OPTS);
    expect(calls).toEqual(['binaries.status', 'networks.list']);
    expect(s.steps.map((x) => x.done)).toEqual(['existing', 'existing', 'existing']);
  });

  it('refuses to download with --no-setup', async () => {
    const { engine, calls } = fakeEngine({ available: false });
    await expect(kaizenUp(engine, { ...OPTS, setup: false })).rejects.toSatisfy((e: unknown) => isKaizenError(e) && e.code === 'BINARY_NOT_AVAILABLE');
    expect(calls).toEqual(['binaries.status']);
  });

  it('labels docker / kubernetes as planned instead of faking them', async () => {
    const { engine, calls } = fakeEngine();
    await expect(kaizenUp(engine, { ...OPTS, target: 'docker' })).rejects.toThrow(/Phase 6/);
    await expect(kaizenUp(engine, { ...OPTS, target: 'k8s' })).rejects.toThrow(/Phase 6/);
    await expect(kaizenUp(engine, { ...OPTS, target: 'mars' })).rejects.toThrow(/Unknown target/);
    expect(calls).toEqual([]);
  });

  it('propagates a failed health-gated start', async () => {
    const { engine } = fakeEngine({ startOk: false });
    const s = await kaizenUp(engine, OPTS);
    expect(s.ok).toBe(false);
    expect(s.error).toEqual({ code: 'HEALTH_TIMEOUT', message: 'nodes never became healthy' });
  });
});
