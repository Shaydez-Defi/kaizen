/**
 * BABE authorship evidence (T-9.7), decoded from block headers alone.
 *
 * Every BABE block carries a PreRuntime digest naming the authority index
 * and slot that produced it. Reading a window of headers around a fault
 * therefore shows, from the chain itself, whether the faulted validator
 * stopped authoring while the fault was active and resumed after
 * recovery. Decoding is not the point (block explorers do it); what Kaizen
 * adds is the claim "authored again after the injected fault", recomputable
 * by anyone from the recorded block numbers (`verifyAuthorship`).
 *
 * Digest layout (SCALE): DigestItem::PreRuntime = 0x06, engine id "BABE",
 * compact-length payload; payload = PreDigest enum byte (1 primary,
 * 2 secondary-plain, 3 secondary-VRF) ‖ u32le authority index ‖ u64le slot.
 */

import { KaizenError } from "../errors";
import type { ChainEvidence } from "./evidence";

export interface BabeDigest {
  kind: "primary" | "secondary-plain" | "secondary-vrf";
  authorityIndex: number;
  slot: number;
}

const KINDS = [null, "primary", "secondary-plain", "secondary-vrf"] as const;
const BABE_ENGINE = "42414245";

function bytesOf(hex: string): Buffer {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex))
    throw new KaizenError("INVALID_INPUT", "digest log must be 0x-hex");
  return Buffer.from(hex.slice(2), "hex");
}

/** SCALE compact length at buf[at]; returns [value, bytesUsed]. */
function compact(buf: Buffer, at: number): [number, number] {
  const b = buf[at];
  if (b === undefined)
    throw new KaizenError("INVALID_INPUT", "truncated digest");
  const mode = b & 3;
  if (mode === 0) return [b >> 2, 1];
  if (mode === 1) return [(buf.readUInt16LE(at) >> 2) >>> 0, 2];
  if (mode === 2) return [(buf.readUInt32LE(at) >>> 2) >>> 0, 4];
  throw new KaizenError("INVALID_INPUT", "digest payload too large");
}

/** The BABE pre-runtime digest in a header's digest logs, or null (not a BABE block). */
export function decodeBabePreDigest(
  logs: readonly string[],
): BabeDigest | null {
  for (const log of logs) {
    const buf = bytesOf(log);
    if (buf[0] !== 0x06 || buf.subarray(1, 5).toString("hex") !== BABE_ENGINE)
      continue;
    const [len, used] = compact(buf, 5);
    const p = buf.subarray(5 + used, 5 + used + len);
    const kind = KINDS[p[0] ?? 0];
    if (!kind || p.length < 13)
      throw new KaizenError("INVALID_INPUT", "unrecognised BABE pre-digest");
    const slot = Number(p.readBigUInt64LE(5));
    if (!Number.isSafeInteger(slot))
      throw new KaizenError("INVALID_INPUT", "slot out of range");
    return { kind, authorityIndex: p.readUInt32LE(1), slot };
  }
  return null;
}

export interface AuthoredBlock {
  number: number;
  hash: string;
  authorityIndex: number;
  slot: number;
}

export interface HeaderSource {
  blockHashAt(number: number): Promise<string | null>;
  /** `digest.logs` of the header with this hash, or null if unknown. */
  digestLogs(hash: string): Promise<string[] | null>;
}

export function createHttpHeaderSource(
  url: string,
  timeoutMs = 8_000,
): HeaderSource {
  async function call(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  }
  return {
    async blockHashAt(n) {
      const r = await call("chain_getBlockHash", [n]);
      return typeof r === "string" ? r.toLowerCase() : null;
    },
    async digestLogs(hash) {
      const h = (await call("chain_getHeader", [hash])) as {
        digest?: { logs?: string[] };
      } | null;
      return h?.digest?.logs ?? null;
    },
  };
}

