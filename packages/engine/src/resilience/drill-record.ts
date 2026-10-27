/**
 * Commit-reveal drill record (T-9.6 step 2).
 *
 * The operator commits, at block `commitBlock`, to a future block number
 * `seedBlockNumber`. Once that block is finalized its hash seeds the drill
 * (see drill-seed.ts). The record carries everything a verifier needs to
 * recompute the drill and to check the commitment ordering.
 */

import { KaizenError } from "../errors";
import {
  deriveDrill,
  type DerivedDrill,
  type DrillSeedBounds,
} from "./drill-seed";
import type { FaultType } from "../fault/types";

export const DRILL_RECORD_VERSION = 1 as const;

export interface DrillRecord {
  version: typeof DRILL_RECORD_VERSION;
  validatorId: string;
  /** Block in which the commitment was made. */
  commitBlock: number;
  /** Future block whose hash seeds the drill; must be > commitBlock. */
  seedBlockNumber: number;
  seedBlockHash: string;
  derived: DerivedDrill;
}

export function buildDrillRecord(input: {
  validatorId: string;
  commitBlock: number;
  seedBlockNumber: number;
  seedBlockHash: string;
  catalogue?: readonly FaultType[];
  bounds?: DrillSeedBounds;
}): DrillRecord {
  if (
    !Number.isSafeInteger(input.commitBlock) ||
    !Number.isSafeInteger(input.seedBlockNumber) ||
    input.seedBlockNumber <= input.commitBlock
  ) {
    throw new KaizenError(
      "INVALID_INPUT",
      "seedBlockNumber must be a block after commitBlock",
    );
  }
  return {
    version: DRILL_RECORD_VERSION,
    validatorId: input.validatorId,
    commitBlock: input.commitBlock,
    seedBlockNumber: input.seedBlockNumber,
    seedBlockHash: input.seedBlockHash,
    derived: deriveDrill({
      validatorId: input.validatorId,
      seedBlockHash: input.seedBlockHash,
      catalogue: input.catalogue,
      bounds: input.bounds,
    }),
  };
}

export interface DrillRecordCheck {
  orderingValid: boolean;
  derivationMatches: boolean;
  ok: boolean;
}

/** Offline check: commitment ordering and seed-derivation recomputation. */
export function checkDrillRecord(
  record: DrillRecord,
  opts: { catalogue?: readonly FaultType[]; bounds?: DrillSeedBounds } = {},
): DrillRecordCheck {
  const orderingValid =
    record.version === DRILL_RECORD_VERSION &&
    Number.isSafeInteger(record.commitBlock) &&
    Number.isSafeInteger(record.seedBlockNumber) &&
    record.seedBlockNumber > record.commitBlock;
  let derivationMatches = false;
  try {
    const d = deriveDrill({
      validatorId: record.validatorId,
      seedBlockHash: record.seedBlockHash,
      ...opts,
    });
    derivationMatches =
      d.seed === record.derived.seed &&
      d.faultType === record.derived.faultType &&
      d.startAfterBlocks === record.derived.startAfterBlocks &&
      d.durationMs === record.derived.durationMs;
  } catch {
    derivationMatches = false;
  }
  return {
    orderingValid,
    derivationMatches,
    ok: orderingValid && derivationMatches,
  };
}
