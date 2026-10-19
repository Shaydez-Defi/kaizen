/**
 * LIVE test — T-8.1 V3 connectivity probe against the OFFICIAL Portaldot V3
 * endpoints (configuration defaults from V3_ENDPOINT_DEFAULTS).
 *
 * Gated on KAIZEN_TEST_V3=1, independent of KAIZEN_TEST_LIVE. Without that
 * gate the suite is SKIPPED — a skipped check is never a passed check.
 *
 * Evidence: the sanitized report (origin-redacted endpoints, timestamps,
 * observations) is logged so docs/TECHNICAL_RESEARCH.md and the phase
 * report can cite actual values. Assertion strength: every status must be
 * `ok` with real observations — if an endpoint is unreachable, times out,
 * or reports a different chain id, THIS TEST FAILS and the blockage is
 * recorded honestly (never converted into a pass).
 */

import { describe, expect, it } from 'vitest';
import { V3_ENDPOINT_DEFAULTS, probeV3Connectivity } from '@kaizen/engine';

const V3_LIVE = process.env['KAIZEN_TEST_V3'] === '1';

describe.runIf(V3_LIVE)('V3 connectivity probe (live, real V3 endpoints)', () => {
  it('probes substrate WS, EVM JSON-RPC, and explorer with real, typed observations', async () => {
    const report = await probeV3Connectivity();
    // Evidence line: full report is credential-free by construction.
    console.log(`[v3-live] ${JSON.stringify(report)}`);

    // One typed result per endpoint, real timestamps.
    expect(report.substrate.role).toBe('substrate-ws');
    expect(report.evm.role).toBe('evm-rpc');
    expect(report.explorer.role).toBe('explorer');
    expect(Date.parse(report.at)).not.toBeNaN();

    // Substrate WS: connected + chain name + health + best header observed.
    expect(report.substrate.status).toBe('ok');
    expect(report.substrate.error).toBeNull();
    expect(report.substrate.substrate?.chainName).toBeTruthy();
    expect(report.substrate.substrate?.health?.peers).toBeGreaterThanOrEqual(0);
    expect(typeof report.substrate.substrate?.health?.isSyncing).toBe('boolean');
    expect(report.substrate.substrate?.best?.number).toBeGreaterThanOrEqual(0);
    expect(report.substrate.substrate?.best?.hash).toMatch(/^0x[0-9a-f]+$/i);

    // EVM JSON-RPC: protocol answers validated; observed chain id must equal
    // the configured expectation — a mismatch fails here as `mismatch`.
    expect(report.evm.status).toBe('ok');
    expect(report.evm.evm?.expectedChainId).toBe(V3_ENDPOINT_DEFAULTS.evmChainId);
    expect(report.evm.evm?.chainId).toBe(V3_ENDPOINT_DEFAULTS.evmChainId); // 420420777
    expect(report.evm.evm?.blockNumber).toBeGreaterThan(0);

    // Explorer: public HTTP availability ONLY (scope recorded in warnings).
    expect(report.explorer.status).toBe('ok');
    expect(report.explorer.explorer?.httpStatus).toBeGreaterThanOrEqual(200);
    expect(report.explorer.explorer?.httpStatus).toBeLessThan(300);
    expect(report.explorer.explorer?.contentType).toContain('html');
    expect(report.explorer.explorer?.documentTitle).toBeTruthy();

    expect(report.healthy).toBe(true);

    // Configuration observed as configured: origin-redacted, no credentials,
    // no path/query fragments anywhere in the report.
    expect(report.config.substrateWs).toBe('wss://test-node-v3.portaldot.dev');
    expect(report.config.evmRpc).toBe('https://test-evm-rpc-v3.portaldot.dev');
    expect(report.config.explorer).toBe('https://node-console.portaldot.dev');
    expect(report.config.expectedEvmChainId).toBe(420420777);
    expect(report.substrate.endpoint).toBe('wss://test-node-v3.portaldot.dev');
    expect(report.evm.endpoint).toBe('https://test-evm-rpc-v3.portaldot.dev');
    expect(report.explorer.endpoint).toBe('https://node-console.portaldot.dev');
  }, 90_000);
});
