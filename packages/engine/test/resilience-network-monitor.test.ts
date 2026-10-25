import { describe, expect, it } from 'vitest';
import {
  computeRecoveryMetrics,
  createHttpMonitorRpc,
  runNetworkMonitor,
  sampleNetwork,
  samplesToObservations,
  summarizeSamples,
  verifyMonitorReport,
  type ChainReader,
  type MonitorRpc,
  type NetworkSample,
} from '@kaizen/engine';

const hash = (n: number): string => '0x' + n.toString(16).padStart(64, '0');
const T0 = Date.parse('2026-10-25T10:00:00.000Z');

function sample(i: number, best: number, fin: number, over: Partial<NetworkSample> = {}): NetworkSample {
  return {
    at: new Date(T0 + i * 6_000).toISOString(),
    ok: true,
    latencyMs: 40,
    best: { number: best, hash: hash(best) },
    finalized: { number: fin, hash: hash(fin) },
    finalityLag: best - fin,
    peers: 3,
    isSyncing: false,
    ...over,
  };
}

/** Fake node: finalized trails best by 2. */
function fakeRpc(opts: { best?: number; fail?: boolean; health?: unknown } = {}): MonitorRpc {
  const best = opts.best ?? 1_000;
  return {
    async call(method, params = []) {
      if (opts.fail) throw new Error('offline');
      if (method === 'chain_getBlockHash') return hash(best);
      if (method === 'chain_getFinalizedHead') return hash(best - 2);
      if (method === 'chain_getHeader') {
        const h = params[0] as string;
        return { number: '0x' + parseInt(h, 16).toString(16) };
      }
      if (method === 'system_health') {
        if (opts.health === 'error') throw new Error('method not allowed');
        return opts.health ?? { peers: 4, isSyncing: false, shouldHavePeers: true };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

describe('sampleNetwork', () => {
  it('reads heads by hash and health', async () => {
    const s = await sampleNetwork(fakeRpc());
    expect(s.ok).toBe(true);
    expect(s.best).toEqual({ number: 1_000, hash: hash(1_000) });
    expect(s.finalized?.number).toBe(998);
    expect(s.finalityLag).toBe(2);
    expect(s.peers).toBe(4);
  });
  it('tolerates a node that hides system_health', async () => {
    const s = await sampleNetwork(fakeRpc({ health: 'error' }));
    expect(s.ok).toBe(true);
    expect(s.peers).toBeNull();
  });
  it('records a failure, never invents values', async () => {
    const s = await sampleNetwork(fakeRpc({ fail: true }));
    expect(s.ok).toBe(false);
    expect(s.best).toBeUndefined();
    expect(s.error).toContain('offline');
  });
});

describe('summarizeSamples', () => {
  it('healthy window: production, finality lag, peers', () => {
    const samples = [sample(0, 100, 98), sample(1, 101, 99), sample(2, 102, 100), sample(3, 103, 101)];
    const s = summarizeSamples(samples);
    expect(s.verdict).toBe('healthy');
    expect(s.blocksProduced).toBe(3);
    expect(s.observedBlockTimeMs).toBe(6_000);
    expect(s.finalizedAdvance).toBe(3);
    expect(s.finalityLagMax).toBe(2);
    expect(s.finalityLagMean).toBe(2);
    expect(s.peersMin).toBe(3);
    expect(s.availability).toBe(1);
    expect(s.reasons).toEqual([]);
  });
  it('flags a stalled chain', () => {
    const samples = [sample(0, 100, 98), sample(1, 100, 98), sample(2, 100, 98), sample(3, 100, 98)];
    const s = summarizeSamples(samples);
    expect(s.verdict).toBe('stalled');
    expect(s.reasons[0]).toMatch(/no new best block/);
  });
  it('degrades on a production stall, lag spike, and failed sample', () => {
    const samples: NetworkSample[] = [
      sample(0, 100, 98),
      sample(5, 100, 98), // 30 s with no new block
      sample(6, 120, 98), // lag 22
      {
        at: new Date(T0 + 7 * 6_000).toISOString(),
        ok: false,
        latencyMs: 5_000,
        peers: null,
        isSyncing: null,
        error: 'timeout',
      },
      sample(8, 125, 110),
    ];
    const s = summarizeSamples(samples);
    expect(s.verdict).toBe('degraded');
    expect(s.productionStalls).toBe(1);
    expect(s.longestProductionStallMs).toBe(30_000);
    expect(s.finalityLagMax).toBe(22);
    expect(s.availability).toBeCloseTo(0.8);
    expect(s.reasons.join(' ')).toMatch(/finality lag reached 22/);
  });
  it('unreachable with no ok samples; rejects bad slot time', () => {
    const s = summarizeSamples([
      {
        at: new Date(T0).toISOString(),
        ok: false,
        latencyMs: 1,
        peers: null,
        isSyncing: null,
      },
    ]);
    expect(s.verdict).toBe('unreachable');
    expect(s.finalityLagMax).toBeNull();
    expect(() => summarizeSamples([], 0)).toThrow(/positive/);
  });
});

describe('runNetworkMonitor', () => {
  it('takes N samples, sleeping between them', async () => {
    const sleeps: number[] = [];
    const report = await runNetworkMonitor({
      rpc: fakeRpc(),
      endpoint: 'https://node.example',
      samples: 3,
      intervalMs: 6_000,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(sleeps).toEqual([6_000, 6_000]);
    expect(report.samples).toHaveLength(3);
    expect(report.summary.okSamples).toBe(3);
  });
  it('validates inputs', async () => {
    await expect(
      runNetworkMonitor({
        rpc: fakeRpc(),
        endpoint: 'x',
        samples: 0,
        intervalMs: 0,
      }),
    ).rejects.toThrow(/samples/);
    await expect(
      runNetworkMonitor({
        rpc: fakeRpc(),
        endpoint: 'x',
        samples: 1,
        intervalMs: -1,
      }),
    ).rejects.toThrow(/intervalMs/);
  });
});

describe('feeding evidence and verification', () => {
  it('samples convert to observations the recovery maths accepts', () => {
    const before = samplesToObservations([sample(0, 100, 98), sample(1, 101, 99)], 'before-fault');
    const after = samplesToObservations([sample(5, 110, 106)], 'after-recovery');
    const m = computeRecoveryMetrics({
      observations: [...before, ...after],
      faultStartedAt: new Date(T0 + 12_000).toISOString(),
      faultEndedAt: new Date(T0 + 24_000).toISOString(),
    });
    expect(m.recovered).toBe(true);
  });
  it('verifyMonitorReport distinguishes verified, mismatch, unverifiable', async () => {
    const samples = [sample(0, 100, 98), sample(1, 101, 99)];
    const report = {
      version: 1 as const,
      network: null,
      genesisHash: null,
      endpoint: 'x',
      samples,
      summary: summarizeSamples(samples),
    };
    const reader = (fn: (n: number) => Promise<string | null>): ChainReader => ({
      blockHashAt: fn,
      genesisHash: async () => null,
      readHeads: async () => {
        throw new Error('unused');
      },
    });
    expect(
      (
        await verifyMonitorReport(
          report,
          reader(async (n) => hash(n)),
        )
      ).status,
    ).toBe('verified');
    expect(
      (
        await verifyMonitorReport(
          report,
          reader(async () => hash(7)),
        )
      ).status,
    ).toBe('mismatch');
    expect(
      (
        await verifyMonitorReport(
          report,
          reader(async () => {
            throw new Error('offline');
          }),
        )
      ).status,
    ).toBe('unverifiable');
  });
});

describe('createHttpMonitorRpc', () => {
  it('maps ws(s) to http(s) and surfaces RPC errors', async () => {
    const urls: string[] = [];
    const rpc = createHttpMonitorRpc('wss://node.example', {
      fetch: async (u) => {
        urls.push(u);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'nope' } }), { status: 200 });
      },
    });
    await expect(rpc.call('system_health')).rejects.toThrow(/nope/);
    expect(urls[0]).toBe('https://node.example');
  });
});
