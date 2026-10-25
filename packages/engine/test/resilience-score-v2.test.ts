import { describe, expect, it } from "vitest";
import {
  classifyEvidence,
  computeResilienceScore,
  computeResilienceScoreV2,
  recoverySlots,
  type AuthorshipEvidence,
  type ScoredRunInputV2,
} from "@kaizen/engine";
import { hashOf } from "./resilience-fixtures";

const NOW = new Date("2026-10-25T12:00:00Z");

function run(over: Partial<ScoredRunInputV2> = {}): ScoredRunInputV2 {
  return {
    runId: "r1",
    runState: "completed",
    recovered: true,
    timeToRecoverMs: 12_000,
    finalityGapBlocks: 6,
    blocksMissed: 6,
    certifiedAt: NOW.toISOString(),
    evidenceClass: "chain-bound",
    recoverySlots: null,
    ...over,
  };
}

const ok = {
  drill: "verified",
  authorship: "verified",
  grandpaConsistent: true,
  chainBound: true,
} as const;

describe("classifyEvidence", () => {
  it("requires a verified seeded drill AND verified authorship for chain-observed", () => {
    expect(classifyEvidence(ok)).toBe("chain-observed");
    expect(classifyEvidence({ ...ok, drill: null })).toBe("chain-bound");
    expect(classifyEvidence({ ...ok, authorship: "unverifiable" })).toBe(
      "chain-bound",
    );
    expect(classifyEvidence({ ...ok, drill: "mismatch" })).toBe("chain-bound");
  });
  it("drops a run whose GRANDPA prediction the chain contradicted, and unbound evidence", () => {
    expect(classifyEvidence({ ...ok, grandpaConsistent: false })).toBe(
      "chain-bound",
    );
    expect(classifyEvidence({ ...ok, grandpaConsistent: null })).toBe(
      "chain-observed",
    );
    expect(classifyEvidence({ ...ok, chainBound: false })).toBe(
      "self-reported",
    );
  });
});

describe("recoverySlots", () => {
  const blocks = (authors: number[]) =>
    authors.map((a, i) => ({
      number: 100 + i,
      hash: hashOf(100 + i),
      authorityIndex: a,
      slot: 5000 + i * 2,
    }));
  const base = (authors: number[]): AuthorshipEvidence => ({
    targetAuthorityIndex: 1,
    windowFrom: 100,
    windowTo: 106,
    faultStartBlock: 101,
    faultEndBlock: 104,
    blocks: blocks(authors),
  });
  it("counts slots from the last fault block to the target's first block after it", () => {
    // target authors 100 and 106; end block 104 slot 5008, resume 106 slot 5012
    expect(recoverySlots(base([1, 0, 2, 0, 2, 0, 1]))).toBe(4);
  });
  it("is null if the target never resumed or authored during the fault", () => {
    expect(recoverySlots(base([1, 0, 2, 0, 2, 0, 0]))).toBeNull();
    expect(recoverySlots(base([1, 1, 2, 0, 2, 0, 1]))).toBeNull();
  });
});

describe("computeResilienceScoreV2", () => {
  it("matches v1 for a chain-bound run only up to the 0.5 class weight in confidence", () => {
    const v1 = computeResilienceScore("bob", [run()], NOW);
    const v2 = computeResilienceScoreV2("bob", [run()], NOW);
    expect(v2.version).toBe(2);
    expect(v2.quality).toBeCloseTo(v1.quality, 10);
    expect(v2.confidence).toBeLessThan(v1.confidence);
    expect(v2.score).toBeLessThan(v1.score);
  });
  it("lets chain-observed evidence outscore the same run chain-bound", () => {
    const bound = computeResilienceScoreV2("bob", [run()], NOW).score;
    const observed = computeResilienceScoreV2(
      "bob",
      [run({ evidenceClass: "chain-observed" })],
      NOW,
    ).score;
    expect(observed).toBeGreaterThan(bound);
  });
  it("uses slot-derived recovery instead of the wall clock when present", () => {
    const wall = computeResilienceScoreV2(
      "bob",
      [run({ timeToRecoverMs: 300_000 })],
      NOW,
    );
    const slots = computeResilienceScoreV2(
      "bob",
      [run({ timeToRecoverMs: 300_000, recoverySlots: 2 })],
      NOW,
    );
    expect(slots.perRun[0]!.recoverySource).toBe("slots");
    expect(slots.quality).toBeGreaterThan(wall.quality);
  });
  it("caps self-reported runs and scores a failed run 0", () => {
    const self = computeResilienceScoreV2(
      "bob",
      [run({ evidenceClass: "self-reported" })],
      NOW,
    );
    expect(self.effectiveRuns).toBeCloseTo(0.1, 10);
    expect(self.score).toBeLessThan(10);
    expect(
      computeResilienceScoreV2("bob", [run({ recovered: false })], NOW).score,
    ).toBe(0);
    expect(computeResilienceScoreV2("bob", [], NOW).score).toBe(0);
    expect(() => computeResilienceScoreV2("bob", [run()], NOW, 0)).toThrow();
  });
});
