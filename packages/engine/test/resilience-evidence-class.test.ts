import { describe, expect, it } from "vitest";
import { evidenceClassFactor } from "../src/resilience/score";

describe("evidenceClassFactor", () => {
  it("orders classes by trust", () => {
    expect(evidenceClassFactor("signed-chain-verified")).toBe(1);
    expect(evidenceClassFactor("signed-local")).toBeGreaterThan(
      evidenceClassFactor("unsigned"),
    );
  });
  it("rejects unknown classes", () => {
    expect(() => evidenceClassFactor("bogus" as never)).toThrow();
  });
});

import {
  classifyEvidence,
  computeResilienceScore,
} from "../src/resilience/score";

const base = {
  runId: "r1",
  runState: "completed",
  recovered: true,
  timeToRecoverMs: 10_000,
  finalityGapBlocks: 2,
  blocksMissed: 1,
  certifiedAt: "2026-10-26T00:00:00.000Z",
};
const asOf = new Date("2026-10-27T00:00:00.000Z");

describe("classifyEvidence", () => {
  it("maps signature and chain verification to a class", () => {
    expect(
      classifyEvidence({ signatureValid: false, chainVerified: true }),
    ).toBe("unsigned");
    expect(
      classifyEvidence({ signatureValid: true, chainVerified: false }),
    ).toBe("signed-local");
    expect(
      classifyEvidence({ signatureValid: true, chainVerified: true }),
    ).toBe("signed-chain-verified");
  });
});

describe("computeResilienceScore with evidence classes", () => {
  it("leaves v1 inputs unchanged when no class is set", () => {
    const a = computeResilienceScore("v", [base], asOf);
    const b = computeResilienceScore(
      "v",
      [{ ...base, evidenceClass: "signed-chain-verified" }],
      asOf,
    );
    expect(b.score).toBe(a.score);
    expect(b.effectiveRuns).toBeCloseTo(a.effectiveRuns, 12);
  });
  it("discounts weaker evidence so confidence and score drop", () => {
    const strong = computeResilienceScore(
      "v",
      [{ ...base, evidenceClass: "signed-chain-verified" }],
      asOf,
    );
    const weak = computeResilienceScore(
      "v",
      [{ ...base, evidenceClass: "unsigned" }],
      asOf,
    );
    expect(weak.effectiveRuns).toBeLessThan(strong.effectiveRuns);
    expect(weak.score).toBeLessThan(strong.score);
  });
});
