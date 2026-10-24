/**
 * Resilience score v1 (T-9.3) — a pure, deterministic 0–100 score for one
 * validator from its certified runs. The normative definition is
 * docs/RESILIENCE_SCORE.md; this file implements it exactly and
 * resilience-score.test.ts pins the worked examples from that spec.
 *
 * Per run i (certified, integrity not failed):
 *   survived_i = recovered AND state ∈ {completed, completed-with-warnings}
 *   R_i = 1 / (1 + ttr_ms / 60 000)      (time-to-recover; null → 0)
 *   F_i = 1 / (1 + gap_blocks / 10)      (finality gap;   null → 0)
 *   M_i = 1 / (1 + missed_blocks / 10)   (blocks missed;  null → 0)
 *   q_i = survived_i ? 0.5·R_i + 0.3·F_i + 0.2·M_i : 0
 *   w_i = 0.5 ^ (age_days_i / 30)        (recency decay, 30-day half-life)
 * Aggregate:
 *   quality    = Σ w_i·q_i / Σ w_i
 *   confidence = 1 − e^(−Σ w_i / 2)      (few or stale runs cannot reach 100)
 *   score      = round(100 · quality · confidence), clamped to [0, 100]
 */

import { KaizenError } from '../errors';

export const RESILIENCE_SCORE_VERSION = 1 as const;

export const RESILIENCE_SCORE_PARAMS = {
  recoveryRefMs: 60_000,
  finalityGapRefBlocks: 10,
  blocksMissedRefBlocks: 10,
  weights: { recovery: 0.5, finality: 0.3, liveness: 0.2 },
  halfLifeDays: 30,
  confidenceScale: 2,
} as const;

export interface ScoredRunInput {
  runId: string;
  /** Terminal run state of the certified run. */
  runState: string;
  recovered: boolean;
  timeToRecoverMs: number | null;
  finalityGapBlocks: number | null;
  blocksMissed: number | null;
  /** When the evidence was certified (ISO-8601). */
  certifiedAt: string;
}

export interface ScoredRun {
  runId: string;
  survived: boolean;
  quality: number;
  weight: number;
  ageDays: number;
}

export interface ResilienceScore {
  version: typeof RESILIENCE_SCORE_VERSION;
  validatorId: string;
  score: number;
  quality: number;
  confidence: number;
  effectiveRuns: number;
  runs: number;
  faultsSurvived: number;
  latestCertifiedAt: string | null;
  asOf: string;
  perRun: ScoredRun[];
}

const SURVIVING_STATES = new Set(['completed', 'completed-with-warnings']);
const DAY_MS = 86_400_000;

function inverse(value: number | null, ref: number): number {
  if (value === null || !Number.isFinite(value) || value < 0) return 0;
  return 1 / (1 + value / ref);
}

export function scoreRun(run: ScoredRunInput, asOf: Date): ScoredRun {
  const p = RESILIENCE_SCORE_PARAMS;
  const t = Date.parse(run.certifiedAt);
  if (Number.isNaN(t)) throw new KaizenError('INVALID_INPUT', `invalid certifiedAt for run ${run.runId}`);
  const ageDays = Math.max(0, (asOf.getTime() - t) / DAY_MS);
  const survived = run.recovered && SURVIVING_STATES.has(run.runState);
  const quality = survived
    ? p.weights.recovery * inverse(run.timeToRecoverMs, p.recoveryRefMs) +
      p.weights.finality * inverse(run.finalityGapBlocks, p.finalityGapRefBlocks) +
      p.weights.liveness * inverse(run.blocksMissed, p.blocksMissedRefBlocks)
    : 0;
  return { runId: run.runId, survived, quality, weight: Math.pow(0.5, ageDays / p.halfLifeDays), ageDays };
}

export function computeResilienceScore(
  validatorId: string,
  runs: readonly ScoredRunInput[],
  asOf: Date = new Date(),
): ResilienceScore {
  const perRun = runs.map((r) => scoreRun(r, asOf));
  const weightSum = perRun.reduce((s, r) => s + r.weight, 0);
  const quality = weightSum > 0 ? perRun.reduce((s, r) => s + r.weight * r.quality, 0) / weightSum : 0;
  const confidence = 1 - Math.exp(-weightSum / RESILIENCE_SCORE_PARAMS.confidenceScale);
  const score = Math.min(100, Math.max(0, Math.round(100 * quality * confidence)));
  const latest = runs.reduce<string | null>(
    (m, r) => (m === null || Date.parse(r.certifiedAt) > Date.parse(m) ? r.certifiedAt : m),
    null,
  );
  return {
    version: RESILIENCE_SCORE_VERSION,
    validatorId,
    score,
    quality,
    confidence,
    effectiveRuns: weightSum,
    runs: runs.length,
    faultsSurvived: perRun.filter((r) => r.survived).length,
    latestCertifiedAt: latest,
    asOf: asOf.toISOString(),
    perRun,
  };
}
