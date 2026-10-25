/**
 * Resilience-under-failure score v2 (T-9.9 / RESILIENCE_SCORE.md §7.3).
 *
 * Same shape as v1 (a 0-100 number from certified fault drills; never a
 * "health" score), with two changes grounded in what the chain itself can
 * prove:
 *
 *  - evidence class weights each run: chain-observed 1.0 (a seeded
 *    commit-reveal drill AND header-derived authorship, both re-verified,
 *    and GRANDPA prediction not contradicted by observation), chain-bound
 *    0.5 (v1: block hashes verifiable, metrics operator-measured),
 *    self-reported 0.1 (no chain binding)
 *  - recovery time comes from slots when authorship is present: slots
 *    between the fault window's last block and the first block the target
 *    authored again, times the slot duration, replacing the wall clock
 *
 *   w_i = 0.5 ^ (age_days / 30) * c_i      c = class weight
 *   score = round(100 * quality * confidence), confidence = 1 - e^(-sum w / 2)
 */

import { KaizenError } from "../errors";
import type { AuthorshipEvidence } from "./authorship";
import type { ChainEvidence } from "./evidence";
import { DEFAULT_EXPECTED_BLOCK_TIME_MS } from "./evidence";
import { RESILIENCE_SCORE_PARAMS } from "./score";
import type { ScoredRunInput } from "./score";

export const RESILIENCE_SCORE_V2_VERSION = 2 as const;

export type EvidenceClass = "chain-observed" | "chain-bound" | "self-reported";

export const EVIDENCE_CLASS_WEIGHT: Record<EvidenceClass, number> = {
  "chain-observed": 1,
  "chain-bound": 0.5,
  "self-reported": 0.1,
};

/** Verification outcomes the classifier needs (from verifyCertificate). */
export interface EvidenceChecks {
  drill: "verified" | "mismatch" | "unverifiable" | null;
  authorship: "verified" | "mismatch" | "unverifiable" | null;
  /** GRANDPA prediction agreed with observation; null = unknown/absent. */
  grandpaConsistent: boolean | null;
  /** Block hashes re-fetched and matching (the v1 chain binding). */
  chainBound: boolean;
}

export function classifyEvidence(c: EvidenceChecks): EvidenceClass {
  if (!c.chainBound) return "self-reported";
  if (
    c.drill === "verified" &&
    c.authorship === "verified" &&
    c.grandpaConsistent !== false
  )
    return "chain-observed";
  return "chain-bound";
}

/**
 * Slots from the end of the fault window to the first block the target
 * authored after it; null when authorship is absent, the target never
 * resumed, or it authored during the fault (then the fault did not silence it).
 */
export function recoverySlots(a: AuthorshipEvidence): number | null {
  const endBlock = a.blocks.find((b) => b.number === a.faultEndBlock);
  if (!endBlock) return null;
  let first: { number: number; slot: number } | null = null;
  for (const b of a.blocks) {
    if (b.authorityIndex !== a.targetAuthorityIndex) continue;
    if (b.number >= a.faultStartBlock && b.number <= a.faultEndBlock)
      return null;
    if (
      b.number > a.faultEndBlock &&
      (first === null || b.number < first.number)
    )
      first = b;
  }
  return first ? Math.max(0, first.slot - endBlock.slot) : null;
}

export interface ScoredRunInputV2 extends ScoredRunInput {
  evidenceClass: EvidenceClass;
  /** Chain-derived recovery latency in slots, when authorship is present. */
  recoverySlots: number | null;
}

export function toScoredRunInputV2(
  base: ScoredRunInput,
  chain: ChainEvidence,
  checks: EvidenceChecks,
): ScoredRunInputV2 {
  return {
    ...base,
    evidenceClass: classifyEvidence(checks),
    recoverySlots: chain.authorship ? recoverySlots(chain.authorship) : null,
  };
}

export interface ScoredRunV2 {
  runId: string;
  survived: boolean;
  quality: number;
  weight: number;
  ageDays: number;
  evidenceClass: EvidenceClass;
  recoverySource: "slots" | "wall-clock";
}

export interface ResilienceScoreV2 {
  version: typeof RESILIENCE_SCORE_V2_VERSION;
  validatorId: string;
  score: number;
  quality: number;
  confidence: number;
  effectiveRuns: number;
  runs: number;
  faultsSurvived: number;
  byClass: Record<EvidenceClass, number>;
  asOf: string;
  perRun: ScoredRunV2[];
}

const SURVIVING = new Set(["completed", "completed-with-warnings"]);
const DAY_MS = 86_400_000;

function inverse(value: number | null, ref: number): number {
  if (value === null || !Number.isFinite(value) || value < 0) return 0;
  return 1 / (1 + value / ref);
}

export function computeResilienceScoreV2(
  validatorId: string,
  runs: readonly ScoredRunInputV2[],
  asOf: Date = new Date(),
  slotMs: number = DEFAULT_EXPECTED_BLOCK_TIME_MS,
): ResilienceScoreV2 {
  if (!Number.isFinite(slotMs) || slotMs <= 0)
    throw new KaizenError("INVALID_INPUT", "slotMs must be a positive number");
  const p = RESILIENCE_SCORE_PARAMS;
  const byClass: Record<EvidenceClass, number> = {
    "chain-observed": 0,
    "chain-bound": 0,
    "self-reported": 0,
  };
  const perRun = runs.map((r): ScoredRunV2 => {
    const t = Date.parse(r.certifiedAt);
    if (Number.isNaN(t))
      throw new KaizenError(
        "INVALID_INPUT",
        `invalid certifiedAt for run ${r.runId}`,
      );
    const ageDays = Math.max(0, (asOf.getTime() - t) / DAY_MS);
    const survived = r.recovered && SURVIVING.has(r.runState);
    const fromSlots = r.recoverySlots !== null;
    const recoveryMs = fromSlots
      ? r.recoverySlots! * slotMs
      : r.timeToRecoverMs;
    const quality = survived
      ? p.weights.recovery * inverse(recoveryMs, p.recoveryRefMs) +
        p.weights.finality *
          inverse(r.finalityGapBlocks, p.finalityGapRefBlocks) +
        p.weights.liveness * inverse(r.blocksMissed, p.blocksMissedRefBlocks)
      : 0;
    byClass[r.evidenceClass] += 1;
    return {
      runId: r.runId,
      survived,
      quality,
      weight:
        Math.pow(0.5, ageDays / p.halfLifeDays) *
        EVIDENCE_CLASS_WEIGHT[r.evidenceClass],
      ageDays,
      evidenceClass: r.evidenceClass,
      recoverySource: fromSlots ? "slots" : "wall-clock",
    };
  });
  const weightSum = perRun.reduce((s, r) => s + r.weight, 0);
  const quality =
    weightSum > 0
      ? perRun.reduce((s, r) => s + r.weight * r.quality, 0) / weightSum
      : 0;
  const confidence = 1 - Math.exp(-weightSum / p.confidenceScale);
  return {
    version: RESILIENCE_SCORE_V2_VERSION,
    validatorId,
    score: Math.min(100, Math.max(0, Math.round(100 * quality * confidence))),
    quality,
    confidence,
    effectiveRuns: weightSum,
    runs: runs.length,
    faultsSurvived: perRun.filter((r) => r.survived).length,
    byClass,
    asOf: asOf.toISOString(),
    perRun,
  };
}
