/**
 * V3ConnectivityProbe (T-8.1, Phase 8) — configuration-driven connectivity
 * checks for the official Portaldot V3 endpoints.
 *
 * Contract:
 *  - THREE independent probes (Substrate WS, EVM JSON-RPC, explorer HTTP),
 *    each returning its OWN typed result; all three run in parallel and
 *    are individually wrapped — one endpoint failing never
 *    short-circuits or suppresses another's result.
 *  - Real read-only protocol checks only. The EVM surface is proven by
 *    reading `eth_chainId` and matching it against configuration (HTTP 200
 *    alone is never "healthy"); an unexpected chain id is reported as
 *    `mismatch`. The explorer check verifies ONLY what its public HTTP
 *    response can show (availability, status, document type/title) — no
 *    RPC semantics are assumed.
 *  - Bounded: one AbortController deadline per endpoint, deterministic
 *    cleanup on success/failure/timeout (transports stop work on abort).
 *  - Honest: `unavailable`/`timeout`/`protocol-error`/`malformed-response`
 *    are never converted into success; `healthy` is true only when all
 *    three checks are `ok`.
 *  - Credential-free: results embed origin-redacted endpoints and sanitized
 *    messages only (DEC-023: targets come from configuration, never from
 *    request input — this is not a URL probe API).
 */

import { KaizenError, isKaizenError } from '../errors';
import { redactSecrets } from '../fault/redact';
import { redactEndpointUrl, resolveV3Config, type V3EndpointConfig } from './config';
import {
  FetchHttpAvailabilityTransport,
  FetchJsonRpcTransport,
  RealSubstrateTransport,
  type V3ProbeTransports,
} from './transports';
import type {
  V3ConnectivityReport,
  V3EndpointProbeResult,
  V3EndpointRole,
  V3EvmObservations,
  V3ExplorerObservations,
  V3ProbeStatus,
  V3SubstrateObservations,
} from './types';

export interface V3ProbeOptions {
  /** Explicit config overrides (win over environment). */
  config?: Partial<V3EndpointConfig>;
  /** Transport DI — tests inject fakes; omit for the real implementations. */
  transports?: Partial<V3ProbeTransports>;
}

/** Severity order used to combine per-call outcomes into one endpoint status. */
const SEVERITY: Record<V3ProbeStatus, number> = {
  unavailable: 5,
  timeout: 4,
  'protocol-error': 3,
  'malformed-response': 2,
  mismatch: 1,
  ok: 0,
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Sanitize anything that may be embedded in a result: config URLs are
 * reduced to their origins (messages can quote full credential-bearing
 * URLs — e.g. the Substrate client includes wsUrl), any URL userinfo is
 * stripped generically, then the shared secret scrubber runs.
 */
function makeSanitizer(config: V3EndpointConfig): (value: string) => string {
  const pairs: Array<[string, string]> = (
    [
      [config.substrateWsUrl, redactEndpointUrl(config.substrateWsUrl)],
      [config.evmRpcUrl, redactEndpointUrl(config.evmRpcUrl)],
      [config.explorerUrl, redactEndpointUrl(config.explorerUrl)],
    ] as Array<[string, string]>
  ).filter(([raw, redacted]) => raw !== redacted);
  return (value: string): string => {
    let out = value;
    for (const [raw, redacted] of pairs) out = out.split(raw).join(redacted);
    out = out.replace(/\b(?:wss?|https?):\/\/[^\s/@]+@/g, (m) => `${m.slice(0, m.indexOf('://') + 3)}`);
    return redactSecrets(out);
  };
}

/**
 * Map a transport-level error to a probe status. RPC_TIMEOUT (and the
 * Substrate client's connect() wrapping of its own deadline, whose message
 * preserves "Timed out …") → timeout; RPC_CONNECTION_FAILED → unavailable;
 * RPC_ERROR → protocol-error; abort/timeout DOM exceptions → timeout.
 */
function classifyTransportError(e: unknown, sanitize: (v: string) => string): {
  status: V3ProbeStatus;
  message: string;
} {
  const message = sanitize(errorMessage(e));
  if (isKaizenError(e)) {
    if (e.code === 'RPC_TIMEOUT') return { status: 'timeout', message };
    if (e.code === 'RPC_CONNECTION_FAILED') {
      return { status: /Timed out/.test(message) ? 'timeout' : 'unavailable', message };
    }
    if (e.code === 'RPC_ERROR') return { status: 'protocol-error', message };
  }
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
    return { status: 'timeout', message };
  }
  return { status: 'unavailable', message };
}

