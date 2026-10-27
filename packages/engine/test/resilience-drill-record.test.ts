import { describe, expect, it } from "vitest";
import { buildDrillRecord, checkDrillRecord } from "@kaizen/engine";

const hash = `0x${"ab".repeat(32)}`;
const base = {
  validatorId: "val-1",
  commitBlock: 100,
  seedBlockNumber: 110,
  seedBlockHash: hash,
};

describe("drill record", () => {
  it("builds and verifies", () => {
    expect(checkDrillRecord(buildDrillRecord(base)).ok).toBe(true);
  });
  it("rejects seed block not after commit", () => {
    expect(() => buildDrillRecord({ ...base, seedBlockNumber: 100 })).toThrow();
  });
  it("detects tampered derivation", () => {
    const r = buildDrillRecord(base);
    r.derived = { ...r.derived, durationMs: r.derived.durationMs + 1 };
    expect(checkDrillRecord(r).derivationMatches).toBe(false);
  });
  it("detects swapped seed hash", () => {
    const r = buildDrillRecord(base);
    r.seedBlockHash = `0x${"cd".repeat(32)}`;
    expect(checkDrillRecord(r).ok).toBe(false);
  });
  it("detects reordered commitment", () => {
    const r = buildDrillRecord(base);
    r.commitBlock = 120;
    expect(checkDrillRecord(r).orderingValid).toBe(false);
  });
});
