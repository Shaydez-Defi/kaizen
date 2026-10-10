/**
 * Topology resolution + validation unit tests (T-2.1/T-2.3).
 * Pure functions: no processes, no filesystem, no ports.
 */

import { describe, expect, it } from 'vitest';
import {
  isKaizenError,
  resolveTopology,
  needsAuthorityPatch,
  NETWORK_PRESETS,
  MAX_CUSTOM_NODES,
} from '@kaizen/engine';
import type { CustomTopologyInput } from '@kaizen/engine';

function custom(nodes: CustomTopologyInput['nodes']): CustomTopologyInput {
  return { nodes };
}

describe('resolveTopology — presets', () => {
  it('single-node: dev chain, alice only, no spec needed', () => {
    const plan = resolveTopology('single-node');
    expect(plan.chain).toBe('dev');
    expect(plan.nodes).toHaveLength(1);
    expect(plan.nodes[0]).toMatchObject({ nameSuffix: 'alice', role: 'validator', wellKnownKey: 'alice' });
    expect(needsAuthorityPatch(plan)).toBe(false);
  });

  it('two-node: alice+bob on the unmodified Local Testnet (both genesis authorities)', () => {
    const plan = resolveTopology('two-node');
    expect(plan.chain).toBe('local-spec');
    expect(plan.authorityKeys).toEqual(['alice', 'bob']);
    expect(needsAuthorityPatch(plan)).toBe(false); // genesis already has both
    expect(plan.nodes.map((n) => n.wellKnownKey)).toEqual(['alice', 'bob']);
  });

  it('four-validator: charlie/dave beyond genesis require a patched spec', () => {
    const plan = resolveTopology('four-validator');
    expect(plan.authorityKeys).toEqual(['alice', 'bob', 'charlie', 'dave']);
    expect(needsAuthorityPatch(plan)).toBe(true);
    expect(plan.nodes.every((n) => n.role === 'validator')).toBe(true);
    // Seed first (suffix 'a' = alice) so start order matches bootnode wiring.
    expect(plan.nodes[0]?.wellKnownKey).toBe('alice');
  });

  it('validator-fullnode: three validators plus a keyless full node', () => {
    const plan = resolveTopology('validator-fullnode');
    expect(plan.authorityKeys).toEqual(['alice', 'bob', 'charlie']);
    expect(needsAuthorityPatch(plan)).toBe(true);
    const full = plan.nodes[3];
    expect(full).toMatchObject({ role: 'full', nameSuffix: 'full' });
    expect(full?.wellKnownKey).toBeUndefined();
  });

  it('every preset resolves to a unique-suffix node list', () => {
    for (const preset of NETWORK_PRESETS.filter((p) => p !== 'custom')) {
      const plan = resolveTopology(preset);
      const suffixes = plan.nodes.map((n) => n.suffix);
      expect(new Set(suffixes).size).toBe(suffixes.length);
    }
  });
});

describe('resolveTopology — custom validation', () => {
  it('accepts a mixed custom topology and keeps input order (seed = first node)', () => {
    const plan = resolveTopology(
      'custom',
      custom([
        { name: 'alice', role: 'validator', wellKnownKey: 'alice' },
        { name: 'backup', role: 'validator', wellKnownKey: 'ferdie' },
        { name: 'full-1', role: 'full' },
      ]),
    );
    expect(plan.chain).toBe('local-spec');
    expect(plan.authorityKeys).toEqual(['alice', 'ferdie']);
    expect(needsAuthorityPatch(plan)).toBe(true); // ferdie is no genesis authority
    expect(plan.nodes[0]?.nameSuffix).toBe('alice');
    expect(plan.nodes[2]).toMatchObject({ nameSuffix: 'full-1', role: 'full' });
    expect(plan.nodes[2]?.wellKnownKey).toBeUndefined();
  });

  it('a topology of exactly the genesis authorities needs no patch', () => {
    const plan = resolveTopology(
      'custom',
      custom([
        { name: 'bob-node', role: 'validator', wellKnownKey: 'bob' },
        { name: 'alice-node', role: 'validator', wellKnownKey: 'alice' },
      ]),
    );
    expect(needsAuthorityPatch(plan)).toBe(false);
  });

  it.each([
    [
      'missing nodes',
      undefined,
      /non-empty "nodes" array/,
    ],
    [
      'duplicate node names',
      custom([
        { name: 'a1', role: 'validator', wellKnownKey: 'alice' },
        { name: 'a1', role: 'full' },
      ]),
      /duplicate node name "a1"/,
    ],
    [
      'duplicate well-known keys',
      custom([
        { name: 'v1', role: 'validator', wellKnownKey: 'alice' },
        { name: 'v2', role: 'validator', wellKnownKey: 'alice' },
      ]),
      /duplicate wellKnownKey "alice"/,
    ],
    [
      'validator without key',
      custom([{ name: 'v1', role: 'validator' }]),
      /requires a wellKnownKey/,
    ],
    [
      'unknown key',
      custom([{ name: 'v1', role: 'validator', wellKnownKey: 'mallory' }]),
      /unknown validator wellKnownKey "mallory"/,
    ],
    [
      'full node with key',
      custom([{ name: 'f1', role: 'full', wellKnownKey: 'alice' }]),
      /must not set wellKnownKey/,
    ],
    [
      'no validator at all',
      custom([{ name: 'f1', role: 'full' }]),
      /at least one validator/,
    ],
    [
      'invalid node name',
      custom([{ name: 'Bad Name!', role: 'full' }]),
      /invalid name/,
    ],
    [
      'too many nodes',
      custom(
        Array.from({ length: MAX_CUSTOM_NODES + 1 }, (_, i) => ({
          name: `n${i}`,
          role: 'full' as const,
        })),
      ),
      /at most 8 nodes/,
    ],
  ])('rejects %s', (_label, input, pattern) => {
    try {
      resolveTopology('custom', input);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(isKaizenError(e)).toBe(true);
      if (isKaizenError(e)) {
        expect(e.code).toBe('INVALID_INPUT');
        expect(e.message).toMatch(pattern);
        expect(Array.isArray(e.details?.['problems'])).toBe(true);
      }
    }
  });

  it('rejects unknown presets', () => {
    expect(() => resolveTopology('eight-node' as never)).toThrow(/Unknown preset/);
  });
});
