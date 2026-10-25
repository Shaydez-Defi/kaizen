/**
 * ResilienceRegistryService (T-9.8): puts Proof-of-Resilience certificates
 * on the Portaldot V3 TEST network through KaizenResilienceRegistry
 * (pallet-revive, EVM bytecode — same path as KaizenRunRegistry, R-30).
 *
 * Contract (mirrors V3AnchorService, DEC-026/DEC-027):
 *  - writes only on an explicit call (`deploy`, `anchor`); they spend real
 *    testnet funds from `KAIZEN_V3_SIGNER_SURI`, which is never logged,
 *    persisted, or placed in an error (every message is scrubbed)
 *  - persist-first: the optional `journal` hook receives a `submitting`
 *    entry BEFORE a transaction is signed, then `included` (with tx hash,
 *    block, fee) or `failed`. A caller that persists the journal keeps
 *    evidence even if the process dies mid-submission
 *  - `anchor` checks the certificate offline first (sr25519 signature over
 *    the fingerprint, address ↔ key) and asks the registry whether the
 *    fingerprint is already recorded, so nothing is paid for a write the
 *    contract would refuse; an inclusion without the expected
 *    CertificateRecorded log is reported as a failure, never as anchored
 *  - `read` is a free runtime-API dry run (getScore / certOf / recorded)
 *
 * The EVM cannot verify sr25519, so the registry stores the signer key and
 * emits the signature; anyone re-verifies off chain (`verify-certificate`).
 */

import { signatureVerify, decodeAddress, keccakAsHex } from '@polkadot/util-crypto';
import { KaizenError, isKaizenError } from '../errors';
import { redactSecrets } from '../fault/redact';
import { resolveV3Config, type V3EndpointConfig } from '../v3/config';
import { PolkadotV3ChainConnector, type V3ChainConnector, type V3ChainSession, type V3SubmitOptions } from '../v3/anchor/chain';
import { loadV3Signer, type V3Signer } from '../v3/anchor/signer';
import { certificateMessage, type ResilienceCertificate } from './certificate';
import {
  CERTIFICATE_RECORDED_TOPIC,
  decodeCertOf,
  decodeScore,
  encodeCertOfCall,
  encodeGetScoreCall,
  encodeRecordCall,
  encodeRecordedCall,
  recordInputFromCertificate,
  validatorKey,
  type OnChainCertificate,
} from './registry-abi';
import { KAIZEN_RESILIENCE_REGISTRY_ARTIFACT } from './registry-artifact';

export const RESILIENCE_REGISTRY_ENV_KEY = 'KAIZEN_V3_RESILIENCE_REGISTRY_ADDRESS';

export type ResilienceChainAction = 'deploy' | 'anchor';

export interface ResilienceChainJournalEntry {
  action: ResilienceChainAction;
  phase: 'submitting' | 'included' | 'failed';
  at: string;
  chainName: string | null;
  genesisHash: string | null;
  signerAddress: string;
  contract: string | null;
  fingerprint: string | null;
  validatorKey: string | null;
  txHash: string | null;
  blockHash: string | null;
  blockNumber: number | null;
  finalized: boolean | null;
  /** Free balance before / after, smallest unit (decimal string). */
  balanceBefore: string | null;
  balanceAfter: string | null;
  error: string | null;
}

export interface ResilienceChainReceipt {
  chainName: string;
  genesisHash: string;
  signerAddress: string;
  txHash: string;
  blockHash: string;
  blockNumber: number;
  extrinsicIndex: number;
  finalized: boolean;
  events: string[];
  tokenSymbol: string;
  tokenDecimals: number;
  balanceBefore: string;
  balanceAfter: string;
  /** balanceBefore - balanceAfter: fee + storage deposit actually paid. */
  spent: string;
}

export interface ResilienceRegistryDeployment extends ResilienceChainReceipt {
  name: 'KaizenResilienceRegistry';
  address: string;
  /** keccak256 of the deployed init code (matches the committed artifact). */
  codeHash: string;
}

