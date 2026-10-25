/**
 * GRANDPA finality-quorum evidence (T-9.7 step 2).
 *
 * Finality needs precommits from MORE than 2/3 of the authority weight
 * (threshold = total - floor((total - 1) / 3)). On a two-authority network
 * the threshold is 2, so pausing either validator MUST stall finality; on
 * four authorities it is 3, so one paused validator must not. Kaizen reads
 * the authority set and set id from chain state at a finalized block,
 * derives the predicted outcome, and records it next to the finality
 * behaviour actually observed. A verifier re-reads the state at the same
 * block hash and recomputes both; disagreement between prediction and
 * observation is reported, never hidden.
 */

import { xxhashAsHex } from "@polkadot/util-crypto";
import { KaizenError } from "../errors";
import type { BlockRef, ChainEvidence } from "./evidence";

export interface GrandpaAuthority {
  /** 0x-prefixed 32-byte ed25519 authority key. */
  id: string;
  weight: number;
}

export interface GrandpaQuorumEvidence {
  /** Finalized block the state was read at. */
  at: BlockRef;
  setId: number;
  authorities: GrandpaAuthority[];
  totalWeight: number;
  thresholdWeight: number;
  /** Index (into `authorities`) of the authority the fault stopped. */
  targetIndex: number;
  /** Weight left when the target is down. */
  remainingWeight: number;
  /** remainingWeight < thresholdWeight: finality is expected to stall. */
  predictedStall: boolean;
}

export interface StateSource {
  /** Runtime API call at a block; returns the 0x result. */
  stateCall(method: string, data: string, blockHash: string): Promise<string>;
  /** Raw storage value at a block, or null. */
  storage(key: string, blockHash: string): Promise<string | null>;
}

export function createHttpStateSource(
  url: string,
  timeoutMs = 8_000,
): StateSource {
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
    async stateCall(method, data, hash) {
      const r = await call("state_call", [method, data, hash]);
      if (typeof r !== "string") throw new Error(`${method}: no result`);
      return r;
    },
    async storage(key, hash) {
      const r = await call("state_getStorage", [key, hash]);
      return typeof r === "string" ? r : null;
    },
  };
}

export const GRANDPA_AUTHORITIES_CALL = "GrandpaApi_grandpa_authorities";
export const GRANDPA_SET_ID_KEY = `${xxhashAsHex("Grandpa", 128)}${xxhashAsHex("CurrentSetId", 128).slice(2)}`;

/** SCALE: compact(n) ‖ n × (32-byte id ‖ u64le weight). */
export function decodeGrandpaAuthorities(hex: string): GrandpaAuthority[] {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex))
    throw new KaizenError("INVALID_INPUT", "authorities must be 0x-hex");
  const b = Buffer.from(hex.slice(2), "hex");
  const mode = (b[0] ?? 0) & 3;
  if (mode !== 0)
    throw new KaizenError(
      "INVALID_INPUT",
      "unsupported authority count encoding",
    );
  const n = (b[0] ?? 0) >> 2;
  if (b.length !== 1 + n * 40)
    throw new KaizenError(
      "INVALID_INPUT",
      "authority list has the wrong length",
    );
  const out: GrandpaAuthority[] = [];
  for (let i = 0; i < n; i++) {
    const o = 1 + i * 40;
    const weight = Number(b.readBigUInt64LE(o + 32));
    out.push({ id: `0x${b.subarray(o, o + 32).toString("hex")}`, weight });
  }
  return out;
}

export function decodeSetId(hex: string | null): number {
  if (!hex || !/^0x[0-9a-fA-F]{16}$/.test(hex))
    throw new KaizenError(
      "INVALID_INPUT",
      "set id must be a u64 storage value",
    );
  return Number(Buffer.from(hex.slice(2), "hex").readBigUInt64LE(0));
}

/** GRANDPA: finality needs total - floor((total - 1) / 3) weight. */
export function grandpaThreshold(totalWeight: number): number {
  return totalWeight - Math.floor((totalWeight - 1) / 3);
}

export function quorumFrom(
  at: BlockRef,
  setId: number,
  authorities: GrandpaAuthority[],
  targetIndex: number,
): GrandpaQuorumEvidence {
  const target = authorities[targetIndex];
  if (!target)
    throw new KaizenError(
      "INVALID_INPUT",
      `no GRANDPA authority at index ${targetIndex}`,
    );
  const totalWeight = authorities.reduce((s, a) => s + a.weight, 0);
  const thresholdWeight = grandpaThreshold(totalWeight);
  const remainingWeight = totalWeight - target.weight;
  return {
    at,
    setId,
    authorities,
    totalWeight,
    thresholdWeight,
    targetIndex,
    remainingWeight,
    predictedStall: remainingWeight < thresholdWeight,
  };
}

