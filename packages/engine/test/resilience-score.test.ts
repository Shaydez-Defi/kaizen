/**
 * Resilience score v1 (T-9.3). The worked examples here are the ones in
 * docs/RESILIENCE_SCORE.md §4 — change both together.
 */

import { describe, expect, it } from 'vitest';
import { RESILIENCE_SCORE_PARAMS, computeResilienceScore, scoreRun, type ScoredRunInput } from '@kaizen/engine';

const asOf = new Date('2026-10-24T00:00:00Z');
const run = (i: number, o: Partial<ScoredRunInput> = {}): ScoredRunInput => ({
  runId: `r${i}`,
  runState: 'completed',
  recovered: true,
  timeToRecoverMs: 12_000,
  finalityGapBlocks: 6,
  blocksMissed: 6,
  certifiedAt: '2026-10-24T00:00:00Z',
  ...o,
});
const many = (n: number, o: Partial<ScoredRunInput> = {}): ScoredRunInput[] => Array.from({ length: n }, (_, i) => run(i, o));
const perfect = { timeToRecoverMs: 0, finalityGapBlocks: 0, blocksMissed: 0 };

describe('computeResilienceScore — spec worked examples', () => {
  it.each([
    ['A: one fresh typical run', [run(1)], 29],
    ['B: five fresh typical runs', many(5), 67],
    ['C: five fresh perfect runs', many(5, perfect), 92],
    ['D: four typical + one failed', [...many(4), run(9, { runState: 'failed', recovered: false })], 54],
    ['E: five typical runs, 30 days old', many(5, { certifiedAt: '2026-09-24T00:00:00Z' }), 52],
    ['F: ten fresh perfect runs', many(10, perfect), 99],
  ])('%s → %i', (_name, runs, expected) => {
    expect(computeResilienceScore('bob', runs, asOf).score).toBe(expected);
  });
});

describe('computeResilienceScore — properties', () => {
  it('scores zero with no certified runs', () => {
    expect(computeResilienceScore('v', [], asOf)).toMatchObject({ score: 0, runs: 0, faultsSurvived: 0, latestCertifiedAt: null });
  });

  it('is deterministic and order-independent', () => {
    const runs = [run(1), run(2, { timeToRecoverMs: 90_000 }), run(3, { certifiedAt: '2026-10-01T00:00:00Z' })];
    const a = computeResilienceScore('v', runs, asOf);
    const b = computeResilienceScore('v', [...runs].reverse(), asOf);
    expect(a.score).toBe(b.score);
    expect(a.quality).toBeCloseTo(b.quality, 12);
    expect(a.latestCertifiedAt).toBe('2026-10-24T00:00:00Z');
  });

  it('is monotonic: faster recovery, smaller gaps, fewer misses never lower the score', () => {
    const base = computeResilienceScore('v', many(5), asOf).score;
    expect(computeResilienceScore('v', many(5, { timeToRecoverMs: 1_000 }), asOf).score).toBeGreaterThanOrEqual(base);
    expect(computeResilienceScore('v', many(5, { finalityGapBlocks: 1 }), asOf).score).toBeGreaterThanOrEqual(base);
    expect(computeResilienceScore('v', many(5, { blocksMissed: 0 }), asOf).score).toBeGreaterThanOrEqual(base);
    expect(computeResilienceScore('v', many(5, { timeToRecoverMs: 600_000 }), asOf).score).toBeLessThan(base);
  });

  it('never counts an unrecovered or cancelled run as survived', () => {
    expect(scoreRun(run(1, { recovered: false }), asOf)).toMatchObject({ survived: false, quality: 0 });
    expect(scoreRun(run(1, { runState: 'cancelled' }), asOf)).toMatchObject({ survived: false, quality: 0 });
    expect(scoreRun(run(1, { runState: 'completed-with-warnings' }), asOf).survived).toBe(true);
  });

  it('treats unknown metrics as worst case and decays with a 30-day half-life', () => {
    const unknown = scoreRun(run(1, { timeToRecoverMs: null, finalityGapBlocks: null, blocksMissed: null }), asOf);
    expect(unknown.quality).toBe(0);
    expect(scoreRun(run(1, { certifiedAt: '2026-09-24T00:00:00Z' }), asOf).weight).toBeCloseTo(0.5, 10);
    expect(scoreRun(run(1, { certifiedAt: '2026-11-24T00:00:00Z' }), asOf).weight).toBe(1); // future → age 0
    expect(RESILIENCE_SCORE_PARAMS.halfLifeDays).toBe(30);
  });

  it('stays within [0, 100] and rejects malformed timestamps', () => {
    const s = computeResilienceScore('v', many(200, perfect), asOf).score;
    expect(s).toBeLessThanOrEqual(100);
    expect(s).toBe(100);
    expect(() => computeResilienceScore('v', [run(1, { certifiedAt: 'yesterday' })], asOf)).toThrow(/invalid certifiedAt/);
  });
});
