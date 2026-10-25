import { describe, expect, it } from "vitest";
import {
  createDrillCommitment,
  drillCommitPayload,
  deriveDrill,
  issueCertificate,
  loadResilienceSigner,
  verifyCertificate,
  verifyDrillEvidence,
  type DrillChainReader,
  type DrillEvidence,
  type ScenarioRunRecord,
} from "@kaizen/engine";
import { fixtureEvidence, fixtureRun, hashOf } from "./resilience-fixtures";

const SEED = `0x${"44".repeat(32)}`;
const COMMIT_HASH = hashOf(100);

function makeDrill(): DrillEvidence {
  const commitment = createDrillCommitment("bob", 100);
  return {
    commitment,
    seedBlockHash: SEED,
    finalizedAtReveal: 120,
    claimed: deriveDrill({ validatorId: "bob", seedBlockHash: SEED }),
    commit: { blockHash: COMMIT_HASH, extrinsicIndex: 2 },
  };
}

function runWith(faultType: string): ScenarioRunRecord {
  return fixtureRun({
    steps: [{ faultType, state: "completed" }],
  } as unknown as Partial<ScenarioRunRecord>);
}

function chain(
  drill: DrillEvidence,
  over: Partial<DrillChainReader> = {},
): DrillChainReader {
  return {
    async blockHashAt(n) {
      if (n === drill.commitment.targetBlock) return SEED;
      if (n === drill.commitment.committedAtBlock) return COMMIT_HASH;
      return null;
    },
    async remarkAt() {
      return drillCommitPayload("bob", drill.commitment.targetBlock);
    },
    ...over,
  };
}

describe("verifyDrillEvidence", () => {
  it("verifies an honest commit-reveal drill against the chain", async () => {
    const d = makeDrill();
    const r = await verifyDrillEvidence(
      d,
      chain(d),
      runWith(d.claimed.faultType),
    );
    expect(r.status).toBe("verified");
  });

  it("flags a seed block hash the chain does not have", async () => {
    const d = makeDrill();
    const r = await verifyDrillEvidence(
      d,
      chain(d, { blockHashAt: async () => hashOf(7) }),
    );
    expect(r.status).toBe("mismatch");
    expect(r.reasons.join(" ")).toMatch(/differs from the revealed seed/);
  });

  it("flags a commit remark that names another target block", async () => {
    const d = makeDrill();
    const r = await verifyDrillEvidence(
      d,
      chain(d, { remarkAt: async () => drillCommitPayload("bob", 999) }),
    );
    expect(r.status).toBe("mismatch");
    expect(r.reasons.join(" ")).toMatch(/commit remark text differs/);
  });

  it("flags a run that did not execute the seeded fault", async () => {
    const d = makeDrill();
    const other = d.claimed.faultType === "pause" ? "terminate" : "pause";
    const r = await verifyDrillEvidence(d, chain(d), runWith(other));
    expect(r.status).toBe("mismatch");
  });

  it("is unverifiable (never verified) offline or when the target is missing", async () => {
    const d = makeDrill();
    expect((await verifyDrillEvidence(d, null)).status).toBe("unverifiable");
    const missing = await verifyDrillEvidence(
      d,
      chain(d, { blockHashAt: async () => null }),
    );
    expect(missing.status).toBe("unverifiable");
  });
});

describe("certificate with drill", () => {
  it("binds the drill into the fingerprint and fails verification when it is forged", async () => {
    const drill = makeDrill();
    const run = runWith(drill.claimed.faultType);
    const signer = await loadResilienceSigner({
      env: { KAIZEN_RESILIENCE_SIGNER_SURI: "//Bob" },
    });
    const cert = await issueCertificate({
      run,
      chain: fixtureEvidence({ drill }),
      signer,
    });
    const plain = await issueCertificate({
      run,
      chain: fixtureEvidence(),
      signer,
    });
    expect(cert.fingerprint).not.toBe(plain.fingerprint);

    const reader = {
      async blockHashAt(n: number) {
        return hashOf(n);
      },
      async genesisHash() {
        return hashOf(0);
      },
      async readHeads() {
        throw new Error("unused");
      },
    };
    const bad = await verifyCertificate(cert, run, reader, chain(drill));
    // fixture chain hashes differ from SEED/COMMIT at 105 / 100 → drill is checked
    expect(bad.drill).not.toBeNull();
    const ok = await verifyCertificate(
      cert,
      run,
      reader,
      chain(drill, {
        blockHashAt: async (n) =>
          n === drill.commitment.targetBlock
            ? SEED
            : n === drill.commitment.committedAtBlock
              ? COMMIT_HASH
              : null,
      }),
    );
    expect(ok.drill?.status).toBe("verified");
    expect(ok.status).toBe("verified");
    const forged = { ...drill, finalizedAtReveal: 100 };
    const res = await verifyCertificate(
      { ...cert, chain: { ...cert.chain, drill: forged } },
      run,
      reader,
      chain(drill),
    );
    expect(res.status).toBe("mismatch");
  });
});
