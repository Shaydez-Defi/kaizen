/**
 * Minimal ABI codec for KaizenResilienceRegistry (T-9.4), in the same
 * style as the T-8.2 run-registry codec: selectors derived from signatures
 * and cross-checked against solc's methodIdentifiers in the committed
 * artifact by a unit test, so codec and bytecode cannot drift.
 */

import { blake2AsHex, decodeAddress, keccakAsHex } from '@polkadot/util-crypto';
import { KaizenError } from '../errors';
import type { ResilienceCertificate } from './certificate';

export const RESILIENCE_REGISTRY_SIGNATURES = {
  record: 'record(bytes32,bytes32,bytes32,bytes32,uint32,uint16,uint16,uint8,uint8,bytes)',
  getLatest: 'getLatest(bytes32)',
  getScore: 'getScore(bytes32)',
  certificateCount: 'certificateCount(bytes32)',
  recorded: 'recorded(bytes32)',
  certificateRecordedEvent:
    'CertificateRecorded(bytes32,bytes32,bytes32,bytes32,uint8,uint8,uint32,uint16,uint16,uint64,bytes)',
} as const;

export const UNKNOWN_U32 = 0xffffffff;
export const UNKNOWN_U16 = 0xffff;

/** evidenceFlags bits (docs/RESILIENCE_SCORE.md §7.4). */
export const EVIDENCE_FLAGS = {
  chainBound: 1,
  devKey: 2,
  seededDrill: 4, // planned (v2)
  chainObserved: 8, // planned (v2)
} as const;

export const CERTIFICATE_RECORDED_TOPIC = keccakAsHex(RESILIENCE_REGISTRY_SIGNATURES.certificateRecordedEvent, 256);

const sel = (sig: string): string => keccakAsHex(sig, 256).slice(0, 10);
const strip = (h: string): string => (h.startsWith('0x') ? h.slice(2) : h).toLowerCase();
const word = (n: number | bigint): string => BigInt(n).toString(16).padStart(64, '0');

function b32(hex: string, what: string): string {
  const raw = strip(hex);
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new KaizenError('INVALID_INPUT', `${what} must be 32 bytes of hex`);
  return raw;
}

function uint(value: number | null, max: number, what: string): number {
  if (value === null) return max;
  if (!Number.isInteger(value) || value < 0) throw new KaizenError('INVALID_INPUT', `${what} must be a non-negative integer`);
  return Math.min(value, max - 1); // saturate below the "unknown" sentinel
}

/**
 * On-chain validator key: the 32-byte public key when the id is an SS58
 * address or 0x-hex key, otherwise blake2_256("kaizen:validator:" + id).
 */
export function validatorKey(validatorId: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(validatorId)) return validatorId.toLowerCase();
  try {
    const pk = decodeAddress(validatorId);
    if (pk.length === 32) return `0x${Buffer.from(pk).toString('hex')}`;
  } catch {
    /* not an address */
  }
  return blake2AsHex(`kaizen:validator:${validatorId}`, 256);
}

export interface RecordCallInput {
  validator: string;
  fingerprint: string;
  runHash: string;
  signer: string;
  timeToRecoverMs: number | null;
  finalityGapBlocks: number | null;
  blocksMissed: number | null;
  score: number;
  evidenceFlags: number;
  signature: string;
}

export function encodeRecordCall(i: RecordCallInput): string {
  if (!Number.isInteger(i.score) || i.score < 0 || i.score > 100) throw new KaizenError('INVALID_INPUT', 'score must be 0..100');
  const sig = strip(i.signature);
  if (!/^[0-9a-f]{128}$/.test(sig)) throw new KaizenError('INVALID_INPUT', 'signature must be 64 bytes of hex');
  return (
    sel(RESILIENCE_REGISTRY_SIGNATURES.record) +
    b32(i.validator, 'validator') +
    b32(i.fingerprint, 'fingerprint') +
    b32(i.runHash, 'runHash') +
    b32(i.signer, 'signer') +
    word(uint(i.timeToRecoverMs, UNKNOWN_U32, 'timeToRecoverMs')) +
    word(uint(i.finalityGapBlocks, UNKNOWN_U16, 'finalityGapBlocks')) +
    word(uint(i.blocksMissed, UNKNOWN_U16, 'blocksMissed')) +
    word(i.score) +
    word(i.evidenceFlags & 0xff) +
    word(10 * 32) + // offset of `bytes signature`
    word(64) +
    sig
  );
}

/** Record-call input for a certificate and its computed score. */
export function recordInputFromCertificate(cert: ResilienceCertificate, score: number): RecordCallInput {
  return {
    validator: validatorKey(cert.validatorId),
    fingerprint: cert.fingerprint,
    runHash: cert.runHash,
    signer: cert.signature.publicKey,
    timeToRecoverMs: cert.chain.metrics.timeToRecoverMs,
    finalityGapBlocks: cert.chain.metrics.finalityGapBlocks,
    blocksMissed: cert.chain.metrics.blocksMissed,
    score,
    evidenceFlags: EVIDENCE_FLAGS.chainBound | (cert.signature.dev ? EVIDENCE_FLAGS.devKey : 0),
    signature: cert.signature.signature,
  };
}

export const encodeGetLatestCall = (validator: string): string =>
  sel(RESILIENCE_REGISTRY_SIGNATURES.getLatest) + b32(validator, 'validator');
export const encodeGetScoreCall = (validator: string): string =>
  sel(RESILIENCE_REGISTRY_SIGNATURES.getScore) + b32(validator, 'validator');
export const encodeRecordedCall = (fingerprint: string): string =>
  sel(RESILIENCE_REGISTRY_SIGNATURES.recorded) + b32(fingerprint, 'fingerprint');

function words(data: string, n: number): string[] {
  const raw = strip(data);
  if (raw.length < n * 64 || !/^[0-9a-f]*$/.test(raw)) throw new KaizenError('RPC_ERROR', 'registry returned malformed data');
  return Array.from({ length: n }, (_, i) => raw.slice(i * 64, (i + 1) * 64));
}

const unknownOr = (v: number, max: number): number | null => (v === max ? null : v);

export interface OnChainCertificate {
  fingerprint: string;
  runHash: string;
  signer: string;
  timeToRecoverMs: number | null;
  finalityGapBlocks: number | null;
  blocksMissed: number | null;
  score: number;
  evidenceFlags: number;
  certifiedAt: number;
  submitter: string;
}

export function decodeLatest(data: string): OnChainCertificate {
  const w = words(data, 10);
  const n = (i: number): number => Number(BigInt(`0x${w[i]}`));
  return {
    fingerprint: `0x${w[0]}`,
    runHash: `0x${w[1]}`,
    signer: `0x${w[2]}`,
    timeToRecoverMs: unknownOr(n(3), UNKNOWN_U32),
    finalityGapBlocks: unknownOr(n(4), UNKNOWN_U16),
    blocksMissed: unknownOr(n(5), UNKNOWN_U16),
    score: n(6),
    evidenceFlags: n(7),
    certifiedAt: n(8),
    submitter: `0x${w[9]!.slice(24)}`,
  };
}

export function decodeScore(data: string): { score: number; certifiedAt: number; count: number } {
  const w = words(data, 3).map((x) => Number(BigInt(`0x${x}`)));
  return { score: w[0]!, certifiedAt: w[1]!, count: w[2]! };
}
