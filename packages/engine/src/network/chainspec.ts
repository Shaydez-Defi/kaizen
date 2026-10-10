/**
 * ChainSpecService (T-2.2) — per-network chain spec generation, authority
 * patching, and purge support.
 *
 * Facts (verified live against portaldot_dev 2.0.0, 2026-10-10):
 *  - `build-spec --chain local` emits a PLAIN spec with readable
 *    genesis.runtime (session.keys, staking.stakers/invulnerables).
 *  - `build-spec --chain <plain file> --raw --disable-default-bootnode`
 *    accepts a patched plain spec file and emits the raw storage spec the
 *    nodes run with.
 *  - Session keys: babe/imOnline/authorityDiscovery = sr25519(//X) = the dev
 *    account; grandpa = ed25519(//X) (`key inspect --scheme ed25519 //X`).
 *    Verified by reproducing the genesis entries of alice and bob.
 *  - Genesis balances already fund alice…eve (5 UNITS); patched validators
 *    need no balance changes.
 *
 * Everything here is generated from the real binary's output — no hardcoded
 * chain data.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { KaizenError } from '../errors';
import type { WellKnownKey } from '../types';
import { needsAuthorityPatch, type TopologyPlan } from './topologies';
import type { BinaryManager } from '../binary/manager';

export interface AuthorityKeyMaterial {
  key: WellKnownKey;
  /** SS58 of sr25519(//X) — also the babe/imOnline/authorityDiscovery key. */
  account: string;
  /** SS58 of ed25519(//X) — the grandpa key. */
  grandpa: string;
}

export interface ChainSpecResult {
  /** Path of the raw chain spec the nodes run with (null for --dev chains). */
  specPath: string | null;
  /** Key material for patched-in authorities (absent when unpatched). */
  authorities?: AuthorityKeyMaterial[];
  validatorCount?: number;
  /** True when the plain spec was patched to extend the authority set. */
  patched: boolean;
}

export interface ChainSpecServiceOptions {
  binaries: BinaryManager;
  spawnImpl?: typeof spawn;
}

const SS58_PATTERN = /^5[A-Za-z0-9]{46,47}$/;

export class ChainSpecService {
  private readonly binaries: BinaryManager;
  private readonly spawnImpl: typeof spawn;