/** Parse a JSON-RPC quantity ("0x…" hex) into a safe non-negative integer. */
function parseHexQuantity(value: unknown): number | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const n = BigInt(value);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(n);
}

function emptySubstrateObservations(): V3SubstrateObservations {
  return { chainName: null, health: null, best: null };
}

/** Extract a document title from a bounded HTML prefix (never stored raw). */
function extractTitle(prefix: string, sanitize: (v: string) => string): string | null {
  const closed = /<title[^>]*>([\s\S]{0,160}?)<\/title>/i.exec(prefix);
  const raw = closed?.[1] ?? /<title[^>]*>([^\n<]{0,160})/i.exec(prefix)?.[1];
  if (raw === undefined) return null;
  // Drop C0/C1 control characters (no control-char regex: lint-clean by construction),
  // collapse whitespace, sanitize (secrets), and cap the length.
  const visible = [...raw].filter((ch) => ch.charCodeAt(0) >= 32).join('');
  const cleaned = sanitize(visible.replace(/\s+/g, ' ').trim()).slice(0, 120);
  return cleaned.length > 0 ? cleaned : null;
}

export class V3ConnectivityProbe {
  readonly config: V3EndpointConfig;
  private readonly transports: V3ProbeTransports;
  private readonly sanitize: (value: string) => string;
  private rpcId = 0;

  constructor(options: V3ProbeOptions = {}) {
    this.config = resolveV3Config(options.config ?? {});
    this.transports = {
      substrate: options.transports?.substrate ?? new RealSubstrateTransport(),
      evmRpc: options.transports?.evmRpc ?? new FetchJsonRpcTransport(),
      explorer: options.transports?.explorer ?? new FetchHttpAvailabilityTransport(),
    };
    this.sanitize = makeSanitizer(this.config);
  }

  /**
   * Probe all three endpoints independently and return one result each.
   * Never rejects: any unexpected internal failure is reported as that
   * endpoint's failure — never as success.
   */
  async probeAll(): Promise<V3ConnectivityReport> {
    // Per-role catch wrappers: parallel, no short-circuit, and probeAll()
    // can never reject — an unexpected internal failure becomes that
    // endpoint's failure result, never a success and never a lost sibling.
    const safe = async (role: V3EndpointRole): Promise<V3EndpointProbeResult> => {
      try {
        return await this.probeEndpoint(role);
      } catch (e) {
        return this.failureResult(
          role,
          'protocol-error',
          `probe failed unexpectedly: ${this.sanitize(errorMessage(e))}`,
          null,
          0,
          new Date().toISOString(),
        );
      }
    };
    const [substrate, evm, explorer] = await Promise.all([
      safe('substrate-ws'),
      safe('evm-rpc'),
      safe('explorer'),
    ]);
    return {
      at: new Date().toISOString(),
      config: {
        substrateWs: redactEndpointUrl(this.config.substrateWsUrl),
        evmRpc: redactEndpointUrl(this.config.evmRpcUrl),
        explorer: redactEndpointUrl(this.config.explorerUrl),
        expectedEvmChainId: this.config.expectedEvmChainId,
        probeTimeoutMs: this.config.probeTimeoutMs,
      },
      substrate,
      evm,
      explorer,
      healthy: substrate.status === 'ok' && evm.status === 'ok' && explorer.status === 'ok',
    };
  }

