import { describe, expect, it } from "vitest";
import {
  buildDrillRecord,
  EVIDENCE_FLAGS,
  evidenceFlagsFor,
  recordInputFromCertificate,
  issueCertificate,
  loadResilienceSigner,
  verifyCertificate,
  type ChainReader,
} from "@kaizen/engine";
import { fixtureEvidence, fixtureRun, hashOf } from "./resilience-fixtures";

const reader: ChainReader = {
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

const drillFor = (validatorId: string) =>
  buildDrillRecord({
    validatorId,
    commitBlock: 100,
    seedBlockNumber: 110,
    seedBlockHash: `0x${"ab".repeat(32)}`,
  });

describe("certificate with drill record", () => {
  it("binds the drill into the fingerprint and verifies", async () => {
    const signer = await loadResilienceSigner({
      allowDevKey: true,
      localTestNetwork: true,
      env: {},
    });
    const run = fixtureRun();
    const chain = fixtureEvidence();
    const plain = await issueCertificate({ run, chain, signer });
    const cert = await issueCertificate({
      run,
      chain,
      signer,
      drill: drillFor(chain.validatorId),
    });
    expect(cert.fingerprint).not.toBe(plain.fingerprint);
    expect((await verifyCertificate(cert, run, reader)).status).toBe(
      "verified",
    );
  });

  it("rejects a tampered drill record", async () => {
    const signer = await loadResilienceSigner({
      allowDevKey: true,
      localTestNetwork: true,
      env: {},
    });
    const run = fixtureRun();
    const chain = fixtureEvidence();
    const cert = await issueCertificate({
      run,
      chain,
      signer,
      drill: drillFor(chain.validatorId),
    });
    cert.drill = { ...cert.drill!, seedBlockNumber: 111 };
    expect((await verifyCertificate(cert, run, reader)).status).toBe(
      "mismatch",
    );
  });

  it("rejects a drill for another validator", async () => {
    const signer = await loadResilienceSigner({
      allowDevKey: true,
      localTestNetwork: true,
      env: {},
    });
    const run = fixtureRun();
    const chain = fixtureEvidence();
    const cert = await issueCertificate({
      run,
      chain,
      signer,
      drill: drillFor("someone-else"),
    });
    expect((await verifyCertificate(cert, run, reader)).status).toBe(
      "mismatch",
    );
  });
});

describe("evidence flags on the anchor path", () => {
  it("sets the seeded-drill bit only when the certificate carries a drill", async () => {
    const signer = await loadResilienceSigner({
      allowDevKey: true,
      localTestNetwork: true,
      env: {},
    });
    const run = fixtureRun();
    const chain = fixtureEvidence();
    const plain = await issueCertificate({ run, chain, signer });
    const drilled = await issueCertificate({
      run,
      chain,
      signer,
      drill: drillFor(chain.validatorId),
    });
    expect(evidenceFlagsFor(plain) & EVIDENCE_FLAGS.seededDrill).toBe(0);
    expect(evidenceFlagsFor(drilled) & EVIDENCE_FLAGS.seededDrill).toBe(
      EVIDENCE_FLAGS.seededDrill,
    );
    expect(recordInputFromCertificate(drilled, 50).evidenceFlags).toBe(
      evidenceFlagsFor(drilled),
    );
  });

  it("sets the chain-observed bit only when a BABE author was decoded", async () => {
    const signer = await loadResilienceSigner({
      allowDevKey: true,
      localTestNetwork: true,
      env: {},
    });
    const run = fixtureRun();
    const chain = fixtureEvidence();
    const withAuthor = {
      ...chain,
      observations: chain.observations.map((o, i) =>
        i === 0
          ? {
              ...o,
              best: {
                ...o.best,
                author: { kind: "primary", authorityIndex: 1, slot: "42" },
              },
            }
          : o,
      ),
    };
    const a = await issueCertificate({ run, chain, signer });
    const b = await issueCertificate({ run, chain: withAuthor, signer });
    expect(evidenceFlagsFor(a) & EVIDENCE_FLAGS.chainObserved).toBe(0);
    expect(evidenceFlagsFor(b) & EVIDENCE_FLAGS.chainObserved).toBe(
      EVIDENCE_FLAGS.chainObserved,
    );
  });
});