export async function readGrandpaQuorum(
  src: StateSource,
  at: BlockRef,
  targetIndex: number,
): Promise<GrandpaQuorumEvidence> {
  const authorities = decodeGrandpaAuthorities(
    await src.stateCall(GRANDPA_AUTHORITIES_CALL, "0x", at.hash),
  );
  const setId = decodeSetId(await src.storage(GRANDPA_SET_ID_KEY, at.hash));
  return quorumFrom(at, setId, authorities, targetIndex);
}

/**
 * Did finality stall? True when no during-fault observation shows a
 * finalized head above the highest pre-fault finalized head.
 */
export function observedFinalityStall(evidence: ChainEvidence): boolean | null {
  const pre = evidence.observations.filter((o) => o.phase === "before-fault");
  const during = evidence.observations.filter(
    (o) => o.phase === "during-fault",
  );
  if (!pre.length || !during.length) return null;
  const base = Math.max(...pre.map((o) => o.finalized.number));
  return during.every((o) => o.finalized.number <= base);
}

/** The finalized block the quorum is read at: the last pre-fault finalized head. */
export function quorumBlock(evidence: ChainEvidence): BlockRef | null {
  const pre = evidence.observations.filter((o) => o.phase === "before-fault");
  if (!pre.length) return null;
  return pre.reduce(
    (m, o) => (o.finalized.number > m.number ? o.finalized : m),
    pre[0]!.finalized,
  );
}

export async function buildGrandpaQuorum(
  src: StateSource,
  evidence: ChainEvidence,
  targetIndex: number,
): Promise<GrandpaQuorumEvidence> {
  const at = quorumBlock(evidence);
  if (!at)
    throw new KaizenError(
      "RESILIENCE_NOT_CERTIFIABLE",
      "evidence has no before-fault observation to read the GRANDPA set at",
    );
  return readGrandpaQuorum(src, at, targetIndex);
}

export interface GrandpaCheck {
  status: "verified" | "mismatch" | "unverifiable";
  reasons: string[];
  /** Prediction vs observation: null when either is unknown. */
  consistent: boolean | null;
}

export async function verifyGrandpaQuorum(
  q: GrandpaQuorumEvidence,
  evidence: ChainEvidence,
  src: StateSource | null,
): Promise<GrandpaCheck> {
  const reasons: string[] = [];
  const want = quorumBlock(evidence);
  if (!want || want.hash !== q.at.hash || want.number !== q.at.number)
    reasons.push(
      "quorum block is not the last pre-fault finalized head in the observations",
    );
  let recomputed: GrandpaQuorumEvidence | null = null;
  try {
    recomputed = quorumFrom(q.at, q.setId, q.authorities, q.targetIndex);
  } catch (e) {
    reasons.push(e instanceof Error ? e.message : "invalid quorum evidence");
  }
  if (
    recomputed &&
    (recomputed.totalWeight !== q.totalWeight ||
      recomputed.thresholdWeight !== q.thresholdWeight ||
      recomputed.remainingWeight !== q.remainingWeight ||
      recomputed.predictedStall !== q.predictedStall)
  )
    reasons.push("recorded quorum arithmetic does not match the authority set");
  const observed = observedFinalityStall(evidence);
  const consistent = observed === null ? null : observed === q.predictedStall;
  if (reasons.length) return { status: "mismatch", reasons, consistent };
  if (!src)
    return {
      status: "unverifiable",
      reasons: ["network offline: no RPC endpoint"],
      consistent,
    };
  try {
    const chain = await readGrandpaQuorum(src, q.at, q.targetIndex);
    if (chain.setId !== q.setId)
      reasons.push("set id differs from chain state");
    if (JSON.stringify(chain.authorities) !== JSON.stringify(q.authorities))
      reasons.push("authority set differs from chain state");
  } catch (e) {
    return {
      status: "unverifiable",
      reasons: [
        `state not readable at the recorded block: ${e instanceof Error ? e.message : String(e)}`,
      ],
      consistent,
    };
  }
  if (reasons.length) return { status: "mismatch", reasons, consistent };
  return {
    status: "verified",
    reasons: [
      `set ${q.setId}: ${q.authorities.length} authorities, threshold ${q.thresholdWeight}/${q.totalWeight}; ` +
        `${q.predictedStall ? "finality predicted to stall" : "finality predicted to survive"} one down` +
        (consistent === null
          ? ""
          : consistent
            ? ", matching what was observed"
            : ", but the observation DISAGREES"),
    ],
    consistent,
  };
}