  /**
   * Probe a single configured endpoint (same contract as probeAll).
   *
   * Bounded by a hard deadline: a transport that ignores its AbortSignal
   * still cannot extend the probe past `probeTimeoutMs` — the race below
   * reports `timeout` while the abort signal drives transport cleanup.
   * Never rejects: failures are classified into the result's status.
   */
  async probeEndpoint(role: V3EndpointRole): Promise<V3EndpointProbeResult> {
    const started = Date.now();
    const at = new Date().toISOString();
    const timeoutMs = this.config.probeTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const deadline = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new KaizenError('RPC_TIMEOUT', `${role}: probe deadline of ${timeoutMs}ms exceeded`)),
        { once: true },
      );
    });
    try {
      const probe = (async (): Promise<V3EndpointProbeResult> => {
        switch (role) {
          case 'substrate-ws':
            return await this.probeSubstrate(controller.signal, started, at);
          case 'evm-rpc':
            return await this.probeEvm(controller.signal, started, at);
          case 'explorer':
            return await this.probeExplorer(controller.signal, started, at);
        }
      })();
      // If the deadline wins the race, the pending probe is settled later by
      // its transport aborting; race() has handlers on both, so a late
      // rejection is consumed (never an unhandled rejection).
      return await Promise.race([probe, deadline]);
    } catch (e) {
      // Safety net: never reject, never invent success.
      const { status, message } = classifyTransportError(e, this.sanitize);
      return this.failureResult(role, status, message, null, Date.now() - started, at);
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Substrate WebSocket: connect → system_chain + system_health + head

  private async probeSubstrate(
    signal: AbortSignal,
    started: number,
    at: string,
  ): Promise<V3EndpointProbeResult> {
    const role: V3EndpointRole = 'substrate-ws';
    const endpoint = redactEndpointUrl(this.config.substrateWsUrl);
    const timeoutMs = this.config.probeTimeoutMs;
    let read;
    try {
      read = await this.transports.substrate.read({
        wsUrl: this.config.substrateWsUrl,
        connectTimeoutMs: timeoutMs,
        requestTimeoutMs: timeoutMs,
        signal,
      });
    } catch (e) {
      const { status, message } = classifyTransportError(e, this.sanitize);
      return this.failureResult(role, status, message, emptySubstrateObservations(), Date.now() - started, at, endpoint);
    }

    const observations = emptySubstrateObservations();
    const problems: string[] = [];
    if (typeof read.chainName === 'string' && read.chainName.trim().length > 0) {
      observations.chainName = read.chainName;
    } else {
      problems.push('system_chain returned no usable chain name');
    }
    const health = read.health as Partial<{ isSyncing: boolean; peers: number; shouldHavePeers: boolean }> | null;
    if (
      health &&
      typeof health === 'object' &&
      typeof health.isSyncing === 'boolean' &&
      typeof health.shouldHavePeers === 'boolean' &&
      typeof health.peers === 'number' &&
      Number.isInteger(health.peers) &&
      health.peers >= 0
    ) {
      observations.health = {
        isSyncing: health.isSyncing,
        peers: health.peers,
        shouldHavePeers: health.shouldHavePeers,
      };
    } else {
      problems.push('system_health malformed (expected boolean isSyncing/shouldHavePeers and non-negative integer peers)');
    }
    const best = read.best as { number?: unknown; hash?: unknown } | null;
    const height = best ? parseBlockHeight(best.number) : null;
    const hash = typeof best?.hash === 'string' && /^0x[0-9a-fA-F]{1,128}$/.test(best.hash) ? best.hash : null;
    if (height === null) problems.push('best header number malformed (expected non-negative integer or 0x hex)');
    if (hash === null) problems.push('best header hash malformed (expected 0x hex)');
    if (height !== null && hash !== null) observations.best = { number: height, hash };

    if (problems.length > 0) {
      const message = problems.join('; ');
      return this.failureResult(role, 'malformed-response', message, observations, Date.now() - started, at, endpoint);
    }
    const detail =
      `chain "${observations.chainName}", best #${observations.best!.number}, ` +
      `peers ${observations.health!.peers}, syncing ${observations.health!.isSyncing}`;
    return {
      role,
      endpoint,
      status: 'ok',
      detail,
      latencyMs: Date.now() - started,
      at,
      substrate: observations,
      error: null,
      warnings: [],
    };
  }

  // -------------------------------------------------------------------------
  // EVM JSON-RPC: eth_chainId (matched against config) + eth_blockNumber,
  // with web3_clientVersion as an OPTIONAL read that never fails the probe.

  private async probeEvm(
    signal: AbortSignal,
    started: number,
    at: string,
  ): Promise<V3EndpointProbeResult> {
    const role: V3EndpointRole = 'evm-rpc';
    const endpoint = redactEndpointUrl(this.config.evmRpcUrl);
    const observations: V3EvmObservations = {
      chainId: null,
      expectedChainId: this.config.expectedEvmChainId,
      blockNumber: null,
      clientVersion: null,
    };
    const warnings: string[] = [];

    // Required calls: gather each outcome independently — one failing read
    // does not skip the other (no short-circuit), then combine by severity.
    const failures: Array<{ status: V3ProbeStatus; message: string }> = [];

    const chainCall = await this.jsonRpcCall('eth_chainId', signal);
    if ('status' in chainCall) {
      failures.push(chainCall);
    } else {
      const chainId = parseHexQuantity(chainCall.value);
      if (chainId === null) {
        failures.push({ status: 'malformed-response', message: 'eth_chainId: result is not a valid hex quantity' });
      } else {
        observations.chainId = chainId;
      }
    }

    const blockCall = await this.jsonRpcCall('eth_blockNumber', signal);
    if ('status' in blockCall) {
      failures.push(blockCall);
    } else {
      const height = parseHexQuantity(blockCall.value);
      if (height === null) {
        failures.push({ status: 'malformed-response', message: 'eth_blockNumber: result is not a valid hex quantity' });
      } else {
        observations.blockNumber = height;
      }
    }

    let status: V3ProbeStatus = 'ok';
    for (const failure of failures) status = worseRequired(status, failure.status);
    let detail = failures.map((f) => f.message).join(' | ');

    // Optional method: absence/errors are recorded, never a probe failure.
    const clientCall = await this.jsonRpcCall('web3_clientVersion', signal);
    if ('status' in clientCall) {
      warnings.push(`web3_clientVersion unavailable (${clientCall.status}): ${clientCall.message}`);
    } else if (typeof clientCall.value === 'string' && clientCall.value.length > 0) {
      observations.clientVersion = clientCall.value.slice(0, 200);
    } else {
      warnings.push('web3_clientVersion returned a non-string value');
    }

    if (status === 'ok' && observations.chainId !== this.config.expectedEvmChainId) {
      status = 'mismatch';
      detail =
        `eth_chainId observed ${observations.chainId} but configuration expects ` +
        `${this.config.expectedEvmChainId} — not the expected network`;
    } else if (status === 'ok') {
      detail =
        `eth_chainId ${observations.chainId} matches expected, ` +
        `block #${observations.blockNumber}` +
        (observations.clientVersion !== null ? `, client "${observations.clientVersion}"` : '');
    }

    return {
      role,
      endpoint,
      status,
      detail,
      latencyMs: Date.now() - started,
      at,
      evm: observations,
      error: status === 'ok' ? null : { kind: status, message: detail },
      warnings,
    };
  }

  /** One validated JSON-RPC call: transport → HTTP → envelope/id → error → result. */
  private async jsonRpcCall(
    method: string,
    signal: AbortSignal,
  ): Promise<{ value: unknown } | { status: V3ProbeStatus; message: string }> {
    this.rpcId += 1;
    const id = this.rpcId;
    let envelope;
    try {
      envelope = await this.transports.evmRpc.post({
        url: this.config.evmRpcUrl,
        method,
        params: [],
        timeoutMs: this.config.probeTimeoutMs,
        id,
        signal,
      });
    } catch (e) {
      const { status, message } = classifyTransportError(e, this.sanitize);
      return { status, message: `${method}: ${message}` };
    }
    if (envelope.httpStatus < 200 || envelope.httpStatus >= 300) {
      return { status: 'protocol-error', message: `${method}: HTTP ${envelope.httpStatus}` };
    }
    if (envelope.json === null || typeof envelope.json !== 'object') {
      return { status: 'malformed-response', message: `${method}: response body is not a JSON object` };
    }
    const body = envelope.json as Record<string, unknown>;
    if (body['jsonrpc'] !== '2.0') {
      return { status: 'protocol-error', message: `${method}: invalid jsonrpc version in response` };
    }
    if (!('result' in body) && !('error' in body)) {
      return { status: 'protocol-error', message: `${method}: response has neither result nor error` };
    }
    if (body['id'] !== envelope.id) {
      return { status: 'protocol-error', message: `${method}: response id mismatch (sent ${envelope.id})` };
    }
    if (body['error'] !== undefined && body['error'] !== null) {
      const rpcErr = body['error'] as { code?: unknown; message?: unknown };
      const code = rpcErr?.code !== undefined ? String(rpcErr.code) : '?';
      const msg = rpcErr?.message !== undefined ? this.sanitize(String(rpcErr.message)) : 'unknown';
      return { status: 'protocol-error', message: `${method}: RPC error ${code}: ${msg}` };
    }
    return { value: body['result'] };
  }

  // -------------------------------------------------------------------------
  // Explorer: public HTTP availability ONLY (documented as such)

  private async probeExplorer(
    signal: AbortSignal,
    started: number,
    at: string,
  ): Promise<V3EndpointProbeResult> {
    const role: V3EndpointRole = 'explorer';
    const endpoint = redactEndpointUrl(this.config.explorerUrl);
    const scopeNote =
      'availability check only: probed as plain HTTP — neither Substrate WS nor EVM JSON-RPC applies to the explorer';
    let res;
    try {
      res = await this.transports.explorer.get({
        url: this.config.explorerUrl,
        timeoutMs: this.config.probeTimeoutMs,
        signal,
      });
    } catch (e) {
      const { status, message } = classifyTransportError(e, this.sanitize);
      const failure = this.failureResult(role, status, message, null, Date.now() - started, at, endpoint);
      failure.explorer = { httpStatus: null, contentType: null, bodyBytes: 0, documentTitle: null };
      failure.warnings.push(scopeNote);
      return failure;
    }
    const observations: V3ExplorerObservations = {
      httpStatus: res.httpStatus,
      contentType: res.contentType,
      bodyBytes: res.bodyBytes,
      documentTitle: extractTitle(res.bodyPrefix, this.sanitize),
    };
    const ok = res.httpStatus >= 200 && res.httpStatus < 300;
    const detail = ok
      ? `HTTP ${res.httpStatus}, ${res.contentType ?? 'no content-type'}` +
        (observations.documentTitle !== null ? `, title "${observations.documentTitle}"` : '') +
        ` (${res.bodyBytes} bytes read)`
      : `HTTP ${res.httpStatus} — endpoint answered but not with a success status`;
    return {
      role,
      endpoint,
      status: ok ? 'ok' : 'protocol-error',
      detail,
      latencyMs: Date.now() - started,
      at,
      explorer: observations,
      error: ok ? null : { kind: 'protocol-error', message: detail },
      warnings: [scopeNote],
    };
  }

  // -------------------------------------------------------------------------

  private failureResult(
    role: V3EndpointRole,
    status: V3ProbeStatus,
    message: string,
    observations: V3SubstrateObservations | null,
    latencyMs: number,
    at: string,
    endpoint?: string,
  ): V3EndpointProbeResult {
    const redacted = endpoint ?? redactEndpointUrl(this.urlFor(role));
    const result: V3EndpointProbeResult = {
      role,
      endpoint: redacted,
      status,
      detail: message,
      latencyMs,
      at,
      error: { kind: status, message },
      warnings: [],
    };
    if (role === 'substrate-ws') result.substrate = observations ?? emptySubstrateObservations();
    if (role === 'evm-rpc') {
      result.evm = {
        chainId: null,
        expectedChainId: this.config.expectedEvmChainId,
        blockNumber: null,
        clientVersion: null,
      };
    }
    if (role === 'explorer') {
      result.explorer = { httpStatus: null, contentType: null, bodyBytes: 0, documentTitle: null };
    }
    return result;
  }

  private urlFor(role: V3EndpointRole): string {
    return role === 'substrate-ws'
      ? this.config.substrateWsUrl
      : role === 'evm-rpc'
        ? this.config.evmRpcUrl
        : this.config.explorerUrl;
  }
}

/** Worst status of two REQUIRED-call outcomes (mismatch never out-ranks read failures). */
function worseRequired(a: V3ProbeStatus, b: V3ProbeStatus): V3ProbeStatus {
  const rank = (s: V3ProbeStatus): number => (s === 'ok' ? 0 : s === 'mismatch' ? 1 : SEVERITY[s]);
  return rank(a) >= rank(b) ? a : b;
}

function parseBlockHeight(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  return parseHexQuantity(value);
}

/** Convenience: probe all configured V3 endpoints with default transports. */
export async function probeV3Connectivity(options: V3ProbeOptions = {}): Promise<V3ConnectivityReport> {
  return new V3ConnectivityProbe(options).probeAll();
}
