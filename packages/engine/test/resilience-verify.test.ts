/**
 * Certificate verification (T-9.1/T-9.2): block hashes re-fetched from a
 * scripted ChainReader; offline → unverifiable, never a fake success.
 */

import { describe, expect, it } from 'vitest';
import {
  ChainUnreachableError,
  issueCertificate,
  loadResilienceSigner,
  verifyCertificate,
  verifyChainEvidence,
  type ChainReader,
} from '@kaizen/engine';
import { fixtureEvidence, fixtureRun, hashOf } from './resilience-fixtures';

function reader(chain: (n: number) => string | null | Error): ChainReader & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async blockHashAt(n: number) {
      calls.push(n);
      const r = chain(n);
      if (r instanceof Error) throw r;
      return r;
    },
    async genesisHash() {
      return hashOf(0);
    },
    async readHeads() {
      throw new Error('unused');
    },
  };
}

const honest = (n: number): string => hashOf(n);

describe('verifyChainEvidence', () => {
  it('verifies when every observed hash matches, fetching each block number once', async () => {
    const r = reader(honest);
    const res = await verifyChainEvidence(fixtureEvidence(), r);
    expect(res.status).toBe('verified');
    expect(res.checks).toHaveLength(7); // genesis + 3 phases × (best, finalized)
    expect(res.checks.every((c) => c.ok)).toBe(true);
    expect(new Set(r.calls).size).toBe(r.calls.length);
  });

  it('fails on any differing hash (forked/reset chain or altered evidence)', async () => {
    const res = await verifyChainEvidence(fixtureEvidence(), reader((n) => (n === 98 ? hashOf(98, 1) : hashOf(n))));
    expect(res.status).toBe('mismatch');
    expect(res.reason).toMatch(/#98 finalized/);
    expect(res.checks.filter((c) => !c.ok).map((c) => c.phase)).toEqual(['before-fault', 'during-fault']);
  });

  it('reports unverifiable (network offline) when the RPC is unreachable or absent', async () => {
    const off = await verifyChainEvidence(fixtureEvidence(), reader(() => new ChainUnreachableError('ECONNREFUSED')));
    expect(off).toMatchObject({ status: 'unverifiable' });
    expect(off.reason).toMatch(/^network offline/);
    const none = await verifyChainEvidence(fixtureEvidence(), null);
    expect(none.status).toBe('unverifiable');
    expect(none.reason).toMatch(/^network offline/);
  });

  it('reports unverifiable when blocks are missing, but mismatch wins over missing', async () => {
    const missing = await verifyChainEvidence(fixtureEvidence(), reader((n) => (n >= 104 ? null : hashOf(n))));
    expect(missing.status).toBe('unverifiable');
    expect(missing.reason).toMatch(/block not found/);
    const both = await verifyChainEvidence(
      fixtureEvidence(),
      reader((n) => (n >= 104 ? null : n === 0 ? hashOf(0, 2) : hashOf(n))),
    );
    expect(both.status).toBe('mismatch');
  });

  it('treats RPC-level errors and empty evidence as unverifiable', async () => {
    expect((await verifyChainEvidence(fixtureEvidence(), reader(() => new Error('method not found')))).reason).toMatch(/^RPC error/);
    expect((await verifyChainEvidence(fixtureEvidence({ observations: [], genesisHash: null }), reader(honest))).status).toBe(
      'unverifiable',
    );
  });
});

describe('verifyCertificate', () => {
  it('combines integrity and chain binding; labels dev keys', async () => {
    const run = fixtureRun();
    const signer = await loadResilienceSigner({ allowDevKey: true, localTestNetwork: true, env: {} });
    const cert = await issueCertificate({ run, chain: fixtureEvidence(), signer });

    const ok = await verifyCertificate(cert, run, reader(honest));
    expect(ok.status).toBe('verified');
    expect(ok.devKey).toBe(true);
    expect(ok.reasons.join('\n')).toMatch(/DEV KEY/);

    const offline = await verifyCertificate(cert, run, null);
    expect(offline.status).toBe('unverifiable');

    const forged = { ...cert, signature: { ...cert.signature, signature: `0x${'11'.repeat(64)}` } };
    const bad = await verifyCertificate(forged, run, null);
    expect(bad.status).toBe('mismatch');
    expect(bad.reasons).toContain('sr25519 signature is invalid');

    const forkedChain = await verifyCertificate(cert, run, reader((n) => hashOf(n, 3)));
    expect(forkedChain.status).toBe('mismatch');
  });
});
