import { describe, expect, it } from "vitest";
import { createHttpChainReader } from "@kaizen/engine";

const H = "0x" + "ab".repeat(32);
const payload = "01" + "02000000" + "2a00000000000000";
const log = "0x06" + "42414245" + "34" + payload;

describe("HTTP chain reader BABE author evidence", () => {
  it("attaches the decoded BABE author to block refs", async () => {
    const fetchFn = async (_u: string, init?: { body?: unknown }) => {
      const { method } = JSON.parse(String(init?.body));
      const result =
        method === "chain_getFinalizedHead" || method === "chain_getBlockHash"
          ? H
          : { number: "0x10", digest: { logs: [log] } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    };
    const reader = createHttpChainReader("http://x", {
      fetch: fetchFn as never,
    });
    const heads = await reader.readHeads();
    expect(heads.best.number).toBe(16);
    expect(heads.best.author).toEqual({
      kind: "primary",
      authorityIndex: 2,
      slot: "42",
    });
    expect(heads.finalized.author?.slot).toBe("42");
  });
});
