/**
 * Typed V3 connectivity probe results (T-8.1).
 *
 * One result PER endpoint, one report per probe cycle. Statuses distinguish
 * exactly what the evidence supports — a timeout or unreachable endpoint is
 * NEVER converted into a healthy result, and HTTP 200 alone never makes an
 * EVM endpoint "ok" (the chain id must be read and matched). Every endpoint
 * field is already origin-redacted; error messages are sanitized before
 * they reach a result.
 */

/**
 * - `ok`                — every check this endpoint supports passed
 *                         (EVM additionally matched the expected chain id)
 * - `unavailable`       — the transport could not reach the endpoint
 *                         (DNS/refused/reset or equivalent)
 * - `timeout`           — the bounded deadline expired before a conclusion
 * - `protocol-error`    — the service answered, but the protocol-level
 *                         response indicates failure or is invalid
 *                         (JSON-RPC error object, bad envelope/id, non-2xx HTTP)
 * - `malformed-response`— a response arrived but required fields are
 *                         missing or unparseable (bad hex height, bad header)
 * - `mismatch`          — checks answered, but the observed identity differs
 *                         from configuration (EVM chain id ≠ expected)
 */
export type V3ProbeStatus =
  | 'ok'
  | 'unavailable'
  | 'timeout'
  | 'protocol-error'
  | 'malformed-response'
  | 'mismatch';

export type V3EndpointRole = 'substrate-ws' | 'evm-rpc' | 'explorer';

export interface V3ProbeFailure {
  kind: V3ProbeStatus;
  /** Sanitized (credential-free) human explanation. */
  message: string;
}

/** Substrate WS observations (fields are null when never observed). */
export interface V3SubstrateObservations {
  chainName: string | null;
  health: { isSyncing: boolean; peers: number; shouldHavePeers: boolean } | null;
  best: { number: number; hash: string } | null;
}

/** EVM JSON-RPC observations (fields are null when never observed). */
export interface V3EvmObservations {
  /** Observed chain id; null when eth_chainId never produced a value. */
  chainId: number | null;
  /** The configured expectation the observed id was compared against. */
  expectedChainId: number;
  blockNumber: number | null;
  clientVersion: string | null;
}

/** Explorer observations: ONLY what an HTTP response can verify. */
export interface V3ExplorerObservations {
  httpStatus: number | null;
  contentType: string | null;
  /** Bytes actually read (bounded prefix; the body is not retained). */
  bodyBytes: number;
  /** <title> of the served document when present in the bounded prefix. */
  documentTitle: string | null;
}

export interface V3EndpointProbeResult {
  role: V3EndpointRole;
  /** Origin-redacted endpoint (never the credential-bearing source URL). */
  endpoint: string;
  status: V3ProbeStatus;
  /** Short, sanitized summary of what was observed or why it failed. */
  detail: string;
  latencyMs: number;
  at: string;
  substrate?: V3SubstrateObservations;
  evm?: V3EvmObservations;
  explorer?: V3ExplorerObservations;
  error: V3ProbeFailure | null;
  /** Non-fatal honesty notes (e.g. unsupported optional method). */
  warnings: string[];
}

export interface V3ConnectivityReport {
  at: string;
  /** Origin-redacted configuration used for this probe cycle. */
  config: {
    substrateWs: string;
    evmRpc: string;
    explorer: string;
    expectedEvmChainId: number;
    probeTimeoutMs: number;
  };
  substrate: V3EndpointProbeResult;
  evm: V3EndpointProbeResult;
  explorer: V3EndpointProbeResult;
  /** True only when ALL THREE endpoints returned `ok`. */
  healthy: boolean;
}

/** JSON-RPC envelope shape the EVM probe validates (id, jsonrpc, result/error). */
export interface V3JsonRpcEnvelope {
  httpStatus: number;
  json: unknown;
  /** The id the transport sent, for strict response-id matching. */
  id: number;
}
