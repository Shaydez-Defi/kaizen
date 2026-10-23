/**
 * KaizenResilienceRegistry codec ↔ committed artifact (T-9.4). Execution of
 * the bytecode itself is covered by contracts/test-resilience-registry.mjs
 * (in-memory EVM, optional tooling like solc — see TESTING.md).
 */

import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_RECORDED_TOPIC,
  EVIDENCE_FLAGS,
  KAIZEN_RESILIENCE_REGISTRY_ARTIFACT,
  RESILIENCE_REGISTRY_SIGNATURES,
  decodeLatest,
  decodeScore,
  encodeGetLatestCall,
  encodeGetScoreCall,
  encodeRecordCall,
  issueCertificate,
  loadResilienceSigner,
  recordInputFromCertificate,
  selectorOf,
  validatorKey,
} from '@kaizen/engine';
import { fixtureEvidence, fixtureRun } from './resilience-fixtures';

const art = KAIZEN_RESILIENCE_REGISTRY_ARTIFACT;
const b = (byte: string): string => `0x${byte.repeat(32)}`;

describe('KaizenResilienceRegistry artifact', () => {
  it('codec selectors match solc methodIdentifiers', () => {
    const ids = art.methodIdentifiers as Record<string, string>;
    for (const key of ['record', 'getLatest', 'getScore', 'certificateCount', 'recorded'] as const) {
      const sig = RESILIENCE_REGISTRY_SIGNATURES[key];
      expect(`0x${ids[sig]}`, sig).toBe(selectorOf(sig));
    }
  });

  it('event topic matches the ABI event and the bytecode is non-trivial', () => {
    const ev = art.abi.find((e) => e.type === 'event' && e.name === 'CertificateRecorded') as { inputs: { type: string }[] };
    expect(`CertificateRecorded(${ev.inputs.map((i) => i.type).join(',')})`).toBe(RESILIENCE_REGISTRY_SIGNATURES.certificateRecordedEvent);
    expect(CERTIFICATE_RECORDED_TOPIC).toMatch(/^0x[0-9a-f]{64}$/);
    expect(art.bytecode.length).toBeGreaterThan(1000);
    expect(art.compiler).toMatch(/^solc 0\.8\.28/);
  });
});

describe('codec', () => {
  it('encodes record() with sentinels for unknown metrics and saturation below them', () => {
    const data = encodeRecordCall({
      validator: b('01'),
      fingerprint: b('02'),
      runHash: b('03'),
      signer: b('04'),
      timeToRecoverMs: null,
      finalityGapBlocks: 70_000,
      blocksMissed: 3,
      score: 67,
      evidenceFlags: EVIDENCE_FLAGS.chainBound,
      signature: `0x${'ab'.repeat(64)}`,
    });
    const body = data.slice(10);
    const w = (i: number) => body.slice(i * 64, (i + 1) * 64);
    expect(data.slice(0, 10)).toBe(selectorOf(RESILIENCE_REGISTRY_SIGNATURES.record));
    expect(BigInt(`0x${w(4)}`)).toBe(0xffffffffn);
    expect(BigInt(`0x${w(5)}`)).toBe(0xfffen);
    expect(BigInt(`0x${w(9)}`)).toBe(320n);
    expect(BigInt(`0x${w(10)}`)).toBe(64n);
    expect(body.length).toBe(64 * 13);
  });

  it('rejects bad scores, signatures, and hashes', () => {
    const base = {
      validator: b('01'),
      fingerprint: b('02'),
      runHash: b('03'),
      signer: b('04'),
      timeToRecoverMs: 1,
      finalityGapBlocks: 1,
      blocksMissed: 1,
      score: 50,
      evidenceFlags: 1,
      signature: `0x${'ab'.repeat(64)}`,
    };
    expect(() => encodeRecordCall({ ...base, score: 101 })).toThrow();
    expect(() => encodeRecordCall({ ...base, signature: '0x00' })).toThrow();
    expect(() => encodeRecordCall({ ...base, fingerprint: '0x12' })).toThrow();
    expect(() => encodeRecordCall({ ...base, timeToRecoverMs: -1 })).toThrow();
  });

  it('decodes getLatest/getScore returns', () => {
    const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
    const latest = `0x${'02'.repeat(32)}${'03'.repeat(32)}${'04'.repeat(32)}${word(0xffffffff)}${word(6)}${word(0xffff)}${word(67)}${word(3)}${word(1_700_000_000)}${'0'.repeat(24)}${'ee'.repeat(20)}`;
    expect(decodeLatest(latest)).toEqual({
      fingerprint: b('02'),
      runHash: b('03'),
      signer: b('04'),
      timeToRecoverMs: null,
      finalityGapBlocks: 6,
      blocksMissed: null,
      score: 67,
      evidenceFlags: 3,
      certifiedAt: 1_700_000_000,
      submitter: `0x${'ee'.repeat(20)}`,
    });
    expect(decodeScore(`0x${word(67)}${word(5)}${word(2)}`)).toEqual({ score: 67, certifiedAt: 5, count: 2 });
    expect(() => decodeScore('0x1234')).toThrow();
    expect(encodeGetLatestCall(b('01'))).toBe(selectorOf(RESILIENCE_REGISTRY_SIGNATURES.getLatest) + '01'.repeat(32));
    expect(encodeGetScoreCall(b('01')).slice(0, 10)).toBe(selectorOf(RESILIENCE_REGISTRY_SIGNATURES.getScore));
  });

  it('derives validator keys from SS58, hex, or a labelled hash', () => {
    expect(validatorKey('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY')).toBe(
      '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d',
    );
    expect(validatorKey(b('AB'))).toBe(b('ab'));
    expect(validatorKey('bob')).toMatch(/^0x[0-9a-f]{64}$/);
    expect(validatorKey('bob')).not.toBe(validatorKey('alice'));
  });

  it('builds record() input from a certificate (dev key flagged)', async () => {
    const signer = await loadResilienceSigner({ allowDevKey: true, localTestNetwork: true, env: {} });
    const cert = await issueCertificate({ run: fixtureRun(), chain: fixtureEvidence(), signer });
    const input = recordInputFromCertificate(cert, 29);
    expect(input).toMatchObject({ fingerprint: cert.fingerprint, signer: cert.signature.publicKey, score: 29, evidenceFlags: 3 });
    expect(() => encodeRecordCall(input)).not.toThrow();
  });
});