export interface ResilienceAnchorReceipt extends ResilienceChainReceipt {
  contract: string;
  fingerprint: string;
  validatorId: string;
  validatorKey: string;
  score: number;
  evidenceFlags: number;
}

export interface ResilienceOnChainRead {
  contract: string;
  validatorId: string;
  validatorKey: string;
  score: { score: number; block: number; count: number };
  /** certOf(fingerprint) (score, block), when a recorded fingerprint was asked about. */
  cert: OnChainCertificate | null;
  /** recorded(fingerprint), when a fingerprint was asked about. */
  recorded: boolean | null;
  bestNumber: number;
}

export interface ResilienceRegistryServiceOptions {
  connector?: V3ChainConnector;
  env?: NodeJS.ProcessEnv;
  config?: Partial<V3EndpointConfig>;
  submit?: Partial<V3SubmitOptions>;
  connectTimeoutMs?: number;
  now?: () => Date;
}

const DEFAULT_SUBMIT: V3SubmitOptions = { inclusionTimeoutMs: 120_000, finalityTimeoutMs: 60_000 };

export function isH160(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Offline certificate integrity that needs no run record: sr25519 signature + address ↔ key. */
export function certificateSignatureHolds(cert: ResilienceCertificate): boolean {
  try {
    const sigOk = signatureVerify(certificateMessage(cert.fingerprint), cert.signature.signature, cert.signature.publicKey).isValid;
    const addr = `0x${Buffer.from(decodeAddress(cert.signature.address)).toString('hex')}`;
    return sigOk && addr === cert.signature.publicKey.toLowerCase();
  } catch {
    return false;
  }
}

function isTrueWord(hex: string): boolean {
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
  return raw.length >= 64 && BigInt(`0x${raw.slice(0, 64)}`) !== 0n;
}

export class ResilienceRegistryService {
  private readonly connector: V3ChainConnector;
  private readonly env: NodeJS.ProcessEnv;
  private readonly configOverrides: Partial<V3EndpointConfig>;
  private readonly submitOpts: V3SubmitOptions;
  private readonly connectTimeoutMs: number;
  private readonly now: () => Date;

  constructor(options: ResilienceRegistryServiceOptions = {}) {
    this.connector = options.connector ?? new PolkadotV3ChainConnector();
    this.env = options.env ?? process.env;
    this.configOverrides = options.config ?? {};
    this.submitOpts = { ...DEFAULT_SUBMIT, ...options.submit };
    this.connectTimeoutMs = options.connectTimeoutMs ?? 20_000;
    this.now = options.now ?? (() => new Date());
  }

  /** Registry address from an explicit value or `KAIZEN_V3_RESILIENCE_REGISTRY_ADDRESS`. */
  resolveRegistry(explicit?: string): string {
    const raw = (explicit ?? this.env[RESILIENCE_REGISTRY_ENV_KEY] ?? '').trim();
    if (raw === '') {
      throw new KaizenError(
        'V3_REGISTRY_NOT_DEPLOYED',
        `No KaizenResilienceRegistry address: pass --registry or export ${RESILIENCE_REGISTRY_ENV_KEY}`,
      );
    }
    if (!isH160(raw)) throw new KaizenError('INVALID_INPUT', 'registry must be a 0x-prefixed 20-byte address');
    return raw.toLowerCase();
  }

  private open(): Promise<V3ChainSession> {
    return this.connector.connect(resolveV3Config(this.configOverrides).substrateWsUrl, {
      connectTimeoutMs: this.connectTimeoutMs,
    });
  }

  private safeError(e: unknown, signer?: V3Signer): KaizenError {
    const clean = (t: string): string => redactSecrets(signer ? signer.scrub(t) : t);
    if (isKaizenError(e)) return new KaizenError(e.code, clean(e.message), e.details);
    return new KaizenError('INTERNAL', clean(e instanceof Error ? e.message : String(e)));
  }

  private baseEntry(action: ResilienceChainAction, signer: V3Signer): ResilienceChainJournalEntry {
    return {
      action,
      phase: 'submitting',
      at: this.now().toISOString(),
      chainName: null,
      genesisHash: null,
      signerAddress: signer.address,
      contract: null,
      fingerprint: null,
      validatorKey: null,
      txHash: null,
      blockHash: null,
      blockNumber: null,
      finalized: null,
      balanceBefore: null,
      balanceAfter: null,
      error: null,
    };
  }

  /**
   * Shared write path: balance check → journal(submitting) → submit →
   * journal(included | failed). `send` performs the submission.
   */
  private async write<T extends ResilienceChainReceipt>(
    action: ResilienceChainAction,
    prepare: (session: V3ChainSession, entry: ResilienceChainJournalEntry) => Promise<void>,
    send: (session: V3ChainSession, signer: V3Signer) => Promise<{ receipt: Awaited<ReturnType<V3ChainSession['deployContract']>>; finish: (base: ResilienceChainReceipt) => T }>,
    journal?: (entry: ResilienceChainJournalEntry) => void,
  ): Promise<T> {
    const signer = await loadV3Signer(this.env);
    let session: V3ChainSession | undefined;
    let entry: ResilienceChainJournalEntry | null = null;
    try {
      session = await this.open();
      const info = await session.info();
      const before = await session.freeBalance(signer.address);
      if (before === 0n) {
        throw new KaizenError('V3_INSUFFICIENT_FUNDS', `Signer ${signer.address} has 0 ${info.tokenSymbol}; fund it first.`, {
          address: signer.address,
        });
      }
      entry = { ...this.baseEntry(action, signer), chainName: info.chainName, genesisHash: info.genesisHash, balanceBefore: before.toString() };
      await prepare(session, entry);
      journal?.({ ...entry });
      const { receipt, finish } = await send(session, signer);
      const after = await session.freeBalance(signer.address);
      const base: ResilienceChainReceipt = {
        chainName: info.chainName,
        genesisHash: info.genesisHash,
        signerAddress: signer.address,
        txHash: receipt.txHash,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber,
        extrinsicIndex: receipt.extrinsicIndex,
        finalized: receipt.finalized,
        events: receipt.events,
        tokenSymbol: info.tokenSymbol,
        tokenDecimals: info.tokenDecimals,
        balanceBefore: before.toString(),
        balanceAfter: after.toString(),
        spent: (before - after).toString(),
      };
      entry = {
        ...entry,
        phase: 'included',
        at: this.now().toISOString(),
        txHash: receipt.txHash,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber,
        finalized: receipt.finalized,
        balanceAfter: after.toString(),
      };
      const result = finish(base); // throws when the expected evidence is missing
      if ('address' in result) entry.contract = (result as unknown as { address: string }).address;
      journal?.({ ...entry });
      return result;
    } catch (e) {
      const err = this.safeError(e, signer);
      if (entry) {
        const details = (err.details ?? {}) as Record<string, unknown>;
        journal?.({
          ...entry,
          phase: 'failed',
          at: this.now().toISOString(),
          txHash: entry.txHash ?? (typeof details.txHash === 'string' ? details.txHash : null),
          blockHash: entry.blockHash ?? (typeof details.blockHash === 'string' ? details.blockHash : null),
          error: err.message,
        });
      }
      throw err;
    } finally {
      await session?.close();
    }
  }

  /** Deploy KaizenResilienceRegistry from the committed artifact. */
  async deploy(options: { journal?: (entry: ResilienceChainJournalEntry) => void } = {}): Promise<ResilienceRegistryDeployment> {
    const code = KAIZEN_RESILIENCE_REGISTRY_ARTIFACT.bytecode;
    const codeHash = keccakAsHex(code, 256);
    return this.write<ResilienceRegistryDeployment>(
      'deploy',
      async () => undefined,
      async (session, signer) => {
        const receipt = await session.deployContract(signer.pair, code, this.submitOpts);
        return {
          receipt,
          finish: (base) => {
            if (!receipt.instantiated) {
              throw new KaizenError(
                'V3_TX_FAILED',
                `Deployment tx ${receipt.txHash} was included in block ${receipt.blockHash} but no revive.Instantiated event was observed`,
                { txHash: receipt.txHash, blockHash: receipt.blockHash, events: receipt.events },
              );
            }
            return { ...base, name: 'KaizenResilienceRegistry', address: receipt.instantiated, codeHash };
          },
        };
      },
      options.journal,
    );
  }

  /**
   * Record a signed certificate and its v1 score (operator-computed,
   * docs/RESILIENCE_SCORE.md) in the registry.
   */
  async anchor(
    cert: ResilienceCertificate,
    score: number,
    options: { registry?: string; journal?: (entry: ResilienceChainJournalEntry) => void } = {},
  ): Promise<ResilienceAnchorReceipt> {
    const contract = this.resolveRegistry(options.registry);
    if (!certificateSignatureHolds(cert)) {
      throw new KaizenError('INVALID_INPUT', `certificate ${cert.fingerprint}: sr25519 signature or signer address does not check out`);
    }
    const input = recordInputFromCertificate(cert, score);
    const calldata = encodeRecordCall(input); // validates score / hex shapes
    return this.write<ResilienceAnchorReceipt>(
      'anchor',
      async (session, entry) => {
        entry.contract = contract;
        entry.fingerprint = cert.fingerprint;
        entry.validatorKey = input.validator;
        const signer = entry.signerAddress;
        const already = await session.readContract(signer, contract, encodeRecordedCall(cert.fingerprint));
        if (isTrueWord(already)) {
          throw new KaizenError('V3_ALREADY_ANCHORED', `certificate ${cert.fingerprint} is already recorded in ${contract}`, {
            fingerprint: cert.fingerprint,
          });
        }
      },
      async (session, signer) => {
        const receipt = await session.callContract(signer.pair, contract, calldata, this.submitOpts);
        return {
          receipt,
          finish: (base) => {
            const log = receipt.logs.find(
              (l) =>
                l.contract === contract &&
                l.topics[0] === CERTIFICATE_RECORDED_TOPIC &&
                l.topics[1] === input.validator &&
                l.topics[2] === cert.fingerprint.toLowerCase(),
            );
            if (!log) {
              throw new KaizenError(
                'V3_TX_FAILED',
                `record() tx ${receipt.txHash} was included in block ${receipt.blockHash} but no CertificateRecorded log was observed`,
                { txHash: receipt.txHash, blockHash: receipt.blockHash, events: receipt.events },
              );
            }
            return {
              ...base,
              contract,
              fingerprint: cert.fingerprint,
              validatorId: cert.validatorId,
              validatorKey: input.validator,
              score,
              evidenceFlags: input.evidenceFlags,
            };
          },
        };
      },
      options.journal,
    );
  }

  /** Free read: getScore (+ recorded and certOf for a fingerprint). */
  async read(validatorId: string, options: { registry?: string; fingerprint?: string; origin?: string } = {}): Promise<ResilienceOnChainRead> {
    const contract = this.resolveRegistry(options.registry);
    const key = validatorKey(validatorId);
    const session = await this.open();
    try {
      const info = await session.info();
      // Any mapped account can be the dry-run origin; default to the signer's address when configured.
      const origin = options.origin ?? (await loadV3Signer(this.env).then((s) => s.address).catch(() => null));
      if (!origin) throw new KaizenError('INVALID_INPUT', 'read needs an origin address (configure the V3 signer or pass one)');
      const score = decodeScore(await session.readContract(origin, contract, encodeGetScoreCall(key)));
      const recorded =
        options.fingerprint !== undefined
          ? isTrueWord(await session.readContract(origin, contract, encodeRecordedCall(options.fingerprint)))
          : null;
      const cert =
        recorded === true && options.fingerprint !== undefined
          ? decodeCertOf(await session.readContract(origin, contract, encodeCertOfCall(options.fingerprint)))
          : null;
      return { contract, validatorId, validatorKey: key, score, cert, recorded, bestNumber: info.bestNumber };
    } catch (e) {
      throw this.safeError(e);
    } finally {
      await session.close();
    }
  }
}
