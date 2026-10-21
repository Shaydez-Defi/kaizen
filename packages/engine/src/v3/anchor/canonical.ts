/**
 * Deterministic run fingerprint for V3 anchoring (T-8.2).
 *
 * The run hash is `0x` + SHA-256 over the canonical JSON of a versioned
 * envelope `{ kaizenAnchor: 1, run: <ScenarioRunRecord> }`:
 *
 *  - object keys are sorted lexicographically at every depth
 *  - no insignificant whitespace; strings use JSON.stringify escaping
 *  - `undefined` object members are dropped (exactly like JSON), array
 *    holes / `undefined` items become `null` (exactly like JSON)
 *  - non-finite numbers, bigint, functions, and symbols are refused
 *    (a run record never contains them; refusing keeps the hash honest)
 *
 * Only TERMINAL runs are anchorable, and a terminal run record is immutable
 * in SQLite, so the same run always yields the same hash — anyone holding
 * the exported record can recompute it and compare it to the on-chain
 * value (`kaizen v3 verify`).
 */

import { createHash } from 'node:crypto';
import { KaizenError } from '../../errors';
import type { ScenarioRunRecord } from '../../scenario/run-types';

export const KAIZEN_ANCHOR_VERSION = 1 as const;

/** Canonical JSON (sorted keys, no whitespace). Throws on non-JSON values. */
export function canonicalJson(value: unknown): string {
  return encode(value, '$');
}

function encode(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new KaizenError('INVALID_INPUT', `canonicalJson: non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((item, i) => (item === undefined ? 'null' : encode(item, `${path}[${i}]`)))
          .join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(record[k], `${path}.${k}`)}`).join(',')}}`;
    }
    default:
      throw new KaizenError('INVALID_INPUT', `canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

export function sha256Hex(text: string): string {
  return `0x${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** The canonical document that is hashed (exported for `kaizen v3 verify`). */
export function runAnchorDocument(run: ScenarioRunRecord): string {
  return canonicalJson({ kaizenAnchor: KAIZEN_ANCHOR_VERSION, run });
}

/** 0x-prefixed 32-byte hex fingerprint of a run record. */
export function computeRunHash(run: ScenarioRunRecord): string {
  return sha256Hex(runAnchorDocument(run));
}

/**
 * Short, secret-free descriptor stored alongside the hash on chain.
 * Only ids, the scenario name (validated by the scenario model), and the
 * terminal state — never hosts, paths, pids, or evidence payloads.
 * Bounded to 256 bytes (the contract enforces the same limit).
 */
export function runAnchorMeta(run: Pick<ScenarioRunRecord, 'id' | 'scenarioName' | 'state'>): string {
  const safeName = run.scenarioName.replace(/[^\w .-]/g, '_').slice(0, 96);
  const meta = `kaizen:v${KAIZEN_ANCHOR_VERSION}:run=${run.id}:scenario=${safeName}:state=${run.state}`;
  return Buffer.byteLength(meta, 'utf8') <= 256 ? meta : meta.slice(0, 200);
}

/** Payload for the `system.remarkWithEvent` fallback (DEC-027). */
export function remarkPayload(runHash: string, runId: string): string {
  return `kaizen:v${KAIZEN_ANCHOR_VERSION}:${runHash}:${runId}`;
}

export function isBytes32Hex(value: string): boolean {
  return /^0x[0-9a-f]{64}$/.test(value);
}
