/**
 * Seeded drill derivation (T-9.6 step 1, docs/RESILIENCE_SCORE.md §7.1).
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_DRILL_SEED_BOUNDS, deriveDrill } from "@kaizen/engine";

const H1 = `0x${"11".repeat(32)}`;
const H2 = `0x${"22".repeat(32)}`;

describe("deriveDrill", () => {
  it("is deterministic for the same validator and block hash", () => {
    const a = deriveDrill({ validatorId: "bob", seedBlockHash: H1 });
    const b = deriveDrill({ validatorId: "bob", seedBlockHash: H1 });
    expect(a).toEqual(b);
    expect(a.seed).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes the seed when the block hash or validator changes", () => {
    const base = deriveDrill({ validatorId: "bob", seedBlockHash: H1 }).seed;
    expect(
      deriveDrill({ validatorId: "bob", seedBlockHash: H2 }).seed,
    ).not.toBe(base);
    expect(
      deriveDrill({ validatorId: "alice", seedBlockHash: H1 }).seed,
    ).not.toBe(base);
  });

  it("keeps every derived value inside the catalogue and bounds", () => {
    const b = DEFAULT_DRILL_SEED_BOUNDS;
    for (let i = 0; i < 64; i++) {
      const hash = `0x${i.toString(16).padStart(2, "0").repeat(32)}`;
      const d = deriveDrill({ validatorId: `v${i}`, seedBlockHash: hash });
      expect(["pause", "terminate"]).toContain(d.faultType);
      expect(d.startAfterBlocks).toBeGreaterThanOrEqual(b.minStartAfterBlocks);
      expect(d.startAfterBlocks).toBeLessThanOrEqual(b.maxStartAfterBlocks);
      expect(d.durationMs).toBeGreaterThanOrEqual(b.minDurationMs);
      expect(d.durationMs).toBeLessThanOrEqual(b.maxDurationMs);
    }
  });

  it("rejects malformed inputs instead of guessing", () => {
    expect(() =>
      deriveDrill({ validatorId: "bob", seedBlockHash: "0x1234" }),
    ).toThrow(/32-byte/);
    expect(() => deriveDrill({ validatorId: "", seedBlockHash: H1 })).toThrow(
      /validatorId/,
    );
    expect(() =>
      deriveDrill({ validatorId: "bob", seedBlockHash: H1, catalogue: [] }),
    ).toThrow(/catalogue/);
    expect(() =>
      deriveDrill({
        validatorId: "bob",
        seedBlockHash: H1,
        bounds: {
          minStartAfterBlocks: 5,
          maxStartAfterBlocks: 1,
          minDurationMs: 1,
          maxDurationMs: 2,
        },
      }),
    ).toThrow(/bounds/);
  });
});
