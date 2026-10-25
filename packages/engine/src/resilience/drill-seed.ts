/**
 * Seeded drill derivation (Proof-of-Resilience trust model v2, T-9.6 step 1).
 *
 * A drill's parameters are derived from the hash of a FUTURE block that was
 * committed to before it existed (docs/RESILIENCE_SCORE.md §7.1), so an
 * operator cannot pre-stage or cherry-pick the fault or its timing.
 *
 *   seed = blake2_256("kaizen:drill:v2" ‖ u32le(len(id)) ‖ id ‖ hash(N))
 *
 * bytes 0..3 (u32 BE) pick the fault, 4..7 the start offset in blocks after
 * N, 8..11 the duration. Pure and deterministic: a verifier holding the
 * seed block hash recomputes exactly the same drill.
 */

import { blake2AsU8a } from "@polkadot/util-crypto";
import { KaizenError } from "../errors";
import type { FaultType } from "../fault/types";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const toHex = (u: Uint8Array): string => `0x${Buffer.from(u).toString("hex")}`;
const fromHex = (h: string): Uint8Array =>
  Uint8Array.from(Buffer.from(h.slice(2), "hex"));

export const DRILL_SEED_DOMAIN = "kaizen:drill:v2" as const;

/** Faults verified end-to-end on real nodes (RSK-24: single-host cuts are not). */
export const DEFAULT_DRILL_CATALOGUE: readonly FaultType[] = [
  "pause",
  "terminate",
];

export interface DrillSeedBounds {
  minStartAfterBlocks: number;
  maxStartAfterBlocks: number;
  minDurationMs: number;
  maxDurationMs: number;
}

export const DEFAULT_DRILL_SEED_BOUNDS: DrillSeedBounds = {
  minStartAfterBlocks: 2,
  maxStartAfterBlocks: 10,
  minDurationMs: 20_000,
  maxDurationMs: 60_000,
};

export interface DerivedDrill {
  seed: string;
  faultType: FaultType;
  startAfterBlocks: number;
  durationMs: number;
}

export interface DeriveDrillInput {
  validatorId: string;
  seedBlockHash: string;
  catalogue?: readonly FaultType[];
  bounds?: DrillSeedBounds;
}

function pick(
  seed: Uint8Array,
  offset: number,
  min: number,
  max: number,
): number {
  const v = new DataView(seed.buffer, seed.byteOffset + offset, 4).getUint32(
    0,
    false,
  );
  return min + (v % (max - min + 1));
}

export function deriveDrill(input: DeriveDrillInput): DerivedDrill {
  const catalogue = input.catalogue ?? DEFAULT_DRILL_CATALOGUE;
  const b = input.bounds ?? DEFAULT_DRILL_SEED_BOUNDS;
  if (!input.validatorId)
    throw new KaizenError("INVALID_INPUT", "validatorId is required");
  if (!HASH_RE.test(input.seedBlockHash)) {
    throw new KaizenError(
      "INVALID_INPUT",
      "seedBlockHash must be a 32-byte 0x-hex block hash",
    );
  }
  if (catalogue.length === 0)
    throw new KaizenError("INVALID_INPUT", "drill catalogue is empty");
  const ints = [
    b.minStartAfterBlocks,
    b.maxStartAfterBlocks,
    b.minDurationMs,
    b.maxDurationMs,
  ];
  if (
    ints.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    b.minStartAfterBlocks > b.maxStartAfterBlocks ||
    b.minDurationMs > b.maxDurationMs
  ) {
    throw new KaizenError("INVALID_INPUT", "invalid drill seed bounds");
  }
  const id = utf8(input.validatorId);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, id.length, true);
  const seed = blake2AsU8a(
    Buffer.concat([
      utf8(DRILL_SEED_DOMAIN),
      len,
      id,
      fromHex(input.seedBlockHash),
    ]),
    256,
  );
  return {
    seed: toHex(seed),
    faultType: catalogue[pick(seed, 0, 0, catalogue.length - 1)]!,
    startAfterBlocks: pick(
      seed,
      4,
      b.minStartAfterBlocks,
      b.maxStartAfterBlocks,
    ),
    durationMs: pick(seed, 8, b.minDurationMs, b.maxDurationMs),
  };
}
