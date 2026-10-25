/**
 * Read-only network monitoring (plan item 3, T-9.10).
 *
 * Samples a public node over plain JSON-RPC (`chain_getHeader`,
 * `chain_getFinalizedHead`, `system_health`) and summarises a window:
 * block production, finality lag, peers, availability. Everything is a real
 * read; a failed read is recorded as a failed sample, never filled in.
 *
 * Honesty: this observes a LIVE network. It does not inject faults, so it is
 * liveness evidence, not a resilience score. Its finalized block refs are
 * re-checkable (`verifyMonitorReport`) and its samples convert to
 * `ChainObservation`s so a drill can reuse the same recovery maths.
 */

import { KaizenError } from '../errors';
import { ChainUnreachableError } from './rpc';
import type { ChainReader } from './rpc';
import { DEFAULT_EXPECTED_BLOCK_TIME_MS } from './evidence';
import type { BlockRef, ChainObservation, ChainEvidencePhase } from './evidence';
import type { FetchLike } from './rpc';

export const NETWORK_MONITOR_VERSION = 1 as const;

/** A window is flagged when best lag exceeds this many blocks. */
export const MONITOR_FINALITY_LAG_DEGRADED_BLOCKS = 12;

export interface MonitorRpc {
  call(method: string, params?: unknown[]): Promise<unknown>;
}

export interface NetworkSample {
  /** ISO time the sample started. */
  at: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  best?: BlockRef;
  finalized?: BlockRef;
  /** best.number − finalized.number */
  finalityLag?: number;
  /** null when the node does not answer system_health */
  peers: number | null;
  isSyncing: boolean | null;
}

export interface MonitorSummary {
  version: typeof NETWORK_MONITOR_VERSION;
  samples: number;
  okSamples: number;
  /** okSamples / samples, 0..1 */
  availability: number;
  windowStart: string | null;
  windowEnd: string | null;
  windowMs: number;
  blocksProduced: number;
  /** Mean ms per block over the window; null with fewer than two ok samples or no progress. */
  observedBlockTimeMs: number | null;
  expectedBlockTimeMs: number;
  /** Intervals between ok samples with no new best block for > 2 slots. */
  productionStalls: number;
  longestProductionStallMs: number;
  finalizedAdvance: number;
  finalityLagMin: number | null;
  finalityLagMean: number | null;
  finalityLagMax: number | null;
  peersMin: number | null;
  peersMax: number | null;
  syncing: boolean;
  verdict: 'healthy' | 'degraded' | 'stalled' | 'unreachable';
  /** Plain reasons behind a non-healthy verdict. */
  reasons: string[];
}

export interface MonitorReport {
  version: typeof NETWORK_MONITOR_VERSION;
  network: string | null;
  genesisHash: string | null;
  endpoint: string;
  samples: NetworkSample[];
  summary: MonitorSummary;
}

export interface HttpMonitorRpcOptions {
  timeoutMs?: number;
  fetch?: FetchLike;
}

