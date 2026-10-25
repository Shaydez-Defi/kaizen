/**
 * Commit-reveal drill check (T-9.6 step 2). An operator commits to a future
 * block N before it exists; the drill is whatever deriveDrill gives from
 * hash(N). A verifier checks the ordering and recomputes the drill.
 */

import { KaizenError } from "../errors";
import { deriveDrill } from "./drill-seed";
import type { DerivedDrill, DrillSeedBounds } from "./drill-seed";

export interface DrillCommitment {
  validatorId: string;
  /** Height at which the commitment was recorded on chain. */
  committedAtBlock: number;
  /** Future block whose hash seeds the drill; must be > committedAtBlock. */
  targetBlock: number;
}

export interface DrillReveal {
  commitment: DrillCommitment;
  seedBlockHash: string;
  /** Height of the block that was finalized when the reveal was read. */
  finalizedAtReveal: number;
  claimed: DerivedDrill;
}

export interface DrillRevealResult {
  ok: boolean;
  reasons: string[];
}

export function createDrillCommitment(
  validatorId: string,
  committedAtBlock: number,
  minLeadBlocks = 5,
): DrillCommitment {
  if (!validatorId)
    throw new KaizenError("INVALID_INPUT", "validatorId is required");
  if (!Number.isSafeInteger(committedAtBlock) || committedAtBlock < 0)
    throw new KaizenError(
      "INVALID_INPUT",
      "committedAtBlock must be a block number",
    );
  return {
    validatorId,
    committedAtBlock,
    targetBlock: committedAtBlock + Math.max(1, minLeadBlocks),
  };
}

export function verifyDrillReveal(
  reveal: DrillReveal,
  bounds?: DrillSeedBounds,
): DrillRevealResult {
  const reasons: string[] = [];
  const c = reveal.commitment;
  if (c.targetBlock <= c.committedAtBlock)
    reasons.push("target block was not in the future at commit time");
  if (reveal.finalizedAtReveal < c.targetBlock)
    reasons.push("target block was not finalized at reveal time");
  let expected: DerivedDrill | undefined;
  try {
    expected = deriveDrill({
      validatorId: c.validatorId,
      seedBlockHash: reveal.seedBlockHash,
      bounds,
    });
  } catch (e) {
    reasons.push(e instanceof Error ? e.message : "cannot derive drill");
  }
  if (expected) {
    const k = ["seed", "faultType", "startAfterBlocks", "durationMs"] as const;
    for (const f of k)
      if (expected[f] !== reveal.claimed[f])
        reasons.push(`claimed ${f} does not match the seeded drill`);
  }
  return { ok: reasons.length === 0, reasons };
}
