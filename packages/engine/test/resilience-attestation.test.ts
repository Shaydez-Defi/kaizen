import { describe, expect, it } from "vitest";
import {
  checkAttestation,
  createAttestation,
  issueCertificate,
  loadResilienceSigner,
  verifyCertificate,
} from "@kaizen/engine";
import { fixtureEvidence, fixtureRun, hashOf } from "./resilience-fixtures";

const reader = {
  blockHashAt: async (n: number) => hashOf(n),
  genesisHash: async () => hashOf(0),
  readHeads: async () => {
    throw new Error("unused");
  },
};
const signerOf = (uri: string) =>
  loadResilienceSigner({ env: { KAIZEN_RESILIENCE_SIGNER_SURI: uri } });

describe("attestations", () => {
  it("binds a re-verification verdict to one certificate and detects tampering", async () => {
    const run = fixtureRun();
    const cert = await issueCertificate({
      run,
      chain: fixtureEvidence(),
      signer: await signerOf("//Bob"),
    });
    const verification = await verifyCertificate(cert, run, reader);
    expect(verification.status).toBe("verified");

    const att = await createAttestation({
      certificate: cert,
      verification,
      signer: await signerOf("//Charlie"),
    });
    expect(att).toMatchObject({
      verdict: "verified",
      checks: { drill: "absent", authorship: "absent", grandpa: "absent" },
    });
    expect(await checkAttestation(att, cert)).toEqual({
      signatureValid: true,
      addressMatchesKey: true,
      matchesCertificate: true,
      independent: true,
    });

    const forged = {
      ...att,
      verdict: "verified" as const,
      checks: { ...att.checks, drill: "verified" as const },
    };
    expect((await checkAttestation(forged, cert)).signatureValid).toBe(false);
  });

  it("flags a self-attestation as not independent, and refuses a broken certificate", async () => {
    const run = fixtureRun();
    const bob = await signerOf("//Bob");
    const cert = await issueCertificate({
      run,
      chain: fixtureEvidence(),
      signer: bob,
    });
    const verification = await verifyCertificate(cert, run, reader);
    const self = await createAttestation({
      certificate: cert,
      verification,
      signer: bob,
    });
    expect((await checkAttestation(self, cert)).independent).toBe(false);

    const tampered = { ...cert, fingerprint: hashOf(9) };
    const bad = await verifyCertificate(tampered, run, reader);
    expect(bad.status).toBe("mismatch");
    await expect(
      createAttestation({
        certificate: tampered,
        verification: bad,
        signer: bob,
      }),
    ).rejects.toMatchObject({ code: "RESILIENCE_NOT_CERTIFIABLE" });
  });
});
