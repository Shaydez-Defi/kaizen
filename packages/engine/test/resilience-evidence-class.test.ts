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
