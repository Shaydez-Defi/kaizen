/**
 * BABE block-authorship decoding (T-9.6 / A1).
 *
 * Every BABE block header carries a PreRuntime digest log with engine id
 * "BABE". Its payload is a SCALE `PreDigest`: a variant byte (1 primary,
 * 2 secondary-plain, 3 secondary-VRF), the authority index (u32 LE) and the
 * slot (u64 LE). This module decodes that payload offline, without a node.
 */
import { KaizenError } from "../errors";

export const BABE_ENGINE_ID = "0x42414245";

export type BabeSlotKind = "primary" | "secondary-plain" | "secondary-vrf";

export interface BabeAuthorship {
  kind: BabeSlotKind;
  /** Index into the epoch's BABE authority set. */
  authorityIndex: number;
  /** Slot number (decimal string; u64 may exceed Number.MAX_SAFE_INTEGER). */
  slot: string;
}

const KINDS: Record<number, BabeSlotKind> = {
  1: "primary",
  2: "secondary-plain",
  3: "secondary-vrf",
};

/** Decode a BABE PreDigest from its 0x-hex payload. */
export function decodeBabePreDigest(hex: string): BabeAuthorship {
  if (!/^0x([0-9a-fA-F]{2})+$/.test(hex))
    throw new KaizenError(
      "INVALID_INPUT",
      "BABE pre-digest must be 0x-hex bytes",
    );
  const buf = Buffer.from(hex.slice(2), "hex");
  const kind = KINDS[buf[0] ?? 0];
  if (!kind)
    throw new KaizenError(
      "INVALID_INPUT",
      `unknown BABE pre-digest variant ${buf[0]}`,
    );
  if (buf.length < 13)
    throw new KaizenError("INVALID_INPUT", "BABE pre-digest too short");
  return {
    kind,
    authorityIndex: buf.readUInt32LE(1),
    slot: buf.readBigUInt64LE(5).toString(),
  };
}

/**
 * Find and decode the BABE authorship in a header's digest logs (0x-hex of
 * SCALE `DigestItem`s as returned by `chain_getHeader`). Returns null when the
 * header carries no BABE pre-runtime item.
 */
export function babeAuthorshipFromLogs(
  logs: readonly string[],
): BabeAuthorship | null {
  for (const log of logs) {
    // DigestItem::PreRuntime = 6, then engine id (4 bytes), then compact-length bytes.
    if (!log.startsWith("0x06" + BABE_ENGINE_ID.slice(2))) continue;
    const rest = Buffer.from(log.slice(2 + 2 + 8), "hex");
    const mode = (rest[0] ?? 0) & 3;
    const skip = mode === 0 ? 1 : mode === 1 ? 2 : 4;
    return decodeBabePreDigest("0x" + rest.subarray(skip).toString("hex"));
  }
  return null;
}
