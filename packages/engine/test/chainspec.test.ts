/**
 * Chain spec surgery unit tests (T-2.2) — pure functions only. The live
 * build-spec/key-inspect flows are covered by the integration suite; here we
 * verify the JSON patching logic against a fixture shaped like the real
 * Portaldot Local Testnet plain spec (verified structure, R-05).
 */

import { describe, expect, it } from 'vitest';
import { isKaizenError, keyUri, parsePlainAuthorities, parseSs58, patchPlainSpec } from '@kaizen/engine';
import type { AuthorityKeyMaterial } from '@kaizen/engine';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const ALICE_GRANDPA = '5FA9nQDVg267DEd8m1ZypXLBnvN7SFxYwV7ndqSYGiN9TTpu';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const BOB_GRANDPA = '5GoNkf6WdbxCFnPdAnYYQyCjAKPJgLNxXwPjwTh6DGg6gN3E';
const CHARLIE = '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y';
const CHARLIE_GRANDPA = '5DbKjhNLpqX3zqZdNBc9BGb4fHU1cRBaDhJUskrvkwfraDi6';

/** Minimal plain spec with the real Local Testnet genesis shape (2 authorities). */
function plainSpec(): string {
  const entry = (account: string, grandpa: string) => [
    account,
    account,
    { grandpa, babe: account, im_online: account, authority_discovery: account },
  ];
  return JSON.stringify({
    name: 'Local Testnet',
    id: 'local_testnet',
    chainType: 'Local',
    genesis: {
      runtime: {
        session: {
          keys: [entry(ALICE, ALICE_GRANDPA), entry(BOB, BOB_GRANDPA)],
        },
        staking: {
          validatorCount: 2,
          minimumValidatorCount: 2,
          invulnerables: [ALICE, BOB],
          stakers: [
            [ALICE, ALICE, 3_000_000_000_000_000_000, 'Validator'],
            [BOB, BOB, 3_000_000_000_000_000_000, 'Validator'],
          ],
        },
        balances: { balances: [[ALICE, 5_000_000_000_000_000_000]] },
      },
    },
  });
}

const charlieMaterial: AuthorityKeyMaterial = {
  key: 'charlie',
  account: CHARLIE,
  grandpa: CHARLIE_GRANDPA,
};

describe('patchPlainSpec', () => {
  it('adds missing authorities to session.keys, stakers, invulnerables; sets validatorCount', () => {
    const patched = patchPlainSpec(plainSpec(), 3, ['alice', 'bob', 'charlie'], [
      { key: 'alice', account: ALICE, grandpa: ALICE_GRANDPA },
      { key: 'bob', account: BOB, grandpa: BOB_GRANDPA },
      charlieMaterial,
    ]);

    const parsed = parsePlainAuthorities(JSON.stringify(patched));
    // alice/bob kept once (no duplicates), charlie appended.
    expect(parsed.sessionAccounts).toEqual([ALICE, BOB, CHARLIE]);
    expect(parsed.invulnerables).toEqual([ALICE, BOB, CHARLIE]);
    expect(parsed.validatorCount).toBe(3);

    const runtime = (patched['genesis'] as { runtime: Record<string, unknown> }).runtime;
    const stakers = (runtime['staking'] as { stakers: Array<[string, string, number, string]> })
      .stakers;
    expect(stakers.map((s) => s[0])).toEqual([ALICE, BOB, CHARLIE]);
    expect(stakers[2]).toEqual([CHARLIE, CHARLIE, 3_000_000_000_000_000_000, 'Validator']);

    // Session key bundle uses the verified derivation: grandpa = ed25519 key,
    // babe/imOnline/authDiscovery = the account itself.
    const keys = (runtime['session'] as { keys: Array<[string, string, Record<string, string>]> })
      .keys;
    expect(keys[2]).toEqual([
      CHARLIE,
      CHARLIE,
      {
        grandpa: CHARLIE_GRANDPA,
        babe: CHARLIE,
        im_online: CHARLIE,
        authority_discovery: CHARLIE,
      },
    ]);
  });

  it('is idempotent — re-patching the same authorities adds nothing', () => {
    const once = patchPlainSpec(plainSpec(), 3, ['alice', 'bob', 'charlie'], [
      { key: 'alice', account: ALICE, grandpa: ALICE_GRANDPA },
      { key: 'bob', account: BOB, grandpa: BOB_GRANDPA },
      charlieMaterial,
    ]);
    const twice = patchPlainSpec(JSON.stringify(once), 3, ['alice', 'bob', 'charlie'], [
      charlieMaterial,
    ]);
    expect(parsePlainAuthorities(JSON.stringify(twice)).sessionAccounts).toEqual([ALICE, BOB, CHARLIE]);
  });

  it('only sets validatorCount when no key material is given', () => {
    const patched = patchPlainSpec(plainSpec(), 4);
    const parsed = parsePlainAuthorities(JSON.stringify(patched));
    expect(parsed.validatorCount).toBe(4);
    expect(parsed.sessionAccounts).toEqual([ALICE, BOB]);
  });

  it('rejects more key material than authority keys defensively', () => {
    try {
      patchPlainSpec(plainSpec(), 2, ['alice', 'bob'], [
        charlieMaterial,
        charlieMaterial,
        charlieMaterial,
      ]);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(isKaizenError(e)).toBe(true);
    }
  });
});

describe('parseSs58 / keyUri', () => {
  it('extracts the SS58 Address line from key inspect output', () => {
    const output = [
      "Secret Key URI `//Alice` is account:",
      '  Secret seed:       0xe5be…',
      '  Public key (hex):  0xd435…',
      '  Public key (SS58): 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
      `  Account ID:        0xd435…`,
      `  SS58 Address:      ${ALICE}`,
      '',
    ].join('\n');
    expect(parseSs58(output)).toBe(ALICE);
  });

  it('returns null when no valid SS58 is present', () => {
    expect(parseSs58('error: no such key')).toBeNull();
    expect(parseSs58('SS58 Address:      not-an-address')).toBeNull();
  });

  it('maps well-known keys to Substrate dev URIs', () => {
    expect(keyUri('alice')).toBe('//Alice');
    expect(keyUri('bob')).toBe('//Bob');
    expect(keyUri('ferdie')).toBe('//Ferdie');
  });
});