/** Plain JSON-RPC over HTTP(S); `ws(s)://` URLs are mapped to `http(s)://`. */
export function createHttpMonitorRpc(url: string, options: HttpMonitorRpcOptions = {}): MonitorRpc {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const doFetch: FetchLike = options.fetch ?? ((u, init) => fetch(u, init));
  const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  let id = 0;
  return {
    async call(method, params = []) {
      let res: Response;
      try {
        res = await doFetch(httpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new ChainUnreachableError(`${method}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok) throw new ChainUnreachableError(`${method}: HTTP ${res.status}`);
      const body = (await res.json()) as {
        result?: unknown;
        error?: { message?: string };
      };
      if (body.error) throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`);
      return body.result;
    },
  };
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function headerNumber(header: unknown): number {
  const n = (header as { number?: string | number } | null)?.number;
  const v = typeof n === 'number' ? n : typeof n === 'string' ? parseInt(n, 16) : NaN;
  if (!Number.isSafeInteger(v) || v < 0) throw new Error('malformed header number');
  return v;
}

/** One real read of best/finalized heads plus peer health. Never throws. */
export async function sampleNetwork(rpc: MonitorRpc, now: () => Date = () => new Date()): Promise<NetworkSample> {
  const started = now();
  const t0 = Date.now();
  const base = {
    at: started.toISOString(),
    peers: null as number | null,
    isSyncing: null as boolean | null,
  };
  try {
    const [bestHash, finalizedHash, health] = await Promise.all([
      rpc.call('chain_getBlockHash'),
      rpc.call('chain_getFinalizedHead'),
      rpc.call('system_health').catch(() => null),
    ]);
    if (typeof bestHash !== 'string' || !HASH_RE.test(bestHash)) throw new Error('malformed best hash');
    if (typeof finalizedHash !== 'string' || !HASH_RE.test(finalizedHash)) throw new Error('malformed finalized hash');
    // Headers are read BY HASH so number and hash always belong together.
    const [bestHeader, finalizedHeader] = await Promise.all([
      rpc.call('chain_getHeader', [bestHash]),
      rpc.call('chain_getHeader', [finalizedHash]),
    ]);
    const best: BlockRef = {
      number: headerNumber(bestHeader),
      hash: bestHash.toLowerCase(),
    };
    const finalized: BlockRef = {
      number: headerNumber(finalizedHeader),
      hash: finalizedHash.toLowerCase(),
    };
    const h = health as { peers?: unknown; isSyncing?: unknown } | null;
    return {
      ...base,
      ok: true,
      latencyMs: Date.now() - t0,
      best,
      finalized,
      finalityLag: Math.max(0, best.number - finalized.number),
      peers: typeof h?.peers === 'number' ? h.peers : null,
      isSyncing: typeof h?.isSyncing === 'boolean' ? h.isSyncing : null,
    };
  } catch (e) {
    return {
      ...base,
      ok: false,
      latencyMs: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Pure window summary. Deterministic for a given sample list. */
export function summarizeSamples(
  samples: readonly NetworkSample[],
  expectedBlockTimeMs: number = DEFAULT_EXPECTED_BLOCK_TIME_MS,
): MonitorSummary {
  if (!Number.isFinite(expectedBlockTimeMs) || expectedBlockTimeMs <= 0) {
    throw new KaizenError('INVALID_INPUT', 'expectedBlockTimeMs must be a positive number');
  }
  const ok = samples.filter(
    (
      s,
    ): s is NetworkSample & {
      best: BlockRef;
      finalized: BlockRef;
      finalityLag: number;
    } => s.ok && s.best !== undefined && s.finalized !== undefined && s.finalityLag !== undefined,
  );
  const first = ok[0];
  const last = ok[ok.length - 1];
  const windowMs = first && last ? Math.max(0, Date.parse(last.at) - Date.parse(first.at)) : 0;
  const blocksProduced = first && last ? Math.max(0, last.best.number - first.best.number) : 0;

  let productionStalls = 0;
  let longestStall = 0;
  for (let i = 1; i < ok.length; i++) {
    const prev = ok[i - 1]!;
    const cur = ok[i]!;
    const gap = Date.parse(cur.at) - Date.parse(prev.at);
    if (cur.best.number <= prev.best.number && gap > 2 * expectedBlockTimeMs) {
      productionStalls++;
      longestStall = Math.max(longestStall, gap);
    }
  }

  const lags = ok.map((s) => s.finalityLag);
  const peers = ok.map((s) => s.peers).filter((p): p is number => p !== null);
  const syncing = ok.some((s) => s.isSyncing === true);
  const lagMax = lags.length ? Math.max(...lags) : null;
  const availability = samples.length ? ok.length / samples.length : 0;
  const finalizedAdvance = first && last ? Math.max(0, last.finalized.number - first.finalized.number) : 0;

  const reasons: string[] = [];
  let verdict: MonitorSummary['verdict'] = 'healthy';
  if (ok.length === 0) {
    verdict = 'unreachable';
    reasons.push('no successful sample');
  } else {
    const spanOk = windowMs > 2 * expectedBlockTimeMs;
    if (spanOk && blocksProduced === 0) {
      verdict = 'stalled';
      reasons.push('no new best block across the window');
    }
    if (availability < 1) reasons.push(`${samples.length - ok.length} of ${samples.length} samples failed`);
    if (productionStalls > 0) reasons.push(`${productionStalls} block-production stall(s), longest ${longestStall} ms`);
    if (lagMax !== null && lagMax > MONITOR_FINALITY_LAG_DEGRADED_BLOCKS) {
      reasons.push(`finality lag reached ${lagMax} blocks`);
    }
    if (spanOk && finalizedAdvance === 0 && blocksProduced > 0) reasons.push('finality did not advance');
    if (syncing) reasons.push('node reported isSyncing');
    if (verdict === 'healthy' && reasons.length > 0) verdict = 'degraded';
  }

  return {
    version: NETWORK_MONITOR_VERSION,
    samples: samples.length,
    okSamples: ok.length,
    availability,
    windowStart: first?.at ?? null,
    windowEnd: last?.at ?? null,
    windowMs,
    blocksProduced,
    observedBlockTimeMs: blocksProduced > 0 && windowMs > 0 ? windowMs / blocksProduced : null,
    expectedBlockTimeMs,
    productionStalls,
    longestProductionStallMs: longestStall,
    finalizedAdvance,
    finalityLagMin: lags.length ? Math.min(...lags) : null,
    finalityLagMean: lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : null,
    finalityLagMax: lagMax,
    peersMin: peers.length ? Math.min(...peers) : null,
    peersMax: peers.length ? Math.max(...peers) : null,
    syncing,
    verdict,
    reasons,
  };
}

export interface RunMonitorOptions {
  rpc: MonitorRpc;
  endpoint: string;
  samples: number;
  intervalMs: number;
  network?: string | null;
  genesisHash?: string | null;
  expectedBlockTimeMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  onSample?: (s: NetworkSample) => void;
}

/** Take `samples` reads `intervalMs` apart and summarise them. */
export async function runNetworkMonitor(o: RunMonitorOptions): Promise<MonitorReport> {
  if (!Number.isInteger(o.samples) || o.samples < 1 || o.samples > 600) {
    throw new KaizenError('INVALID_INPUT', 'samples must be an integer from 1 to 600');
  }
  if (!Number.isFinite(o.intervalMs) || o.intervalMs < 0) {
    throw new KaizenError('INVALID_INPUT', 'intervalMs must be zero or more');
  }
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const samples: NetworkSample[] = [];
  for (let i = 0; i < o.samples; i++) {
    if (i > 0) await sleep(o.intervalMs);
    const s = await sampleNetwork(o.rpc, o.now);
    samples.push(s);
    o.onSample?.(s);
  }
  return {
    version: NETWORK_MONITOR_VERSION,
    network: o.network ?? null,
    genesisHash: o.genesisHash ?? null,
    endpoint: o.endpoint,
    samples,
    summary: summarizeSamples(samples, o.expectedBlockTimeMs),
  };
}

/** Reuse monitored samples as chain observations for the recovery maths. */
export function samplesToObservations(
  samples: readonly NetworkSample[],
  phase: ChainEvidencePhase,
): ChainObservation[] {
  const out: ChainObservation[] = [];
  for (const s of samples) {
    if (s.ok && s.best && s.finalized) out.push({ phase, at: s.at, best: s.best, finalized: s.finalized });
  }
  return out;
}

export interface MonitorVerification {
  checked: number;
  matched: number;
  mismatched: number;
  unverifiable: number;
  status: 'verified' | 'mismatch' | 'unverifiable';
}

/**
 * Re-fetch every distinct FINALIZED block hash in the report from `reader`
 * (finalized blocks are canonical; best heads may reorg, so they are not
 * checked). Offline reader → unverifiable, never a false pass.
 */
export async function verifyMonitorReport(report: MonitorReport, reader: ChainReader): Promise<MonitorVerification> {
  const refs = new Map<number, string>();
  for (const s of report.samples) if (s.ok && s.finalized) refs.set(s.finalized.number, s.finalized.hash);
  let matched = 0;
  let mismatched = 0;
  let unverifiable = 0;
  for (const [number, hash] of refs) {
    try {
      const actual = await reader.blockHashAt(number);
      if (actual === hash) matched++;
      else if (actual === null) unverifiable++;
      else mismatched++;
    } catch {
      unverifiable++;
    }
  }
  const status = mismatched > 0 ? 'mismatch' : refs.size > 0 && matched === refs.size ? 'verified' : 'unverifiable';
  return { checked: refs.size, matched, mismatched, unverifiable, status };
}
