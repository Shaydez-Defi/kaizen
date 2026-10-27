import { describe, expect, it } from "vitest";
import {
  buildDrillRecord,
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
