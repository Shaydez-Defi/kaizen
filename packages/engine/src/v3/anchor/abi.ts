/**
 * Minimal Solidity ABI codec for KaizenRunRegistry (T-8.2).
 *
 * The registry has exactly three entry points and one event, so a tiny
 * hand-written codec (keccak from @polkadot/util-crypto, already a
 * transitive dependency of @polkadot/api) replaces a full ethers/viem
 * dependency. Selectors are derived from the signatures at load time and a
 * unit test cross-checks them against solc's `methodIdentifiers` in the
 * committed artifact, so codec and bytecode cannot silently drift.
 */

import { keccakAsHex } from '@polkadot/util-crypto';
import { KaizenError } from '../../errors';

export const REGISTRY_SIGNATURES = {
  anchor: 'anchor(bytes32,string)',
  anchoredAt: 'anchoredAt(bytes32)',
  totalAnchors: 'totalAnchors()',
  runAnchoredEvent: 'RunAnchored(bytes32,address,uint64,string)',
} as const;

export function selectorOf(signature: string): string {
  return keccakAsHex(signature, 256).slice(0, 10);
}

/** topic0 of the RunAnchored event. */
export const RUN_ANCHORED_TOPIC = keccakAsHex(REGISTRY_SIGNATURES.runAnchoredEvent, 256);

function strip0x(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

function word(n: number | bigint): string {
  return BigInt(n).toString(16).padStart(64, '0');
}

function assertBytes32(hex: string, what: string): string {
  const raw = strip0x(hex).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    throw new KaizenError('INVALID_INPUT', `${what} must be 32 bytes of hex`);
  }
  return raw;
}

/** calldata for anchor(bytes32 runHash, string meta). */
export function encodeAnchorCall(runHash: string, meta: string): string {
  const hash = assertBytes32(runHash, 'runHash');
  const bytes = Buffer.from(meta, 'utf8');
  if (bytes.length > 256) throw new KaizenError('INVALID_INPUT', 'meta exceeds 256 bytes');
  const padded = bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0');
  return `${selectorOf(REGISTRY_SIGNATURES.anchor)}${hash}${word(64)}${word(bytes.length)}${padded}`;
}

/** calldata for anchoredAt(bytes32). */
export function encodeAnchoredAtCall(runHash: string): string {
  return `${selectorOf(REGISTRY_SIGNATURES.anchoredAt)}${assertBytes32(runHash, 'runHash')}`;
}

/** Decode a single uint return word (anchoredAt / totalAnchors). */
export function decodeUintReturn(data: string): bigint {
  const raw = strip0x(data);
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new KaizenError('RPC_ERROR', 'registry returned malformed uint data');
  }
  return BigInt(`0x${raw}`);
}

export interface RegistryLog {
  /** Emitting contract (H160, lowercase 0x hex). */
  contract: string;
  topics: string[];
  data: string;
}

export interface DecodedRunAnchored {
  runHash: string;
  submitter: string;
  anchoredAt: bigint;
  meta: string;
}

/** Decode a RunAnchored log; null when the log is not a RunAnchored event. */
export function decodeRunAnchoredLog(log: RegistryLog): DecodedRunAnchored | null {
  const [t0, t1, t2] = log.topics.map((t) => t.toLowerCase());
  if (t0 !== RUN_ANCHORED_TOPIC || !t1 || !t2) return null;
  const data = strip0x(log.data);
  if (data.length < 64 * 3) return null;
  const anchoredAt = BigInt(`0x${data.slice(0, 64)}`);
  const offset = Number(BigInt(`0x${data.slice(64, 128)}`)) * 2;
  const len = Number(BigInt(`0x${data.slice(offset, offset + 64)}`));
  const metaHex = data.slice(offset + 64, offset + 64 + len * 2);
  if (metaHex.length !== len * 2) return null;
  return {
    runHash: t1,
    submitter: `0x${t2.slice(26)}`,
    anchoredAt,
    meta: Buffer.from(metaHex, 'hex').toString('utf8'),
  };
}
