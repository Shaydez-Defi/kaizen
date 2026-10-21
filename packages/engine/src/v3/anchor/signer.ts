/**
 * V3 signer loading (T-8.2).
 *
 * Security posture (FR-7, AGENTS.md "Secrets"):
 *  - the secret URI comes ONLY from the environment variable
 *    `KAIZEN_V3_SIGNER_SURI` — never from argv, a request body, a config
 *    file in the repo, or SQLite
 *  - the SURI is never logged, echoed, persisted, or placed in an error;
 *    only the derived PUBLIC address leaves this module
 *  - `scrubSecret()` removes the exact SURI (and its words) from any string
 *    produced while a signer is loaded (defense in depth for library errors)
 */

import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { KaizenError } from '../../errors';
import { redactSecrets } from '../../fault/redact';

export const V3_SIGNER_ENV_KEY = 'KAIZEN_V3_SIGNER_SURI';

export interface V3Signer {
  /** Public SS58 address (prefix 42, as reported by the V3 runtime). */
  address: string;
  /** Signing pair — never serialized. */
  pair: KeyringPair;
  /** Remove any trace of the secret from a string. */
  scrub(text: string): string;
}

/** True when a signer secret is present in the environment (value unread). */
export function v3SignerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[V3_SIGNER_ENV_KEY];
  return raw !== undefined && raw.trim() !== '';
}

export function makeScrubber(secret: string): (text: string) => string {
  const trimmed = secret.trim();
  const words = trimmed.split(/\s+/).filter((w) => w.length >= 4);
  return (text: string): string => {
    let out = text;
    if (trimmed) out = out.split(trimmed).join('[redacted]');
    // A mnemonic fragment (e.g. a library echoing part of a phrase) is
    // scrubbed word by word when 3+ of its words appear in sequence.
    if (words.length >= 3) {
      for (let i = 0; i + 3 <= words.length; i++) {
        const frag = words.slice(i, i + 3).join(' ');
        out = out.split(frag).join('[redacted]');
      }
    }
    return redactSecrets(out);
  };
}

/**
 * Load the signer from `KAIZEN_V3_SIGNER_SURI` (sr25519). Throws
 * V3_SIGNER_NOT_CONFIGURED when unset and V3_SIGNER_INVALID when the value
 * cannot be parsed — neither message contains the value.
 */
export async function loadV3Signer(env: NodeJS.ProcessEnv = process.env): Promise<V3Signer> {
  const raw = env[V3_SIGNER_ENV_KEY];
  if (raw === undefined || raw.trim() === '') {
    throw new KaizenError(
      'V3_SIGNER_NOT_CONFIGURED',
      `No V3 signer configured. Export ${V3_SIGNER_ENV_KEY} (a TESTNET-ONLY secret URI) in the environment of the process that submits anchors.`,
      { envKey: V3_SIGNER_ENV_KEY },
    );
  }
  await cryptoWaitReady();
  const scrub = makeScrubber(raw);
  try {
    const keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
    const pair = keyring.addFromUri(raw.trim());
    return { address: pair.address, pair, scrub };
  } catch {
    throw new KaizenError(
      'V3_SIGNER_INVALID',
      `${V3_SIGNER_ENV_KEY} is set but is not a valid secret URI (value withheld).`,
      { envKey: V3_SIGNER_ENV_KEY },
    );
  }
}
