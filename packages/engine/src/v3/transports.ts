/**
 * V3 probe transports (T-8.1): the pluggable I/O layer behind
 * `V3ConnectivityProbe`. The probe depends only on these interfaces, so
 * unit tests inject fakes; the classes below are the real implementations
 * built on the existing compatible clients (PortaldotRpcClient for
 * Substrate WS, `fetch` — the engine's HTTP stack — for JSON-RPC/HTTP).
 *
 * Contract rules:
 *  - Read-only by construction: the Substrate transport performs exactly
 *    three reads; the EVM transport sends whatever method the probe asks
 *    for (the probe's allowlist is eth_chainId / eth_blockNumber /
 *    web3_clientVersion — no writes, no signing, no state-changing calls
 *    exist anywhere in this module); the explorer transport issues GET.
 *  - No auth headers, tokens, or credentials are ever attached.
 *  - Failures throw structured KaizenErrors only: RPC_CONNECTION_FAILED
 *    (transport unreachable), RPC_TIMEOUT (deadline/abort). Protocol and
 *    malformed-response classification happens in the probe, which sees
 *    the actual response data.
 *  - Callers pass an `AbortSignal` (probe deadline); transports must stop
 *    work and release resources when it fires.
 */

import { KaizenError } from '../errors';
import { readProbeState, type SubstrateProbeRead } from '../rpc/client';

export interface V3SubstrateTransportInput {
  wsUrl: string;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  signal?: AbortSignal;
}

export interface V3SubstrateTransport {
  /** Read chain name + health + best header. Read-only, disconnects after. */
  read(input: V3SubstrateTransportInput): Promise<SubstrateProbeRead>;
}

export interface V3JsonRpcTransportInput {
  url: string;
  method: string;
  params: unknown[];
  timeoutMs: number;
  /** The request id, returned with the envelope so the probe can match it. */
  id: number;
  signal?: AbortSignal;
}

export interface V3HttpJsonRpcTransport {
  /**
   * POST one JSON-RPC call. Resolves with HTTP status + parsed body
   * (`json: null` when the body is not JSON). Throws only transport-level
   * errors (unavailable / timeout) — the probe classifies protocol issues.
   */
  post(input: V3JsonRpcTransportInput): Promise<{ httpStatus: number; json: unknown; id: number }>;
}

export interface V3HttpAvailabilityTransportInput {
  url: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Max response bytes to read (the body is a bounded prefix, never stored whole). */
  maxBytes?: number;
}

export interface V3HttpAvailabilityResult {
  httpStatus: number;
  contentType: string | null;
  bodyPrefix: string;
  bodyBytes: number;
}

export interface V3HttpAvailabilityTransport {
  /** GET the endpoint; returns what its HTTP response can verify. */
  get(input: V3HttpAvailabilityTransportInput): Promise<V3HttpAvailabilityResult>;
}

export interface V3ProbeTransports {
  substrate: V3SubstrateTransport;
  evmRpc: V3HttpJsonRpcTransport;
  explorer: V3HttpAvailabilityTransport;
}

// ---------------------------------------------------------------------------
// Real implementations

/** Substrate WS via the existing PortaldotRpcClient (@polkadot/api, DEC-001). */
export class RealSubstrateTransport implements V3SubstrateTransport {
  async read(input: V3SubstrateTransportInput): Promise<SubstrateProbeRead> {
    const { wsUrl, connectTimeoutMs, requestTimeoutMs, signal } = input;
    const pending = readProbeState(wsUrl, { connectTimeoutMs, requestTimeoutMs });
    if (!signal) return pending;
    if (signal.aborted) {
      // Prevent an unhandled rejection: readProbeState still settles and
      // its `finally` closes the socket on its own bounded deadlines.
      void pending.catch(() => undefined);
      throw new KaizenError('RPC_TIMEOUT', 'substrate probe aborted (deadline reached)');
    }
    return await new Promise<SubstrateProbeRead>((resolve, reject) => {
      const onAbort = () => reject(new KaizenError('RPC_TIMEOUT', 'substrate probe aborted (deadline reached)'));
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }
}

function timeoutSignal(inputSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return inputSignal ? AbortSignal.any([inputSignal, timeout]) : timeout;
}

function fetchFailure(e: unknown, signal: AbortSignal, timeoutMs: number, what: string): KaizenError {
  if (signal.aborted) {
    return new KaizenError('RPC_TIMEOUT', `${what} timed out (${timeoutMs}ms)`);
  }
  const message = e instanceof Error ? e.message : String(e);
  return new KaizenError('RPC_CONNECTION_FAILED', `${what} failed: ${message}`);
}

/**
 * EVM JSON-RPC over HTTP via `fetch` (the engine's existing HTTP stack).
 * Sends Content-Type only — never auth headers — and validates nothing
 * beyond JSON parsing here (envelope/id/result validation is the probe's).
 */
export class FetchJsonRpcTransport implements V3HttpJsonRpcTransport {
  async post(input: V3JsonRpcTransportInput): Promise<{ httpStatus: number; json: unknown; id: number }> {
    const signal = timeoutSignal(input.signal, input.timeoutMs);
    const what = `POST ${input.method}`;
    let res: Response;
    try {
      res = await fetch(input.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: input.id, method: input.method, params: input.params }),
        signal,
      });
    } catch (e) {
      throw fetchFailure(e, signal, input.timeoutMs, what);
    }
    const text = await res.text().catch((e: unknown) => {
      throw fetchFailure(e, signal, input.timeoutMs, what);
    });
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null; // 200-with-garbage: the probe reports malformed-response
      }
    }
    return { httpStatus: res.status, json, id: input.id };
  }
}

/**
 * HTTP availability via `fetch` GET: reads at most `maxBytes` (default
 * 2 KiB) of the body, then cancels the stream — the document is never
 * retained beyond that bounded prefix.
 */
export class FetchHttpAvailabilityTransport implements V3HttpAvailabilityTransport {
  async get(input: V3HttpAvailabilityTransportInput): Promise<V3HttpAvailabilityResult> {
    const signal = timeoutSignal(input.signal, input.timeoutMs);
    const maxBytes = input.maxBytes ?? 2_048;
    let res: Response;
    try {
      res = await fetch(input.url, { method: 'GET', signal });
    } catch (e) {
      throw fetchFailure(e, signal, input.timeoutMs, 'GET');
    }
    const contentType = res.headers.get('content-type');
    if (!res.body) {
      return { httpStatus: res.status, contentType, bodyPrefix: '', bodyBytes: 0 };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (bytes < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          bytes += value.byteLength;
        }
      }
    } catch (e) {
      throw fetchFailure(e, signal, input.timeoutMs, 'GET body');
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* stream already closed */
      }
    }
    const merged = new Uint8Array(Math.min(bytes, maxBytes));
    let offset = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.byteLength, merged.byteLength - offset);
      if (take <= 0) break;
      merged.set(chunk.subarray(0, take), offset);
      offset += take;
    }
    return {
      httpStatus: res.status,
      contentType,
      bodyPrefix: new TextDecoder('utf-8', { fatal: false }).decode(merged),
      bodyBytes: merged.byteLength,
    };
  }
}
