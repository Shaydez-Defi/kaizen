/**
 * V3 connectivity probe unit tests (T-8.1, Phase 8).
 *
 * Fully offline: every transport is a fake injected through the probe's DI
 * surface. The suite covers the required matrix — independent per-endpoint
 * results, timeout + cleanup signalling, malformed/errored JSON-RPC,
 * chain-id mismatch, invalid height/header data, unsupported optional
 * methods, credential redaction, config defaults/overrides, read-only
 * protocol use, and no short-circuiting between endpoints.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KaizenError,
  RealSubstrateTransport,
  V3ConnectivityProbe,
  V3_ENDPOINT_DEFAULTS,
  V3_ENV_KEYS,
  probeV3Connectivity,
  redactEndpointUrl,
  resolveV3Config,
  type SubstrateProbeRead,
  type V3HttpAvailabilityResult,
  type V3JsonRpcTransportInput,
  type V3SubstrateTransportInput,
} from '@kaizen/engine';

// ---------------------------------------------------------------------------
// Fake transports

const CHAIN_OK: SubstrateProbeRead = {
  chainName: 'PortaldotV3 Test',
  health: { isSyncing: false, peers: 2, shouldHavePeers: false },
  best: { number: 105_907, hash: `0x${'ab'.repeat(32)}` }, // 0x19db3 (live V3 observation)
};

class FakeSubstrate {
  readonly calls: V3SubstrateTransportInput[] = [];
  aborts = 0;
  constructor(
    private readonly handler: (input: V3SubstrateTransportInput) => Promise<SubstrateProbeRead>,
  ) {}
  read(input: V3SubstrateTransportInput): Promise<SubstrateProbeRead> {
    this.calls.push(input);
    input.signal?.addEventListener(
      'abort',
      () => {
        this.aborts += 1;
      },
      { once: true },
    );
    return this.handler(input);
  }
}

const okSubstrate = (): FakeSubstrate => new FakeSubstrate(async () => CHAIN_OK);
const hangSubstrate = (): FakeSubstrate =>
  new FakeSubstrate(() => new Promise<SubstrateProbeRead>(() => undefined));

type EvmResponse = { httpStatus: number; json: unknown; id: number };

class FakeEvm {
  readonly calls: V3JsonRpcTransportInput[] = [];
  constructor(private readonly handler: (input: V3JsonRpcTransportInput) => EvmResponse | Promise<EvmResponse>) {}
  post(input: V3JsonRpcTransportInput): Promise<EvmResponse> {
    this.calls.push(input);
    return Promise.resolve(this.handler(input));
  }
}

const rpcResult = (id: number, result: unknown): EvmResponse => ({
  httpStatus: 200,
  json: { jsonrpc: '2.0', id, result },
  id,
});

const okEvm = (
  obs: { chainId?: string; block?: string; client?: string } = {},
): FakeEvm =>
  new FakeEvm((input) => {
    const results: Record<string, string> = {
      eth_chainId: obs.chainId ?? '0x190f1ca9', // 420420777
      eth_blockNumber: obs.block ?? '0x19db3', // 105907
      web3_clientVersion: obs.client ?? 'portaldot/v3.0.0',
    };
    return rpcResult(input.id, results[input.method] ?? '');
  });

class FakeExplorer {
  constructor(private readonly handler: () => Promise<V3HttpAvailabilityResult> | V3HttpAvailabilityResult) {}
  get(): Promise<V3HttpAvailabilityResult> {
    return Promise.resolve(this.handler());
  }
}

const okExplorer = (): FakeExplorer =>
  new FakeExplorer(() => ({
    httpStatus: 200,
    contentType: 'text/html; charset=utf-8',
    bodyPrefix: '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Portaldot Node Console</title></head>',
    bodyBytes: 120,
  }));

const allOk = (
  obs: { chainId?: string; block?: string; client?: string } = {},
): { substrate: FakeSubstrate; evmRpc: FakeEvm; explorer: FakeExplorer } => ({
  substrate: okSubstrate(),
  evmRpc: okEvm(obs),
  explorer: okExplorer(),
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe('V3 endpoint configuration', () => {
  it('uses the official V3 endpoints as overridable defaults', () => {
    const probe = new V3ConnectivityProbe();
    expect(probe.config).toEqual({
      substrateWsUrl: 'wss://test-node-v3.portaldot.dev',
      evmRpcUrl: 'https://test-evm-rpc-v3.portaldot.dev',
      explorerUrl: 'https://node-console.portaldot.dev',
      expectedEvmChainId: 420420777,
      probeTimeoutMs: 15_000,
    });
  });

  it('applies env overrides, with explicit options winning over env', () => {
    vi.stubEnv(V3_ENV_KEYS.evmRpc, 'https://env.example.test/rpc');
    vi.stubEnv(V3_ENV_KEYS.evmChainId, '9');
    vi.stubEnv(V3_ENV_KEYS.probeTimeoutMs, '750');

    expect(new V3ConnectivityProbe().config).toMatchObject({
      evmRpcUrl: 'https://env.example.test/rpc',
      expectedEvmChainId: 9,
      probeTimeoutMs: 750,
      // untouched fields keep their defaults
      substrateWsUrl: V3_ENDPOINT_DEFAULTS.substrateWs,
      explorerUrl: V3_ENDPOINT_DEFAULTS.explorer,
    });

    const explicit = new V3ConnectivityProbe({
      config: { evmRpcUrl: 'https://explicit.example.test', expectedEvmChainId: 7 },
    });
    expect(explicit.config.evmRpcUrl).toBe('https://explicit.example.test');
    expect(explicit.config.expectedEvmChainId).toBe(7);
    expect(explicit.config.probeTimeoutMs).toBe(750); // env still wins where nothing explicit
  });

  it('rejects invalid configuration by naming the KEY, never the value', () => {
    vi.stubEnv(V3_ENV_KEYS.substrateWs, 'ftp://user:secret@bad.example.test/x');
    let err: unknown;
    try {
      void new V3ConnectivityProbe();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KaizenError);
    if (!(err instanceof KaizenError)) throw new Error('expected a KaizenError');
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain('substrateWsUrl');
    expect(err.message).not.toContain('secret');
    expect(err.message).not.toContain('ftp://');
    expect(err.message).not.toContain('bad.example.test');
  });

  it('rejects a non-numeric chain-id env value', () => {
    vi.stubEnv(V3_ENV_KEYS.evmChainId, 'not-a-number');
    expect(() => resolveV3Config()).toThrowError(/expectedEvmChainId/);
  });

  it('redacts endpoints to their origin (userinfo/path/query stripped)', () => {
    expect(redactEndpointUrl('wss://alice:s3cret@ws.example.test/v3/TOK?apikey=1')).toBe(
      'wss://ws.example.test',
    );
    expect(redactEndpointUrl('https://node-console.portaldot.dev/path')).toBe(
      'https://node-console.portaldot.dev',
    );
    expect(redactEndpointUrl('not a url')).toBe('[invalid-url]');
  });
});

describe('V3 connectivity probe (mocked transports)', () => {
  it('reports success for all three endpoints, independently and with real observations', async () => {
    const t = allOk();
    const probe = new V3ConnectivityProbe({ transports: t });
    const report = await probe.probeAll();

    expect(report.healthy).toBe(true);
    expect(report.substrate.status).toBe('ok');
    expect(report.substrate.substrate).toEqual(CHAIN_OK);
    expect(report.substrate.endpoint).toBe(V3_ENDPOINT_DEFAULTS.substrateWs);
    expect(t.substrate.calls[0]?.connectTimeoutMs).toBe(V3_ENDPOINT_DEFAULTS.probeTimeoutMs);
    expect(t.substrate.calls[0]?.signal).toBeDefined();

    expect(report.evm.status).toBe('ok');
    expect(report.evm.evm).toEqual({
      chainId: 420420777,
      expectedChainId: 420420777,
      blockNumber: 105_907,
      clientVersion: 'portaldot/v3.0.0',
    });
    expect(report.evm.error).toBeNull();

    expect(report.explorer.status).toBe('ok');
    expect(report.explorer.explorer).toEqual({
      httpStatus: 200,
      contentType: 'text/html; charset=utf-8',
      bodyBytes: 120,
      documentTitle: 'Portaldot Node Console',
    });
    // Honesty note: the explorer check is availability-only by design.
    expect(report.explorer.warnings.join(' ')).toContain('availability check only');

    expect(report.config.expectedEvmChainId).toBe(420420777);
    expect(report.config.substrateWs).toBe(V3_ENDPOINT_DEFAULTS.substrateWs);
    for (const result of [report.substrate, report.evm, report.explorer]) {
      expect(Date.parse(result.at)).not.toBeNaN();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps results independent when the substrate endpoint is down', async () => {
    const t = allOk();
    t.substrate = new FakeSubstrate(() =>
      Promise.reject(new KaizenError('RPC_CONNECTION_FAILED', 'connect ECONNREFUSED')),
    );
    const report = await probeV3Connectivity({ transports: t });

    expect(report.substrate.status).toBe('unavailable');
    expect(report.substrate.error?.kind).toBe('unavailable');
    expect(report.substrate.substrate).toEqual({
      chainName: null,
      health: null,
      best: null,
    });
    // The other endpoints still produced their own full results:
    expect(report.evm.status).toBe('ok');
    expect(report.explorer.status).toBe('ok');
    expect(report.evm.evm?.chainId).toBe(420420777);
    expect(report.healthy).toBe(false);
  });

  it('keeps results independent when the EVM endpoint is down', async () => {
    const t = allOk();
    t.evmRpc = new FakeEvm(() => {
      throw new KaizenError('RPC_CONNECTION_FAILED', 'fetch failed');
    });
    const report = await probeV3Connectivity({ transports: t });

    expect(report.evm.status).toBe('unavailable');
    // Never fabricated when unobserved:
    expect(report.evm.evm).toEqual({
      chainId: null,
      expectedChainId: 420420777,
      blockNumber: null,
      clientVersion: null,
    });
    expect(report.substrate.status).toBe('ok');
    expect(report.explorer.status).toBe('ok');
    expect(report.healthy).toBe(false);
  });

  it('times out a hung endpoint within the deadline, signals cleanup, and stays bounded', async () => {
    const t = allOk();
    t.substrate = hangSubstrate();
    const started = Date.now();
    const report = await probeV3Connectivity({
      config: { probeTimeoutMs: 500 },
      transports: t,
    });
    const elapsed = Date.now() - started;

    expect(report.substrate.status).toBe('timeout');
    expect(report.substrate.error?.kind).toBe('timeout');
    expect(report.substrate.latencyMs).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(4_000); // bounded — never hangs the suite
    // Deterministic cleanup: the transport received the abort signal.
    expect(t.substrate.aborts).toBe(1);
    expect(t.substrate.calls[0]?.signal?.aborted).toBe(true);
    // Sibling endpoints were still probed:
    expect(report.evm.status).toBe('ok');
    expect(report.explorer.status).toBe('ok');
    expect(report.healthy).toBe(false);
  });

  it('returns three distinct results when all endpoints fail differently (no short-circuit)', async () => {
    const substrate = new FakeSubstrate(() =>
      Promise.reject(new KaizenError('RPC_CONNECTION_FAILED', 'ws connect refused')),
    );
    const evmRpc = new FakeEvm((input) => ({ httpStatus: 503, json: null, id: input.id }));
    const explorer = new FakeExplorer(() => new Promise<V3HttpAvailabilityResult>(() => undefined));

    const report = await probeV3Connectivity({
      config: { probeTimeoutMs: 500 },
      transports: { substrate, evmRpc, explorer },
    });

    expect(report.substrate.status).toBe('unavailable');
    expect(report.evm.status).toBe('protocol-error');
    expect(report.evm.detail).toContain('HTTP 503');
    expect(report.explorer.status).toBe('timeout');
    expect(report.healthy).toBe(false);
    // Every endpoint still present — none suppressed:
    expect(report.substrate.role).toBe('substrate-ws');
    expect(report.evm.role).toBe('evm-rpc');
    expect(report.explorer.role).toBe('explorer');
  });

  it('classifies a 200 response with a non-JSON body as malformed-response', async () => {
    const t = allOk();
    t.evmRpc = new FakeEvm((input) => ({ httpStatus: 200, json: null, id: input.id }));
    const report = await probeV3Connectivity({ transports: t });

    expect(report.evm.status).toBe('malformed-response');
    expect(report.evm.detail).toContain('not a JSON object');
    expect(report.healthy).toBe(false);
  });

  it('reports a JSON-RPC error object as protocol-error even with HTTP 200', async () => {
    const t = allOk();
    t.evmRpc = new FakeEvm((input) => ({
      httpStatus: 200,
      json: {
        jsonrpc: '2.0',
        id: input.id,
        error: { code: -32000, message: 'execution reverted' },
      },
      id: input.id,
    }));
    const report = await probeV3Connectivity({ transports: t });

    expect(report.evm.status).toBe('protocol-error');
    expect(report.evm.detail).toContain('RPC error -32000');
    expect(report.evm.detail).toContain('execution reverted');
    expect(report.evm.evm?.chainId).toBeNull();
    expect(report.healthy).toBe(false);
  });

  it('validates the JSON-RPC envelope: version, id, and result/error presence', async () => {
    // id mismatch
    const mismatched = allOk();
    mismatched.evmRpc = new FakeEvm((input) => ({
      httpStatus: 200,
      json: { jsonrpc: '2.0', id: 999_999, result: '0x1' },
      id: input.id,
    }));
    const r1 = await probeV3Connectivity({ transports: mismatched });
    expect(r1.evm.status).toBe('protocol-error');
    expect(r1.evm.detail).toContain('id mismatch');

    // wrong jsonrpc version
    const badVersion = allOk();
    badVersion.evmRpc = new FakeEvm((input) => ({
      httpStatus: 200,
      json: { jsonrpc: '1.0', id: input.id, result: '0x1' },
      id: input.id,
    }));
    const r2 = await probeV3Connectivity({ transports: badVersion });
    expect(r2.evm.status).toBe('protocol-error');
    expect(r2.evm.detail).toContain('jsonrpc version');

    // neither result nor error
    const empty = allOk();
    empty.evmRpc = new FakeEvm((input) => ({
      httpStatus: 200,
      json: { jsonrpc: '2.0', id: input.id },
      id: input.id,
    }));
    const r3 = await probeV3Connectivity({ transports: empty });
    expect(r3.evm.status).toBe('protocol-error');
    expect(r3.evm.detail).toContain('neither result nor error');
  });

  it('reports an unexpected chain id as mismatch — never as a healthy expected-network check', async () => {
    const t = allOk({ chainId: '0x64' }); // 100 ≠ 420420777
    const report = await probeV3Connectivity({ transports: t });

    expect(report.evm.status).toBe('mismatch');
    expect(report.evm.error?.kind).toBe('mismatch');
    expect(report.evm.evm).toMatchObject({ chainId: 100, expectedChainId: 420420777 });
    expect(report.evm.detail).toContain('expects');
    expect(report.evm.detail).toContain('not the expected network');
    expect(report.healthy).toBe(false);
    // The other reads still happened and are reported:
    expect(report.evm.evm?.blockNumber).toBe(105_907);
  });

  it('reports invalid block-height and header data as malformed-response with partial observations kept', async () => {
    // EVM: block number is not a hex quantity
    const evmBad = allOk({ block: '0xZZ' });
    const r1 = await probeV3Connectivity({ transports: evmBad });
    expect(r1.evm.status).toBe('malformed-response');
    expect(r1.evm.detail).toContain('eth_blockNumber');
    expect(r1.evm.evm?.blockNumber).toBeNull();
    expect(r1.evm.evm?.chainId).toBe(420420777); // good read still reported

    // Substrate: header height/hash garbage — chain/health observed, best null
    const substrateBad = allOk();
    substrateBad.substrate = new FakeSubstrate(async () => ({
      chainName: 'PortaldotV3 Test',
      health: { isSyncing: false, peers: 2, shouldHavePeers: false },
      best: { number: 'garbage', hash: 'not-a-hash' },
    }));
    const r2 = await probeV3Connectivity({ transports: substrateBad });
    expect(r2.substrate.status).toBe('malformed-response');
    expect(r2.substrate.detail).toContain('best header');
    expect(r2.substrate.substrate).toEqual({
      chainName: 'PortaldotV3 Test',
      health: { isSyncing: false, peers: 2, shouldHavePeers: false },
      best: null,
    });

    // Substrate: malformed health
    const healthBad = allOk();
    healthBad.substrate = new FakeSubstrate(async () => ({
      chainName: 'PortaldotV3 Test',
      health: { isSyncing: 'nope', peers: -1, shouldHavePeers: false } as never,
      best: CHAIN_OK.best,
    }));
    const r3 = await probeV3Connectivity({ transports: healthBad });
    expect(r3.substrate.status).toBe('malformed-response');
    expect(r3.substrate.detail).toContain('system_health malformed');
    expect(r3.substrate.substrate?.health).toBeNull();

    // Substrate: hex heights ARE accepted when valid
    const hexHeight = allOk();
    hexHeight.substrate = new FakeSubstrate(async () => ({
      ...CHAIN_OK,
      best: { number: '0x19db3', hash: `0x${'cd'.repeat(32)}` },
    }));
    const r4 = await probeV3Connectivity({ transports: hexHeight });
    expect(r4.substrate.status).toBe('ok');
    expect(r4.substrate.substrate?.best?.number).toBe(105_907);
  });

  it('treats an unsupported optional method as a warning, not a probe failure', async () => {
    const t = allOk();
    t.evmRpc = new FakeEvm((input) => {
      if (input.method === 'web3_clientVersion') {
        return {
          httpStatus: 200,
          json: { jsonrpc: '2.0', id: input.id, error: { code: -32601, message: 'method not found' } },
          id: input.id,
        };
      }
      const results: Record<string, string> = {
        eth_chainId: '0x190f1ca9',
        eth_blockNumber: '0x19db3',
      };
      return rpcResult(input.id, results[input.method] ?? '');
    });
    const report = await probeV3Connectivity({ transports: t });

    expect(report.evm.status).toBe('ok'); // required checks passed
    expect(report.evm.evm?.clientVersion).toBeNull();
    expect(report.evm.warnings.join(' ')).toContain('web3_clientVersion unavailable');
    expect(report.evm.warnings.join(' ')).toContain('-32601');
    expect(report.healthy).toBe(true);
  });

  it('never leaks credentials from config or error messages into any result', async () => {
    const credUrl = 'wss://alice:s3cret@ws-cred.example.test/v3/TOKEN123?apikey=qqq';
    const substrate = new FakeSubstrate(() =>
      Promise.reject(new KaizenError('RPC_CONNECTION_FAILED', `Cannot connect to ${credUrl}`)),
    );
    const evm = new FakeEvm((input) => {
      // A hostile/buggy transport echoing credentials in an RPC error must
      // be scrubbed before the message reaches the result:
      if (input.method === 'eth_chainId') {
        return {
          httpStatus: 200,
          json: { jsonrpc: '2.0', id: input.id, error: { code: -1, message: `bad gateway via ${credUrl}` } },
          id: input.id,
        };
      }
      return rpcResult(input.id, '0x19db3');
    });
    const report = await probeV3Connectivity({
      config: { substrateWsUrl: credUrl },
      transports: { substrate, evmRpc: evm, explorer: okExplorer() },
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('s3cret');
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('TOKEN123');
    expect(serialized).not.toContain('apikey');
    expect(serialized).not.toContain('qqq');
    expect(report.substrate.endpoint).toBe('wss://ws-cred.example.test');
    expect(report.config.substrateWs).toBe('wss://ws-cred.example.test');
    expect(report.substrate.error?.message).toContain('wss://ws-cred.example.test');
    expect(report.evm.error?.message ?? report.evm.detail).not.toContain('s3cret');
  });

  it('performs read-only protocol calls: no writes, no signing, no auth headers', async () => {
    const t = allOk();
    const report = await new V3ConnectivityProbe({ transports: t }).probeAll();

    // EVM: strict read-only allowlist, empty params, no header/auth inputs.
    expect([...new Set(t.evmRpc.calls.map((c) => c.method))].sort()).toEqual([
      'eth_blockNumber',
      'eth_chainId',
      'web3_clientVersion',
    ]);
    expect(t.evmRpc.calls.every((c) => Array.isArray(c.params) && c.params.length === 0)).toBe(true);
    expect(Object.keys(t.evmRpc.calls[0] ?? {})).not.toContain('headers');
    expect(Object.keys(t.evmRpc.calls[0] ?? {})).not.toContain('auth');
    // Substrate: a single read call carrying only URL/timeouts/signal.
    expect(t.substrate.calls).toHaveLength(1);
    expect([...new Set(Object.keys(t.substrate.calls[0] ?? {}))].sort()).toEqual([
      'connectTimeoutMs',
      'requestTimeoutMs',
      'signal',
      'wsUrl',
    ]);
    // Explorer: availability transport has no verb/parameter surface at all.
    expect(report.healthy).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/Authorization|Bearer |eth_sendTransaction|eth_sign/i);
  });

  it('classifies transport error codes (timeout / protocol) without waiting for the deadline', async () => {
    const timeoutCase = allOk();
    timeoutCase.substrate = new FakeSubstrate(() =>
      Promise.reject(new KaizenError('RPC_TIMEOUT', 'Timed out (15000ms) during: read')),
    );
    const r1 = await probeV3Connectivity({ transports: timeoutCase });
    expect(r1.substrate.status).toBe('timeout');
    expect(r1.substrate.latencyMs).toBeLessThan(1_000); // classification, not deadline wait

    const protocolCase = allOk();
    protocolCase.substrate = new FakeSubstrate(() =>
      Promise.reject(new KaizenError('RPC_ERROR', 'system_health RPC error')),
    );
    const r2 = await probeV3Connectivity({ transports: protocolCase });
    expect(r2.substrate.status).toBe('protocol-error');
  });

  it('accepts an already-aborted signal in the real substrate transport (offline)', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = new RealSubstrateTransport();
    await expect(
      transport.read({
        wsUrl: 'ws://127.0.0.1:1', // closed local port — never dialed after abort
        connectTimeoutMs: 200,
        requestTimeoutMs: 200,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
  });

  it('probeEndpoint probes a single configured endpoint with the same contract', async () => {
    const probe = new V3ConnectivityProbe({ transports: allOk() });
    const evm = await probe.probeEndpoint('evm-rpc');
    expect(evm.role).toBe('evm-rpc');
    expect(evm.status).toBe('ok');
    expect(evm.endpoint).toBe(V3_ENDPOINT_DEFAULTS.evmRpc);
  });
});
