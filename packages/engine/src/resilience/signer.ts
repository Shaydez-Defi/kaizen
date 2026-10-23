/**
 * Certificate signer loading (T-9.2).
 *
 * Sources, in order:
 *  1. `KAIZEN_RESILIENCE_SIGNER_SURI` — secret URI in the environment
 *  2. `KAIZEN_RESILIENCE_SIGNER_FILE` — path to a file holding the URI; the
 *     file must live OUTSIDE the repository/working directory (refused
 *     otherwise, so a key can never be committed by accident)
 *  3. DEV fallback — the public `//Alice` test key, ONLY when the caller
 *     explicitly allows it AND the target is a local designated-test
 *     network. Certificates signed this way carry `dev: true` and every
 *     surface labels them "DEV KEY — integrity only, not identity".
 *
 * As with the V3 signer (DEC-026), the secret is never logged, persisted,
 * returned, or placed in an error; only the public address/key leave here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { KaizenError } from '../errors';

export const RESILIENCE_SIGNER_ENV_KEY = 'KAIZEN_RESILIENCE_SIGNER_SURI';
export const RESILIENCE_SIGNER_FILE_ENV_KEY = 'KAIZEN_RESILIENCE_SIGNER_FILE';
/** Well-known public Substrate dev key. NEVER a secret; local networks only. */
export const DEV_RESILIENCE_SIGNER_URI = '//Alice';

export type ResilienceSignerSource = 'env' | 'file' | 'dev';

export interface ResilienceSigner {
  address: string;
  pair: KeyringPair;
  source: ResilienceSignerSource;
  dev: boolean;
}

export interface LoadResilienceSignerOptions {
  env?: NodeJS.ProcessEnv;
  /** Directories a key file must NOT live in (default: process.cwd()). */
  forbiddenRoots?: string[];
  /** Allow the public dev key when nothing is configured. */
  allowDevKey?: boolean;
  /** Required with allowDevKey: the target is a local designated-test network. */
  localTestNetwork?: boolean;
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function pairFrom(uri: string, envKey: string): Promise<KeyringPair> {
  await cryptoWaitReady();
  try {
    return new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(uri.trim());
  } catch {
    throw new KaizenError('RESILIENCE_SIGNER_INVALID', `${envKey} does not hold a valid secret URI (value withheld).`, {
      envKey,
    });
  }
}

export function resilienceSignerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[RESILIENCE_SIGNER_ENV_KEY]?.trim() || env[RESILIENCE_SIGNER_FILE_ENV_KEY]?.trim());
}

export async function loadResilienceSigner(options: LoadResilienceSignerOptions = {}): Promise<ResilienceSigner> {
  const env = options.env ?? process.env;
  const suri = env[RESILIENCE_SIGNER_ENV_KEY];
  if (suri?.trim()) {
    const pair = await pairFrom(suri, RESILIENCE_SIGNER_ENV_KEY);
    return { address: pair.address, pair, source: 'env', dev: false };
  }
  const file = env[RESILIENCE_SIGNER_FILE_ENV_KEY]?.trim();
  if (file) {
    const real = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
    const roots = options.forbiddenRoots ?? [process.cwd()];
    if (roots.some((r) => inside(real, fs.existsSync(r) ? fs.realpathSync(r) : r))) {
      throw new KaizenError(
        'RESILIENCE_SIGNER_INVALID',
        `${RESILIENCE_SIGNER_FILE_ENV_KEY} points inside the working tree; keep signing keys outside the repository.`,
        { envKey: RESILIENCE_SIGNER_FILE_ENV_KEY },
      );
    }
    let content: string;
    try {
      content = fs.readFileSync(real, 'utf8');
    } catch {
      throw new KaizenError('RESILIENCE_SIGNER_INVALID', `${RESILIENCE_SIGNER_FILE_ENV_KEY}: key file is not readable.`, {
        envKey: RESILIENCE_SIGNER_FILE_ENV_KEY,
      });
    }
    const pair = await pairFrom(content, RESILIENCE_SIGNER_FILE_ENV_KEY);
    return { address: pair.address, pair, source: 'file', dev: false };
  }
  if (options.allowDevKey && options.localTestNetwork) {
    const pair = await pairFrom(DEV_RESILIENCE_SIGNER_URI, 'dev key');
    return { address: pair.address, pair, source: 'dev', dev: true };
  }
  throw new KaizenError(
    'RESILIENCE_SIGNER_NOT_CONFIGURED',
    `No certificate signer configured. Export ${RESILIENCE_SIGNER_ENV_KEY} or ${RESILIENCE_SIGNER_FILE_ENV_KEY} (key file outside the repo)` +
      (options.allowDevKey ? '; the public dev key is only allowed for local designated-test networks.' : '.'),
    { envKey: RESILIENCE_SIGNER_ENV_KEY },
  );
}
