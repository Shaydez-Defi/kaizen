import { describe, expect, it } from "vitest";
import { babeAuthorshipFromLogs, decodeBabePreDigest } from "@kaizen/engine";

const payload = "0x01" + "02000000" + "2a00000000000000"; // primary, author 2, slot 42
describe("BABE authorship decoding", () => {
  it("decodes a primary pre-digest", () => {
    expect(decodeBabePreDigest(payload)).toEqual({
      kind: "primary",
      authorityIndex: 2,
      slot: "42",
    });
  });
  it("rejects unknown variants and short payloads", () => {
    expect(() => decodeBabePreDigest("0x09" + "00".repeat(12))).toThrow(
      /variant/,
    );
    expect(() => decodeBabePreDigest("0x0102")).toThrow(/short/);
    expect(() => decodeBabePreDigest("zz")).toThrow();
  });
  it("extracts authorship from a header digest log", () => {
    const log = "0x06" + "42414245" + "34" + payload.slice(2); // compact(13)=0x34
    expect(babeAuthorshipFromLogs(["0x0466726f6e", log])).toEqual({
      kind: "primary",
      authorityIndex: 2,
      slot: "42",
    });
    expect(babeAuthorshipFromLogs([])).toBeNull();
  });
});