/** Read authorship for blocks [from, to]; blocks without a BABE digest are skipped. */
export async function readAuthorship(
  src: HeaderSource,
  from: number,
  to: number,
): Promise<AuthoredBlock[]> {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 1 ||
    to < from
  )
    throw new KaizenError("INVALID_INPUT", "invalid block range");
  if (to - from > 2_000)
    throw new KaizenError("INVALID_INPUT", "block range too large (max 2000)");
  const out: AuthoredBlock[] = [];
  for (let n = from; n <= to; n++) {
    const hash = await src.blockHashAt(n);
    if (!hash) throw new KaizenError("INVALID_INPUT", `no block #${n}`);
    const logs = await src.digestLogs(hash);
    if (!logs) throw new KaizenError("INVALID_INPUT", `no header for #${n}`);
    const d = decodeBabePreDigest(logs);
    if (d)
      out.push({
        number: n,
        hash,
        authorityIndex: d.authorityIndex,
        slot: d.slot,
      });
  }
  return out;
}

export interface AuthorshipSummary {
  blocks: number;
  /** authority index → blocks authored in the window. */
  byAuthority: Record<string, number>;
  /** Slots with no block between the first and last authored slot. */
  emptySlots: number;
  target: {
    authorityIndex: number;
    authoredBefore: number;
    authoredDuring: number;
    authoredAfter: number;
    /** First block the target authored after the fault window, or null. */
    resumedAtBlock: number | null;
  };
}

/**
 * Pure summary. `faultStartBlock`/`faultEndBlock` bound the fault window in
 * block numbers (blocks <  start are "before", > end are "after").
 */
export function summarizeAuthorship(
  blocks: readonly AuthoredBlock[],
  targetAuthorityIndex: number,
  faultStartBlock: number,
  faultEndBlock: number,
): AuthorshipSummary {
  if (faultEndBlock < faultStartBlock)
    throw new KaizenError(
      "INVALID_INPUT",
      "fault window ends before it starts",
    );
  const byAuthority: Record<string, number> = {};
  let before = 0;
  let during = 0;
  let after = 0;
  let resumed: number | null = null;
  for (const b of blocks) {
    byAuthority[String(b.authorityIndex)] =
      (byAuthority[String(b.authorityIndex)] ?? 0) + 1;
    if (b.authorityIndex !== targetAuthorityIndex) continue;
    if (b.number < faultStartBlock) before++;
    else if (b.number <= faultEndBlock) during++;
    else {
      after++;
      if (resumed === null || b.number < resumed) resumed = b.number;
    }
  }
  const slots = blocks.map((b) => b.slot);
  const emptySlots = slots.length
    ? Math.max(
        0,
        Math.max(...slots) - Math.min(...slots) + 1 - new Set(slots).size,
      )
    : 0;
  return {
    blocks: blocks.length,
    byAuthority,
    emptySlots,
    target: {
      authorityIndex: targetAuthorityIndex,
      authoredBefore: before,
      authoredDuring: during,
      authoredAfter: after,
      resumedAtBlock: resumed,
    },
  };
}

export interface AuthorshipCheck {
  status: "verified" | "mismatch" | "unverifiable";
  reasons: string[];
}

