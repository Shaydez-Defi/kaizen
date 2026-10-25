/**
 * Signed attestations (T-9.8 / RESILIENCE_SCORE.md §7.4).
 *
 * A certificate says "the operator ran this drill". An attestation says
 * "I, a different key, independently re-checked that certificate against
 * the chain and found <verdict>". It signs
 *
 *   kaizen:attestation:v1:<fingerprint>:<verdict>:<drill>:<authorship>:<grandpa>
 *
 * so the verdict and each sub-check are bound to one certificate. It is
 * not a score by itself: it records who re-verified what, and whether that
 * party is independent of the certificate's signer.
 */

import {
  cryptoWaitReady,
  decodeAddress,
  signatureVerify,
} from "@polkadot/util-crypto";
import { KaizenError } from "../errors";
import type { ResilienceCertificate } from "./certificate";
import type { ResilienceSigner } from "./signer";
import type { CertificateVerification } from "./verify";

export const KAIZEN_ATTESTATION_VERSION = 1 as const;

type Status = "verified" | "mismatch" | "unverifiable";
type SubStatus = Status | "absent";

export interface ResilienceAttestation {
  version: typeof KAIZEN_ATTESTATION_VERSION;
  fingerprint: string;
  verdict: Status;
  checks: { drill: SubStatus; authorship: SubStatus; grandpa: SubStatus };
  attester: { address: string; publicKey: string; dev: boolean };
  /** 0x sr25519 signature over attestationMessage(). */
  signature: string;
  attestedAt: string;
}

const hex = (u: Uint8Array): string => `0x${Buffer.from(u).toString("hex")}`;

export function attestationMessage(
  a: Pick<ResilienceAttestation, "fingerprint" | "verdict" | "checks">,
): string {
  return `kaizen:attestation:v${KAIZEN_ATTESTATION_VERSION}:${a.fingerprint}:${a.verdict}:${a.checks.drill}:${a.checks.authorship}:${a.checks.grandpa}`;
}

export async function createAttestation(input: {
  certificate: ResilienceCertificate;
  verification: CertificateVerification;
  signer: ResilienceSigner;
  now?: () => Date;
}): Promise<ResilienceAttestation> {
  const { certificate: c, verification: v, signer } = input;
  if (!v.integrity.fingerprintMatches)
    throw new KaizenError(
      "RESILIENCE_NOT_CERTIFIABLE",
      "refusing to attest a certificate whose fingerprint does not match its run",
    );
  await cryptoWaitReady();
  const body = {
    fingerprint: c.fingerprint,
    verdict: v.status,
    checks: {
      drill: (v.drill?.status ?? "absent") as SubStatus,
      authorship: (v.authorship?.status ?? "absent") as SubStatus,
      grandpa: (v.grandpa?.status ?? "absent") as SubStatus,
    },
  };
  return {
    version: KAIZEN_ATTESTATION_VERSION,
    ...body,
    attester: {
      address: signer.address,
      publicKey: hex(signer.pair.publicKey),
      dev: signer.dev,
    },
    signature: hex(signer.pair.sign(attestationMessage(body))),
    attestedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
}

export interface AttestationCheck {
  signatureValid: boolean;
  addressMatchesKey: boolean;
  /** Names the given certificate. */
  matchesCertificate: boolean;
  /** Attester key differs from the certificate signer's key. */
  independent: boolean;
}

export async function checkAttestation(
  a: ResilienceAttestation,
  certificate: ResilienceCertificate,
): Promise<AttestationCheck> {
  await cryptoWaitReady();
  let signatureValid = false;
  try {
    signatureValid = signatureVerify(
      attestationMessage(a),
      a.signature,
      a.attester.publicKey,
    ).isValid;
  } catch {
    signatureValid = false;
  }
  let addressMatchesKey = false;
  try {
    addressMatchesKey =
      hex(decodeAddress(a.attester.address)) === a.attester.publicKey;
  } catch {
    addressMatchesKey = false;
  }
  return {
    signatureValid,
    addressMatchesKey,
    matchesCertificate: a.fingerprint === certificate.fingerprint,
    independent:
      a.attester.publicKey.toLowerCase() !==
      certificate.signature.publicKey.toLowerCase(),
  };
}
