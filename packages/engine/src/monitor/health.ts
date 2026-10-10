/**
 * Node health interpretation (T-2.4) — a pure function from observations to a
 * health report, unit-testable without processes or clocks.
 *
 * State meanings (a running process alone is never "healthy"):
 *  - 'unknown'      no sample has been collected yet
 *  - 'healthy'      process running, RPC fresh, head advancing, peers in line
 *  - 'unavailable'  process claims to run but RPC failed repeatedly
 *  - 'unhealthy'    process dead/crashed, chain stalled (RPC answers but the
 *                   head stopped advancing), or peers below expectation past
 *                   the startup grace period
 *  - 'stale'        the gap between successful samples exceeds staleAfterMs
 *                   (sampling degraded — we cannot judge the node honestly)
 */

import type { NodeHealthReport, NodeHealthState, NodeMonitorSample } from '../types';

export interface HealthEvalOptions {
  /** No new best block for this long (with RPC up) = stalled. */
  stallThresholdMs: number;
  /** Successful-sample gap beyond this = stale data. */
  staleAfterFailuresMs: number;
  /** Consecutive RPC failures before 'unavailable'. */
  unavailableAfterFailures: number;
  /** Peer shortfall grace period after node start. */
  peerGraceMs: number;
}

export const DEFAULT_HEALTH_OPTIONS: HealthEvalOptions = {
  stallThresholdMs: 30_000,
  staleAfterFailuresMs: 30_000,
  unavailableAfterFailures: 3,
  peerGraceMs: 60_000,
};

export interface HealthEvalInput {
  nodeId: string;
  /** Previous report from this monitor (undefined on first evaluation). */
  prev: NodeHealthReport | undefined;
  /** Best block number at the previous successful sample. */
  prevHeadNumber: number | undefined;
  /** When the head last advanced (epoch ms); undefined until first advance. */
  lastHeadAdvanceAt: number | undefined;
  /** The fresh sample, or null when the sampler itself failed. */
  sample: NodeMonitorSample | null;
  /** Real process liveness at evaluation time. */
  processAlive: boolean;
  now: number;
  options?: Partial<HealthEvalOptions>;
}

export interface HealthEvalOutput {
  report: NodeHealthReport;
  /** Updated last-head-advance timestamp (feed back on the next evaluation). */
  lastHeadAdvanceAt: number | undefined;
}

export function evaluateNodeHealth(input: HealthEvalInput): HealthEvalOutput {
  const opts = { ...DEFAULT_HEALTH_OPTIONS, ...input.options };
  const nowIso = new Date(input.now).toISOString();
  const prev = input.prev;
  const reasons: string[] = [];
  // Mutable: a head advance during THIS evaluation must be reported back.
  let headAdvanceAt = input.lastHeadAdvanceAt;

  const build = (
    state: NodeHealthState,
    rpcFailures: number,
    lastSampleAt: string | null,
    lastHealthyAt: string | null,
  ): HealthEvalOutput => ({
    report: {
      nodeId: input.nodeId,
      state,
      reasons,
      since: prev && prev.state === state ? prev.since : nowIso,
      lastSampleAt,
      lastHealthyAt: lastHealthyAt ?? prev?.lastHealthyAt ?? null,
      rpcFailures,
    },
    lastHeadAdvanceAt: headAdvanceAt,
  });

  // ---- Process state is decisive evidence (checked FIRST: a dead process
  // can never answer RPC, so RPC failures must not mask it as 'unavailable'). --
  if (!input.processAlive) {
    const status = input.sample?.process.status ?? 'unknown';
    reasons.push(
      status === 'crashed'
        ? 'process crashed (see node log for exit details)'
        : `process is not running (status: ${status})`,
    );
    return build('unhealthy', 0, input.sample?.at ?? prev?.lastSampleAt ?? null, null);
  }

  // ---- RPC failures (routine, thresholded; only reachable processes count) --
  if (!input.sample || !input.sample.rpc.reachable) {
    const failures = (prev?.rpcFailures ?? 0) + 1;
    const error = input.sample ? (input.sample.rpc.error ?? 'unreachable') : 'sampler failed';
    if (failures >= opts.unavailableAfterFailures) {
      reasons.push(`RPC unreachable for ${failures} consecutive checks: ${error}`);
      return build('unavailable', failures, prev?.lastSampleAt ?? null, null);
    }
    reasons.push(`RPC check failed (${failures}/${opts.unavailableAfterFailures}): ${error}`);
    // Not yet 'unavailable': keep judging on the last good data.
    return build(prev?.state ?? 'unknown', failures, prev?.lastSampleAt ?? null, null);
  }

  const sample: NodeMonitorSample = input.sample;

  // ---- Stale data (sampling degraded) --------------------------------------
  const prevSuccessAt = prev?.lastSampleAt ? Date.parse(prev.lastSampleAt) : null;
  if (prevSuccessAt !== null && input.now - prevSuccessAt > opts.staleAfterFailuresMs) {
    reasons.push(
      `monitoring data is stale: last successful sample ${Math.round((input.now - prevSuccessAt) / 1000)}s ago`,
    );
    return build('stale', 0, sample.at, null);
  }

  // ---- Chain progress (stall detection) ------------------------------------
  const headNumber = sample.head?.number;
  if (headNumber !== undefined && headNumber !== input.prevHeadNumber) {
    headAdvanceAt = input.now;
  }
  if (
    headNumber !== undefined &&
    headAdvanceAt !== undefined &&
    input.now - headAdvanceAt > opts.stallThresholdMs
  ) {
    reasons.push(
      `chain stalled: best block #${headNumber} unchanged for ${Math.round((input.now - headAdvanceAt) / 1000)}s while RPC still answers`,
    );
    return build('unhealthy', 0, sample.at, null);
  }

  // ---- Peer expectations (grace-perioded) ----------------------------------
  const peers = sample.peers;
  if (peers && peers.count < peers.expected) {
    const startedAt = sample.process.startedAt ? Date.parse(sample.process.startedAt) : null;
    const runningFor = startedAt !== null ? input.now - startedAt : Number.POSITIVE_INFINITY;
    if (runningFor < opts.peerGraceMs) {
      reasons.push(`peers ${peers.count}/${peers.expected} (within ${Math.round(opts.peerGraceMs / 1000)}s startup grace)`);
    } else {
      reasons.push(
        `peer shortfall: ${peers.count}/${peers.expected} peers for ${Math.round(runningFor / 1000)}s`,
      );
      return build('unhealthy', 0, sample.at, null);
    }
  } else if (peers) {
    reasons.push(`peers ${peers.count}/${peers.expected}`);
  }

  if (sample.health?.isSyncing) {
    reasons.push('node is syncing');
  }
  if (sample.warnings.length > 0) {
    reasons.push(...sample.warnings);
  }
  if (headNumber !== undefined) {
    reasons.push(
      `head #${headNumber}${sample.finalized ? `, finalized #${sample.finalized.number}` : ''}`,
    );
  }

  return build('healthy', 0, sample.at, sample.at);
}
