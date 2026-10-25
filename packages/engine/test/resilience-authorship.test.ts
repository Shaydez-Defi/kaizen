import { describe, expect, it } from "vitest";
import {
  decodeBabePreDigest,
  summarizeAuthorship,
  verifyAuthorship,
  readAuthorship,
  buildAuthorshipEvidence,
  verifyAuthorshipEvidence,
  issueCertificate,
  loadResilienceSigner,
  verifyCertificate,
  summarizeAuthorship as summarize,
  type AuthoredBlock,
  type HeaderSource,
} from "@kaizen/engine";
import { fixtureEvidence, fixtureRun, hashOf } from "./resilience-fixtures";

// Real header logs from Portaldot V3 block #0x2f651 (secondary-plain, authority 1).
const V3_LOGS = [
  "0x064241424534020100000070bdcf1100000000",
  "0x04424545468403af047a6e64b5ebd2cdd2a056b0566a4e5c32b29fa74109bf3ab3e04593031eb4",
];

function preDigest(kind: number, authority: number, slot: number): string {
  const p = Buffer.alloc(13);
  p[0] = kind;
  p.writeUInt32LE(authority, 1);
  p.writeBigUInt64LE(BigInt(slot), 5);
  return `0x06${Buffer.from("BABE").toString("hex")}${(13 << 2).toString(16).padStart(2, "0")}${p.toString("hex")}`;
}

describe("decodeBabePreDigest", () => {
  it("decodes a real V3 header digest", () => {
    expect(decodeBabePreDigest(V3_LOGS)).toEqual({
      kind: "secondary-plain",
      authorityIndex: 1,
      slot: 0x11cfbd70,
    });
  });
  it("returns null without a BABE pre-runtime digest and throws on garbage", () => {
    expect(decodeBabePreDigest([V3_LOGS[1]!])).toBeNull();
    expect(() => decodeBabePreDigest(["0x06424142450c09"])).toThrow();
    expect(() => decodeBabePreDigest(["nothex"])).toThrow();
  });
});

// authority 0 authors every 2nd slot; target is authority 1
function chainOf(authors: number[]): AuthoredBlock[] {
  return authors.map((a, i) => ({
    number: 10 + i,
    hash: hashOf(10 + i),
    authorityIndex: a,
    slot: 1000 + i,
  }));
}

describe("summarizeAuthorship", () => {
  it("shows the target stopping during the fault and resuming after", () => {
    // blocks 10..21; target(1) authors 10,12 before; none during 14..17; resumes at 19
    const blocks = chainOf([0, 2, 1, 0, 2, 0, 2, 0, 2, 1, 0, 1]);
    const s = summarizeAuthorship(blocks, 1, 14, 17);
    expect(s.target).toEqual({
      authorityIndex: 1,
      authoredBefore: 1,
      authoredDuring: 0,
      authoredAfter: 2,
      resumedAtBlock: 19,
    });
    expect(s.byAuthority).toEqual({ "0": 5, "1": 3, "2": 4 });
    expect(s.emptySlots).toBe(0);
  });
  it("counts empty slots", () => {
    const b = chainOf([0, 1, 0]);
    b[2] = { ...b[2]!, slot: 1004 };
    expect(summarizeAuthorship(b, 1, 11, 11).emptySlots).toBe(2);
  });
});

function source(
  blocks: AuthoredBlock[],
  tamper?: (n: number) => string[] | null,
): HeaderSource {
  return {
    async blockHashAt(n) {
      return blocks.find((b) => b.number === n)?.hash ?? null;
    },
    async digestLogs(hash) {
      const b = blocks.find((x) => x.hash === hash)!;
      return tamper?.(b.number) ?? [preDigest(2, b.authorityIndex, b.slot)];
    },
  };
}

describe("readAuthorship / verifyAuthorship", () => {
  const blocks = chainOf([0, 1, 2, 1]);
  it("reads a window and re-verifies it against the chain", async () => {
    const read = await readAuthorship(source(blocks), 10, 13);
    expect(read).toEqual(blocks);
    expect((await verifyAuthorship(read, source(blocks))).status).toBe(
      "verified",
    );
  });
  it("flags a forged author and a missing network", async () => {
    const forged = blocks.map((b) =>
      b.number === 11 ? { ...b, authorityIndex: 2 } : b,
    );
    const r = await verifyAuthorship(forged, source(blocks));
    expect(r.status).toBe("mismatch");
    expect(r.reasons[0]).toMatch(/#11/);
    expect((await verifyAuthorship(blocks, null)).status).toBe("unverifiable");
    expect(
      (
        await verifyAuthorship(blocks, {
          blockHashAt: async () => null,
          digestLogs: async () => null,
        })
      ).status,
    ).toBe("unverifiable");
  });
});

describe("authorship evidence on a certificate", () => {
  // blocks 100..106; authority 1 (the target) authors 100, then is silent until 105
  const authors = [1, 0, 2, 0, 2, 1, 0];
  const blocks: AuthoredBlock[] = authors.map((a, i) => ({
    number: 100 + i,
    hash: hashOf(100 + i),
    authorityIndex: a,
    slot: 5000 + i,
  }));
  const header = source(blocks);

  it("builds a contiguous window from the observations and shows the fault gap", async () => {
    const ev = await buildAuthorshipEvidence(header, fixtureEvidence(), 1);
    expect(ev).toMatchObject({
      windowFrom: 100,
      windowTo: 106,
      faultStartBlock: 101,
      faultEndBlock: 104,
    });
    expect(ev.blocks).toHaveLength(7);
    const s = summarize(ev.blocks, 1, ev.faultStartBlock, ev.faultEndBlock);
    expect(s.target).toMatchObject({ authoredDuring: 0, resumedAtBlock: 105 });
  });

  it("is bound into the fingerprint and rejects a cherry-picked window", async () => {
    const evidence = fixtureEvidence();
    const authorship = await buildAuthorshipEvidence(header, evidence, 1);
    expect(
      (await verifyAuthorshipEvidence(authorship, evidence, header)).status,
    ).toBe("verified");

    const picked = {
      ...authorship,
      blocks: authorship.blocks.filter((b) => b.number !== 102),
    };
    const bad = await verifyAuthorshipEvidence(picked, evidence, header);
    expect(bad.status).toBe("mismatch");
    expect(bad.reasons.join(" ")).toMatch(/#102 missing/);

    const run = fixtureRun();
    const signer = await loadResilienceSigner({
      env: { KAIZEN_RESILIENCE_SIGNER_SURI: "//Bob" },
    });
    const plain = await issueCertificate({ run, chain: evidence, signer });
    const cert = await issueCertificate({
      run,
      chain: { ...evidence, authorship },
      signer,
    });
    expect(cert.fingerprint).not.toBe(plain.fingerprint);
    const reader = {
      blockHashAt: async (n: number) => hashOf(n),
      genesisHash: async () => hashOf(0),
      readHeads: async () => {
        throw new Error("unused");
      },
    };
    const ok = await verifyCertificate(cert, run, reader, null, header);
    expect(ok.authorship?.status).toBe("verified");
    expect(ok.status).toBe("verified");
    const offline = await verifyCertificate(cert, run, reader, null, null);
    expect(offline.status).toBe("unverifiable");
  });
});