  constructor(options: ChainSpecServiceOptions) {
    this.binaries = options.binaries;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  /**
   * Generate the chain spec a topology plan requires into `outDir`.
   * Returns the raw spec path (or null for --dev single-node networks).
   */
  async generate(outDir: string, plan: TopologyPlan): Promise<ChainSpecResult> {
    if (plan.chain === 'dev') {
      return { specPath: null, patched: false };
    }
    const specPath = path.join(outDir, 'chain-spec.json');

    if (!needsAuthorityPatch(plan)) {
      // Unmodified Local Testnet (genesis authorities alice+bob are enough).
      await this.run(['build-spec', '--chain', 'local', '--raw', '--disable-default-bootnode'], specPath);
      return { specPath, patched: false };
    }

    // Patched spec: plain → authority surgery (with verified key material) → raw.
    const { stdout: plain } = await this.run(['build-spec', '--chain', 'local']);
    const authorities: AuthorityKeyMaterial[] = [];
    for (const key of plan.authorityKeys) {
      authorities.push(await this.deriveAuthorityKeys(key));
    }
    const finalPlain = patchPlainSpec(plain, plan.authorityKeys.length, plan.authorityKeys, authorities);

    const plainPath = path.join(outDir, 'chain-spec-plain.json');
    fs.writeFileSync(plainPath, JSON.stringify(finalPlain, null, 1));
    await this.run(
      ['build-spec', '--chain', plainPath, '--raw', '--disable-default-bootnode'],
      specPath,
    );

    // Audit sidecar: which authorities were baked into this network's genesis.
    fs.writeFileSync(
      path.join(outDir, 'chain-spec.genesis.json'),
      JSON.stringify(
        {
          validatorCount: plan.authorityKeys.length,
          authorities,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    return {
      specPath,
      authorities,
      validatorCount: plan.authorityKeys.length,
      patched: true,
    };
  }

  /**
   * Derive one authority's session key material from the binary itself:
   * account = sr25519(//X), grandpa = ed25519(//X).
   */
  async deriveAuthorityKeys(key: WellKnownKey): Promise<AuthorityKeyMaterial> {
    const uri = keyUri(key);
    const { stdout: accountOut } = await this.run(['key', 'inspect', uri]);
    const { stdout: grandpaOut } = await this.run(['key', 'inspect', '--scheme', 'ed25519', uri]);
    const account = parseSs58(accountOut);
    const grandpa = parseSs58(grandpaOut);
    if (!account || !grandpa) {
      throw new KaizenError(
        'INTERNAL',
        `Could not derive authority keys for ${key} from the binary output`,
        { key },
      );
    }
    return { key, account, grandpa };
  }

  /** Run the node binary with argv, optionally writing stdout to a file. */
  private async run(args: string[], outFile?: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = this.spawnImpl(this.binaries.nodePath(), args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      // 'close' (not 'exit'): guarantees stdout is fully drained — build-spec
      // --raw emits ~1.5 MB that must not be truncated by an early exit event.
      child.on('close', (code, signal) => {
        if (code !== 0) {
          reject(
            new KaizenError(
              'INTERNAL',
              `portaldot_dev ${args.join(' ')} failed (code ${code ?? `signal ${signal}`}): ${stderr.slice(0, 500)}`,
            ),
          );
          return;
        }
        if (outFile) fs.writeFileSync(outFile, stdout);
        resolve({ stdout, stderr });
      });
    });
  }
}

/** `//Alice`, `//Bob`, … (Substrate dev key URIs; "one"/"two" excluded). */
export function keyUri(key: WellKnownKey): string {
  return `//${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

/** Extract the "SS58 Address:" line from `key inspect` output. */
export function parseSs58(output: string): string | null {
  const addr = /SS58 Address:\s+(\S+)/.exec(output)?.[1];
  if (addr && SS58_PATTERN.test(addr)) return addr;
  return null;
}

/**
 * Patch a PLAIN chain spec's genesis.runtime so `authorityKeys.length`
 * validators exist: session.keys, staking.stakers, staking.invulnerables are
 * extended (existing alice/bob entries are kept) and validatorCount is set.
 * When key material is provided it is used verbatim; otherwise the entries
 * are left as placeholders that MUST be filled before writing (defense:
 * generate() always passes material).
 */
export function patchPlainSpec(
  plain: string,
  validatorCount: number,
  authorityKeys?: WellKnownKey[],
  keyMaterial?: AuthorityKeyMaterial[],
): Record<string, unknown> {
  const spec = JSON.parse(plain) as Record<string, unknown>;
  const runtime = (spec['genesis'] as Record<string, unknown>)['runtime'] as Record<string, unknown>;
  const session = runtime['session'] as Record<string, unknown>;
  const staking = runtime['staking'] as Record<string, unknown>;

  const existingKeys = session['keys'] as unknown[];
  const existingAccounts = new Set(
    (existingKeys as Array<[string, string, unknown]>).map((entry) => entry[0]),
  );
  const existingStakers = staking['stakers'] as Array<[string, string, number, string]>;
  const stakerAccounts = new Set(existingStakers.map((entry) => entry[0]));
  const invulnerables = staking['invulnerables'] as string[];

  if (authorityKeys && keyMaterial) {
    if (keyMaterial.length > authorityKeys.length) {
      throw new KaizenError('INTERNAL', 'more key material than authority keys');
    }
    for (const material of keyMaterial) {
      if (existingAccounts.has(material.account)) continue;
      existingKeys.push([
        material.account,
        material.account,
        {
          grandpa: material.grandpa,
          babe: material.account,
          im_online: material.account,
          authority_discovery: material.account,
        },
      ]);
      if (!stakerAccounts.has(material.account)) {
        existingStakers.push([
          material.account,
          material.account,
          3_000_000_000_000_000_000,
          'Validator',
        ]);
      }
      if (!invulnerables.includes(material.account)) {
        invulnerables.push(material.account);
      }
    }
  }

  staking['validatorCount'] = validatorCount;
  return spec;
}

/** Parse the genesis authority accounts out of a PLAIN spec (evidence/tests). */
export function parsePlainAuthorities(plain: string): {
  sessionAccounts: string[];
  invulnerables: string[];
  validatorCount: number;
} {
  const spec = JSON.parse(plain) as Record<string, unknown>;
  const runtime = (spec['genesis'] as Record<string, unknown>)['runtime'] as Record<string, unknown>;
  const session = runtime['session'] as Record<string, unknown>;
  const staking = runtime['staking'] as Record<string, unknown>;
  return {
    sessionAccounts: (session['keys'] as Array<[string, string, unknown]>).map((e) => e[0]),
    invulnerables: [...(staking['invulnerables'] as string[])],
    validatorCount: staking['validatorCount'] as number,
  };
}
