/**
 * Chain check for commit-reveal drills (T-9.6 step 3).
 *
 * A certificate may carry `chain.drill`: the on-chain commitment (a
 * `system.remarkWithEvent` in block C naming the validator and a future
 * target block N), the hash of N revealed after N finalized, and the drill
 * that hash seeds. A verifier re-checks, from the chain alone:
 *
 *  1. the reveal arithmetic (N > C, N was finalized, drill == deriveDrill)
 *  2. hash(N) on the chain equals the revealed seed block hash
 *  3. the commit block exists with the recorded hash, and its remark text
 *     is exactly the canonical commit payload
 *  4. the run really executed the seeded fault type
 *
 * Never upgraded: an unreachable chain is `unverifiable`, not `verified`.
 */

import type { ScenarioRunRecord } from "../scenario/run-types";
import { verifyDrillReveal } from "./drill-commit";
import type { DrillReveal } from "./drill-commit";
import type { DrillSeedBounds } from "./drill-seed";
import { ChainUnreachableError } from "./rpc";

export const DRILL_COMMIT_REMARK_PREFIX = "kaizen:drill-commit:v1" as const;

/** Where the commitment sits on chain. */
export interface DrillCommitProof {
  /** Hash of the block C that included the commit remark. */
  blockHash: string;
  extrinsicIndex: number;
}

export interface DrillEvidence extends DrillReveal {
  commit: DrillCommitProof;
}

/** Canonical remark text an operator submits to commit to block N. */
export function drillCommitPayload(
  validatorId: string,
  targetBlock: number,
): string {
  return `${DRILL_COMMIT_REMARK_PREFIX}:${validatorId}:${targetBlock}`;
}

export interface DrillChainReader {
  blockHashAt(number: number): Promise<string | null>;
  /** Text of a `system.remark*` extrinsic at (block, index), else null. */
  remarkAt(blockHash: string, extrinsicIndex: number): Promise<string | null>;
}

export type DrillCheckStatus = "verified" | "mismatch" | "unverifiable";

export interface DrillCheck {
  status: DrillCheckStatus;
  reasons: string[];
}

function runExecutedFault(run: ScenarioRunRecord, faultType: string): boolean {
  return run.steps.some(
    (s) => s.faultType === faultType && s.state !== "skipped",
  );
}

export async function verifyDrillEvidence(
  drill: DrillEvidence,
  reader: DrillChainReader | null,
  run?: ScenarioRunRecord,
  bounds?: DrillSeedBounds,
): Promise<DrillCheck> {
  const mismatches: string[] = [];
  const arithmetic = verifyDrillReveal(drill, bounds);
  mismatches.push(...arithmetic.reasons);
  if (run && !runExecutedFault(run, drill.claimed.faultType))
    mismatches.push(
      `run did not execute the seeded fault (${drill.claimed.faultType})`,
    );
  if (!reader)
    return finish(mismatches, "network offline: no RPC endpoint available");

  const c = drill.commitment;
  try {
    const seed = await reader.blockHashAt(c.targetBlock);
    if (seed === null)
      return finish(
        mismatches,
        `target block #${c.targetBlock} not found on the network`,
      );
    if (seed.toLowerCase() !== drill.seedBlockHash.toLowerCase())
      mismatches.push(
        `hash of target block #${c.targetBlock} differs from the revealed seed`,
      );
    const commitHash = await reader.blockHashAt(c.committedAtBlock);
    if (commitHash === null)
      return finish(
        mismatches,
        `commit block #${c.committedAtBlock} not found on the network`,
      );
    if (commitHash.toLowerCase() !== drill.commit.blockHash.toLowerCase())
      mismatches.push(
        `commit block #${c.committedAtBlock} hash differs from the recorded commit`,
      );
    else {
      const text = await reader.remarkAt(
        drill.commit.blockHash,
        drill.commit.extrinsicIndex,
      );
      const want = drillCommitPayload(c.validatorId, c.targetBlock);
      if (text === null)
        return finish(
          mismatches,
          "commit remark not found at the recorded extrinsic",
        );
      if (text !== want)
        mismatches.push("commit remark text differs from the commitment");
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return finish(
      mismatches,
      e instanceof ChainUnreachableError
        ? `network offline: ${why}`
        : `RPC error: ${why}`,
    );
  }
  return finish(mismatches, null);
}

function finish(mismatches: string[], unverifiable: string | null): DrillCheck {
  if (mismatches.length) return { status: "mismatch", reasons: mismatches };
  if (unverifiable) return { status: "unverifiable", reasons: [unverifiable] };
  return {
    status: "verified",
    reasons: ["commit, seed block hash and seeded drill all match the chain"],
  };
}
