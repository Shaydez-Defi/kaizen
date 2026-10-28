/**
 * ResilienceRegistryService (T-9.8) unit tests. Offline: the chain is a
 * scripted fake V3ChainConnector; the certificate is the REAL signed one
 * from CI run 40042905143 (docs/evidence/resilience/), signed with the
 * public DEV key; the V3 signer is the public //Alice DEV URI.
 * Live evidence: docs/evidence/v3-resilience-registry.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_RECORDED_TOPIC,
  KAIZEN_RESILIENCE_REGISTRY_ARTIFACT,
  RESILIENCE_REGISTRY_SIGNATURES,
  ResilienceRegistryService,
  certificateSignatureHolds,
  encodeRecordedCall,
  isKaizenError,
  selectorOf,
  validatorKey,
  type ResilienceCertificate,
  type ResilienceChainJournalEntry,
  type V3ChainConnector,
  type V3ChainSession,
  type V3TxReceipt,
} from '@kaizen/engine';

const CERT_PATH = path.resolve(__dirname, '../../../docs/evidence/resilience/certificate-517b2ffb81ec.json');
const cert = JSON.parse(fs.readFileSync(CERT_PATH, 'utf8')) as ResilienceCertificate;
const REGISTRY = '0x' + 'ab'.repeat(20);
const DEV_ENV = { KAIZEN_V3_SIGNER_SURI: '//Alice' };
const word = (n: number | bigint): string => BigInt(n).toString(16).padStart(64, '0');

interface FakeOpts {
  recorded?: boolean;
  dropLog?: boolean;
  noInstantiated?: boolean;
  failSubmit?: Error;
  balance?: bigint;
  count?: number;
}

class FakeChain implements V3ChainConnector {
  calls: { kind: string; args: unknown[] }[] = [];
  balance: bigint;
  constructor(public opts: FakeOpts = {}) {
    this.balance = opts.balance ?? 383n * 10n ** 14n;
  }

  receipt(o: Partial<V3TxReceipt> = {}): V3TxReceipt {
    return {
      txHash: '0x' + '11'.repeat(32),
      blockHash: '0x' + '22'.repeat(32),
      blockNumber: 170_000,
      extrinsicIndex: 2,
      finalized: true,
      events: ['system.ExtrinsicSuccess'],
      logs: [],
      instantiated: null,
      remarkHash: null,
      ...o,
    };
  }

  async connect(): Promise<V3ChainSession> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- closure-heavy fake session
    const self = this;
    const unused = async (): Promise<never> => {
      throw new Error('unused');
    };
    return {
      info: async () => ({
        chainName: 'PortaldotV3 Test',
        genesisHash: '0x' + 'd4'.repeat(32),
        specName: 'portaldot-v3',
        specVersion: 3002,
        tokenSymbol: 'tPOT',
        tokenDecimals: 14,
        bestNumber: 170_001,
      }),
      freeBalance: async () => self.balance,
      evmAddressOf: async () => '0x' + '31'.repeat(20),
      blockHashAt: async () => null,
      deploymentAt: unused,
      remarkAt: unused,
      submitRemark: unused,
      deployContract: async (_s, code) => {
        self.calls.push({ kind: 'deploy', args: [code] });
        if (self.opts.failSubmit) throw self.opts.failSubmit;
        self.balance -= 85n * 10n ** 14n;
        return self.receipt({ instantiated: self.opts.noInstantiated ? null : REGISTRY });
      },
      callContract: async (_s, contract, calldata) => {
        self.calls.push({ kind: 'call', args: [contract, calldata] });
        if (self.opts.failSubmit) throw self.opts.failSubmit;
        self.balance -= 4n * 10n ** 14n;
        const validator = '0x' + calldata.slice(10, 74);
        const fingerprint = '0x' + calldata.slice(74, 138);
        const logs = self.opts.dropLog
          ? []
          : [{ contract, topics: [CERTIFICATE_RECORDED_TOPIC, validator, fingerprint, '0x' + '44'.repeat(32)], data: '0x' }];
        return self.receipt({ logs, events: ['revive.ContractEmitted', 'system.ExtrinsicSuccess'] });
      },
      readContract: async (_o, _c, calldata) => {
        self.calls.push({ kind: 'read', args: [calldata] });
        const sel = calldata.slice(0, 10);
        if (sel === selectorOf(RESILIENCE_REGISTRY_SIGNATURES.recorded)) return '0x' + word(self.opts.recorded ? 1 : 0);
        if (sel === selectorOf(RESILIENCE_REGISTRY_SIGNATURES.getScore)) {
          const n = self.opts.count ?? 1;
          return '0x' + word(n ? 35 : 0) + word(n ? 1_761_264_000 : 0) + word(n);
        }
        // getLatest
        return (
          '0x' +
          cert.fingerprint.slice(2) +
          cert.runHash.slice(2) +
          cert.signature.publicKey.slice(2) +
          word(2020) +
          word(3) +
          word(2) +
          word(35) +
          word(3) +
          word(1_761_264_000) +
          '00'.repeat(12) +
          '31'.repeat(20)
        );
      },
      close: async () => undefined,
    };
  }
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isKaizenError(e) ? e.code : String(e);
  }
  return 'resolved';
}

describe('certificateSignatureHolds', () => {
  it('accepts the real CI certificate and rejects a tampered fingerprint', () => {
    expect(certificateSignatureHolds(cert)).toBe(true);
    expect(certificateSignatureHolds({ ...cert, fingerprint: '0x' + '00'.repeat(32) })).toBe(false);
  });
});

describe('ResilienceRegistryService.deploy', () => {
  it('deploys the committed artifact, journals before signing, and reports the spend', async () => {
    const chain = new FakeChain();
    const journal: ResilienceChainJournalEntry[] = [];
    const svc = new ResilienceRegistryService({ connector: chain, env: DEV_ENV });
    const d = await svc.deploy({ journal: (e) => journal.push(e) });
    expect(chain.calls[0]).toEqual({ kind: 'deploy', args: [KAIZEN_RESILIENCE_REGISTRY_ARTIFACT.bytecode] });
    expect(d.address).toBe(REGISTRY);
    expect(d.spent).toBe((85n * 10n ** 14n).toString());
    expect(journal.map((e) => e.phase)).toEqual(['submitting', 'included']);
    expect(journal[0]!.txHash).toBeNull();
    expect(journal[1]!.contract).toBe(REGISTRY);
    expect(JSON.stringify(journal)).not.toContain('//Alice');
  });

  it('fails (journaled) when no revive.Instantiated is observed', async () => {
    const journal: ResilienceChainJournalEntry[] = [];
    const svc = new ResilienceRegistryService({ connector: new FakeChain({ noInstantiated: true }), env: DEV_ENV });
    expect(await code(svc.deploy({ journal: (e) => journal.push(e) }))).toBe('V3_TX_FAILED');
    expect(journal.map((e) => e.phase)).toEqual(['submitting', 'failed']);
    expect(journal[1]!.txHash).toBe('0x' + '11'.repeat(32));
  });

  it('refuses without a signer and with an empty balance', async () => {
    expect(await code(new ResilienceRegistryService({ connector: new FakeChain(), env: {} }).deploy())).toBe(
      'V3_SIGNER_NOT_CONFIGURED',
    );
    const broke = new FakeChain({ balance: 0n });
    expect(await code(new ResilienceRegistryService({ connector: broke, env: DEV_ENV }).deploy())).toBe('V3_INSUFFICIENT_FUNDS');
    expect(broke.calls).toHaveLength(0);
  });
});

describe('ResilienceRegistryService.anchor', () => {
  it('records the certificate with its score and confirms CertificateRecorded', async () => {
    const chain = new FakeChain();
    const svc = new ResilienceRegistryService({ connector: chain, env: DEV_ENV });
    const a = await svc.anchor(cert, 35, { registry: REGISTRY });
    expect(chain.calls[0]).toEqual({ kind: 'read', args: [encodeRecordedCall(cert.fingerprint)] });
    const call = chain.calls.find((c) => c.kind === 'call')!;
    expect((call.args[1] as string).slice(0, 10)).toBe(selectorOf(RESILIENCE_REGISTRY_SIGNATURES.record));
    expect(a.validatorKey).toBe(validatorKey('res-it-bob'));
    expect(a.evidenceFlags).toBe(3); // chainBound | devKey — the CI cert is DEV-signed
    expect(a.score).toBe(35);
  });

  it('does not pay for a fingerprint the registry already holds', async () => {
    const chain = new FakeChain({ recorded: true });
    const svc = new ResilienceRegistryService({ connector: chain, env: DEV_ENV });
    expect(await code(svc.anchor(cert, 35, { registry: REGISTRY }))).toBe('V3_ALREADY_ANCHORED');
    expect(chain.calls.some((c) => c.kind === 'call')).toBe(false);
  });

  it('rejects a bad signature, a bad score, a missing registry, and a missing log', async () => {
    const svc = new ResilienceRegistryService({ connector: new FakeChain(), env: DEV_ENV });
    expect(await code(svc.anchor({ ...cert, fingerprint: '0x' + '01'.repeat(32) }, 35, { registry: REGISTRY }))).toBe('INVALID_INPUT');
    expect(await code(svc.anchor(cert, 101, { registry: REGISTRY }))).toBe('INVALID_INPUT');
    expect(await code(svc.anchor(cert, 35))).toBe('V3_REGISTRY_NOT_DEPLOYED');
    const journal: ResilienceChainJournalEntry[] = [];
    const dropped = new ResilienceRegistryService({ connector: new FakeChain({ dropLog: true }), env: DEV_ENV });
    expect(await code(dropped.anchor(cert, 35, { registry: REGISTRY, journal: (e) => journal.push(e) }))).toBe('V3_TX_FAILED');
    expect(journal.at(-1)!.phase).toBe('failed');
  });

  it('takes the registry from KAIZEN_V3_RESILIENCE_REGISTRY_ADDRESS', async () => {
    const svc = new ResilienceRegistryService({
      connector: new FakeChain(),
      env: { ...DEV_ENV, KAIZEN_V3_RESILIENCE_REGISTRY_ADDRESS: REGISTRY.toUpperCase().replace('0X', '0x') },
    });
    expect((await svc.anchor(cert, 35)).contract).toBe(REGISTRY);
  });
});

describe('ResilienceRegistryService.read', () => {
  it('decodes getScore + getLatest + recorded', async () => {
    const svc = new ResilienceRegistryService({ connector: new FakeChain({ recorded: true }), env: DEV_ENV });
    const r = await svc.read('res-it-bob', { registry: REGISTRY, fingerprint: cert.fingerprint });
    expect(r.score).toEqual({ score: 35, certifiedAt: 1_761_264_000, count: 1 });
    expect(r.latest?.fingerprint).toBe(cert.fingerprint);
    expect(r.latest?.timeToRecoverMs).toBe(2020);
    expect(r.recorded).toBe(true);
  });

  it('skips getLatest for a validator with no certificates', async () => {
    const chain = new FakeChain({ count: 0 });
    const r = await new ResilienceRegistryService({ connector: chain, env: DEV_ENV }).read('nobody', { registry: REGISTRY });
    expect(r.score.count).toBe(0);
    expect(r.latest).toBeNull();
    expect(chain.calls).toHaveLength(1);
  });
});

describe('committed V3 evidence (docs/evidence/v3-resilience-registry.json)', () => {
  const evidence = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../docs/evidence/v3-resilience-registry.json'), 'utf8'),
  ) as {
    network: { evmChainId: number };
    deployment: { address: string; initCodeKeccak: string };
    anchors: { fingerprint: string; validatorKey: string; score: number; evidenceFlags: number; certificateRecordedTopics: string[] }[];
    readBack: { getScore: { score: number; count: number }; getLatest: { fingerprint: string; signer: string } };
  };

  it('matches the committed certificate, artifact and codec', async () => {
    const { keccakAsHex } = await import('@polkadot/util-crypto');
    expect(evidence.network.evmChainId).toBe(420420777);
    expect(evidence.deployment.initCodeKeccak).toBe(keccakAsHex(KAIZEN_RESILIENCE_REGISTRY_ARTIFACT.bytecode, 256));
    const a = evidence.anchors[0]!;
    expect(a.fingerprint).toBe(cert.fingerprint);
    expect(a.validatorKey).toBe(validatorKey(cert.validatorId));
    expect(a.evidenceFlags).toBe(3);
    expect(a.certificateRecordedTopics).toEqual([CERTIFICATE_RECORDED_TOPIC, a.validatorKey, cert.fingerprint, cert.signature.publicKey]);
    expect(evidence.readBack.getScore).toMatchObject({ score: a.score, count: 1 });
    expect(evidence.readBack.getLatest.fingerprint).toBe(cert.fingerprint);
    expect(evidence.readBack.getLatest.signer).toBe(cert.signature.publicKey);
  });
});
