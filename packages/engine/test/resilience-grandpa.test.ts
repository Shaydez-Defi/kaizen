import { describe, expect, it } from "vitest";
import {
  buildGrandpaQuorum,
  decodeGrandpaAuthorities,
  decodeSetId,
  grandpaThreshold,
  issueCertificate,
  loadResilienceSigner,
  observedFinalityStall,
  verifyCertificate,
  verifyGrandpaQuorum,
  type StateSource,
} from "@kaizen/engine";
import {
  blockRef,
  fixtureEvidence,
  fixtureRun,
  hashOf,
} from "./resilience-fixtures";

// Real Portaldot V3 GrandpaApi_grandpa_authorities result and CurrentSetId.
const V3_AUTHORITIES =
  "0x08e64cb64dacf59392463823df2978ab3ee21f72362d57c7fe3b85d435ea72d090010000000000000071fe90e5ae0c71f83e66da6c13b95c8627e62b3a584bb24ad18dfb56973a91f00100000000000000";
const V3_SET_ID = "0x3600000000000000";

function state(over: Partial<StateSource> = {}): StateSource {
  return {
    stateCall: async () => V3_AUTHORITIES,
    storage: async () => V3_SET_ID,
    ...over,
  };
}

describe("GRANDPA quorum arithmetic", () => {
  it("decodes the real V3 authority set and set id", () => {
    const a = decodeGrandpaAuthorities(V3_AUTHORITIES);
    expect(a).toHaveLength(2);
    expect(a.map((x) => x.weight)).toEqual([1, 1]);
    expect(a[0]!.id).toMatch(/^0xe64cb64d/);
    expect(decodeSetId(V3_SET_ID)).toBe(54);
  });
  it("threshold is more than 2/3: 2 of 2, 3 of 4, 5 of 7", () => {
    expect([2, 3, 4, 7].map(grandpaThreshold)).toEqual([2, 3, 3, 5]);
  });
  it("rejects malformed input", () => {
    expect(() => decodeGrandpaAuthorities("0x08aa")).toThrow();
    expect(() => decodeSetId(null)).toThrow();
  });
});

describe("GRANDPA evidence on a certificate", () => {
  // fixtureEvidence: finalized 98 before, 98 during (stalled), 103 after.
  it("predicts a stall on 2 authorities and agrees with the observed stall", async () => {
    const ev = fixtureEvidence();
    expect(observedFinalityStall(ev)).toBe(true);
    const q = await buildGrandpaQuorum(state(), ev, 1);
    expect(q).toMatchObject({
      setId: 54,
      totalWeight: 2,
      thresholdWeight: 2,
      remainingWeight: 1,
      predictedStall: true,
    });
    expect(q.at).toEqual(blockRef(98));
    const ok = await verifyGrandpaQuorum(q, ev, state());
    expect(ok).toMatchObject({ status: "verified", consistent: true });
  });

  it("flags a doctored prediction, a different authority set, and unreadable state", async () => {
    const ev = fixtureEvidence();
    const q = await buildGrandpaQuorum(state(), ev, 1);
    const forged = { ...q, predictedStall: false };
    expect((await verifyGrandpaQuorum(forged, ev, state())).status).toBe(
      "mismatch",
    );
    const other = state({ storage: async () => "0x3700000000000000" });
    const d = await verifyGrandpaQuorum(q, ev, other);
    expect(d.status).toBe("mismatch");
    expect(d.reasons[0]).toMatch(/set id/);
    const pruned = state({
      stateCall: async () => {
        throw new Error("State already discarded");
      },
    });
    expect((await verifyGrandpaQuorum(q, ev, pruned)).status).toBe(
      "unverifiable",
    );
    expect((await verifyGrandpaQuorum(q, ev, null)).status).toBe(
      "unverifiable",
    );
  });

  it("reports when prediction and observation disagree, and binds into the fingerprint", async () => {
    // finality advanced during the fault although 2/2 is required
    const ev = fixtureEvidence({
      observations: fixtureEvidence().observations.map((o) =>
        o.phase === "during-fault" ? { ...o, finalized: blockRef(101) } : o,
      ),
    });
    expect(observedFinalityStall(ev)).toBe(false);
    const q = await buildGrandpaQuorum(state(), ev, 0);
    const r = await verifyGrandpaQuorum(q, ev, state());
    expect(r.consistent).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/DISAGREES/);

    const run = fixtureRun();
    const signer = await loadResilienceSigner({
      env: { KAIZEN_RESILIENCE_SIGNER_SURI: "//Bob" },
    });
    const plain = await issueCertificate({ run, chain: ev, signer });
    const cert = await issueCertificate({
      run,
      chain: { ...ev, grandpa: q },
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
    const v = await verifyCertificate(cert, run, reader, null, null, state());
    expect(v.grandpa?.status).toBe("verified");
    expect(v.status).toBe("verified");
  });
});