/** Re-read the recorded blocks from the chain and compare hash, author and slot. */
export async function verifyAuthorship(
  recorded: readonly AuthoredBlock[],
  src: HeaderSource | null,
): Promise<AuthorshipCheck> {
  if (!src)
    return {
      status: "unverifiable",
      reasons: ["network offline: no RPC endpoint"],
    };
  const reasons: string[] = [];
  try {
    for (const r of recorded) {
      const hash = await src.blockHashAt(r.number);
      if (!hash) {
        return {
          status: "unverifiable",
          reasons: [`block #${r.number} not found on the network`],
        };
      }
      if (hash.toLowerCase() !== r.hash.toLowerCase()) {
        reasons.push(`#${r.number} hash differs from the recorded block`);
        continue;
      }
      const logs = await src.digestLogs(hash);
      const d = logs ? decodeBabePreDigest(logs) : null;
      if (!d || d.authorityIndex !== r.authorityIndex || d.slot !== r.slot)
        reasons.push(`#${r.number} author/slot differs from the header digest`);
    }
  } catch (e) {
    return {
      status: "unverifiable",
      reasons: [`RPC error: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  return reasons.length
    ? { status: "mismatch", reasons }
    : {
        status: "verified",
        reasons: [`${recorded.length} header digests match the chain`],
      };
}

/** Authorship record carried in `ChainEvidence.authorship` (part of the fingerprint). */
export interface AuthorshipEvidence {
  targetAuthorityIndex: number;
  faultStartBlock: number;
  faultEndBlock: number;
  /** Every BABE block in [windowFrom, windowTo], contiguous. */
  windowFrom: number;
  windowTo: number;
  blocks: AuthoredBlock[];
}

/**
 * Block window derived from the recorded observations alone: from the
 * pre-fault best head to the post-recovery best head; the fault window is
 * the blocks after the last pre-fault head up to the last during-fault head.
 */
export function authorshipWindow(evidence: ChainEvidence): {
  windowFrom: number;
  windowTo: number;
  faultStartBlock: number;
  faultEndBlock: number;
} | null {
  const nums = (phase: string): number[] =>
    evidence.observations
      .filter((o) => o.phase === phase)
      .map((o) => o.best.number);
  const before = nums("before-fault");
  const during = nums("during-fault");
  const after = nums("after-recovery");
  if (!before.length || !after.length) return null;
  const faultStartBlock = Math.max(...before) + 1;
  const faultEndBlock = Math.max(faultStartBlock, ...during);
  const windowTo = Math.max(...after);
  if (windowTo < faultEndBlock) return null;
  return {
    windowFrom: Math.max(1, Math.min(...before)),
    windowTo,
    faultStartBlock,
    faultEndBlock,
  };
}

export async function buildAuthorshipEvidence(
  src: HeaderSource,
  evidence: ChainEvidence,
  targetAuthorityIndex: number,
): Promise<AuthorshipEvidence> {
  const w = authorshipWindow(evidence);
  if (!w)
    throw new KaizenError(
      "RESILIENCE_NOT_CERTIFIABLE",
      "evidence has no before-fault and after-recovery observations to bound an authorship window",
    );
  if (!Number.isSafeInteger(targetAuthorityIndex) || targetAuthorityIndex < 0)
    throw new KaizenError(
      "INVALID_INPUT",
      "targetAuthorityIndex must be a non-negative integer",
    );
  const blocks = await readAuthorship(src, w.windowFrom, w.windowTo);
  return { targetAuthorityIndex, ...w, blocks };
}

/** Check a certificate's authorship record: window derivable, contiguous, and equal to the chain. */
export async function verifyAuthorshipEvidence(
  a: AuthorshipEvidence,
  evidence: ChainEvidence,
  src: HeaderSource | null,
): Promise<AuthorshipCheck> {
  const w = authorshipWindow(evidence);
  const reasons: string[] = [];
  if (
    !w ||
    w.windowFrom !== a.windowFrom ||
    w.windowTo !== a.windowTo ||
    w.faultStartBlock !== a.faultStartBlock ||
    w.faultEndBlock !== a.faultEndBlock
  )
    reasons.push("authorship window does not match the recorded observations");
  const numbers = new Set(a.blocks.map((b) => b.number));
  if (numbers.size !== a.blocks.length)
    reasons.push("duplicate blocks in authorship record");
  for (let n = a.windowFrom; n <= a.windowTo; n++)
    if (!numbers.has(n)) {
      reasons.push(
        `block #${n} missing from the authorship window (cherry-picked?)`,
      );
      break;
    }
  const onChain = await verifyAuthorship(a.blocks, src);
  if (reasons.length)
    return { status: "mismatch", reasons: [...reasons, ...onChain.reasons] };
  return onChain;
}
