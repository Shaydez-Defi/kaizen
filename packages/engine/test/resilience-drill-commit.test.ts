import { describe, expect, it } from "vitest";
import {
  createDrillCommitment,
  deriveDrill,
  verifyDrillReveal,
} from "@kaizen/engine";

const H = `0x${"33".repeat(32)}`;

describe("commit-reveal drill", () => {
  const commitment = createDrillCommitment("bob", 100);
  const claimed = deriveDrill({ validatorId: "bob", seedBlockHash: H });

  it("commits to a strictly future block", () => {
    expect(commitment.targetBlock).toBeGreaterThan(commitment.committedAtBlock);
  });

  it("accepts an honest reveal", () => {
    const r = verifyDrillReveal({
      commitment,
      seedBlockHash: H,
      finalizedAtReveal: 110,
      claimed,
    });
    expect(r).toEqual({ ok: true, reasons: [] });
  });

  it("rejects a reveal before finality and a cherry-picked fault", () => {
    const early = verifyDrillReveal({
      commitment,
      seedBlockHash: H,
      finalizedAtReveal: 101,
      claimed,
    });
    expect(early.ok).toBe(false);
    const forged = verifyDrillReveal({
      commitment,
      seedBlockHash: H,
      finalizedAtReveal: 110,
      claimed: { ...claimed, durationMs: claimed.durationMs + 1 },
    });
    expect(forged.reasons[0]).toMatch(/durationMs/);
  });

  it("rejects a commitment whose target is not in the future", () => {
    const r = verifyDrillReveal({
      commitment: { ...commitment, targetBlock: 100 },
      seedBlockHash: H,
      finalizedAtReveal: 110,
      claimed,
    });
    expect(r.ok).toBe(false);
  });
});
