/**
 * V3 API tests (T-8.1 probe route + T-8.2 anchoring routes).
 *
 * Real Fastify app + real SQLite (temp dataDir) via app.inject. The chain is
 * a scripted fake connector and the probe is injected — no network access.
 * The signer is the public DEV URI `//Alice` (test material, not a secret).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  RUN_ANCHORED_TOPIC,
  V3AnchorService,
  createEngine,
  type KaizenEngine,
  type ScenarioRunRecord,
  type V3ChainConnector,
  type V3ChainSession,
  type V3ConnectivityReport,
  type V3TxReceipt,
} from '@kaizen/engine';
import { createServer } from '../src/server';

const REGISTRY = '0x' + 'ab'.repeat(20);

function receipt(over: Partial<V3TxReceipt> = {}): V3TxReceipt {
  return {
    txHash: '0x' + '11'.repeat(32),
    blockHash: '0x' + '22'.repeat(32),
    blockNumber: 77,
    extrinsicIndex: 1,
    finalized: true,
    events: ['system.Remarked', 'system.ExtrinsicSuccess'],
    logs: [],
    instantiated: null,
    remarkHash: null,
    ...over,
  };
}

const fakeChain: V3ChainConnector = {
  async connect(): Promise<V3ChainSession> {
    return {
      info: async () => ({
        chainName: 'PortaldotV3 Test',
        genesisHash: '0x' + 'd4'.repeat(32),
        specName: 'portaldot-v3',
        specVersion: 3002,
        tokenSymbol: 'tPOT',
        tokenDecimals: 14,
        bestNumber: 100,
      }),
      freeBalance: async () => 10n ** 16n,
      evmAddressOf: async () => '0x' + '31'.repeat(20),
      blockHashAt: async () => '0x' + '22'.repeat(32),
      remarkAt: async () => null,
      submitRemark: async () => receipt(),
      deployContract: async () => receipt({ instantiated: REGISTRY }),
      callContract: async (_s, contract, calldata) =>
        receipt({
          events: ['revive.ContractEmitted', 'system.ExtrinsicSuccess'],
          logs: [
            {
              contract,
              topics: [RUN_ANCHORED_TOPIC, '0x' + calldata.slice(10, 74), '0x' + '00'.repeat(32)],
              data: '0x' + '0'.repeat(63) + '1' + (64).toString(16).padStart(64, '0') + '0'.repeat(64),
            },
          ],
        }),
      readContract: async () => '0x' + '0'.repeat(63) + '1',
      close: async () => undefined,
    };
  },
};

const fakeReport: V3ConnectivityReport = {
  at: 'now',
  config: {
    substrateWs: 'wss://test-node-v3.portaldot.dev',
    evmRpc: 'https://test-evm-rpc-v3.portaldot.dev',
    explorer: 'https://node-console.portaldot.dev',
    expectedEvmChainId: 420420777,
    probeTimeoutMs: 15000,
  },
  substrate: { role: 'substrate-ws', endpoint: 'wss://test-node-v3.portaldot.dev', status: 'ok', detail: 'ok', latencyMs: 5, at: 'now', error: null, warnings: [] },
  evm: { role: 'evm-rpc', endpoint: 'https://test-evm-rpc-v3.portaldot.dev', status: 'ok', detail: 'ok', latencyMs: 5, at: 'now', error: null, warnings: [] },
  explorer: { role: 'explorer', endpoint: 'https://node-console.portaldot.dev', status: 'ok', detail: 'ok', latencyMs: 5, at: 'now', error: null, warnings: [] },
  healthy: true,
};

function insertRun(engine: KaizenEngine, id: string, state: ScenarioRunRecord['state']): void {
  const at = '2026-10-21T10:00:00.000Z';
  engine.store.insertScenarioRun({
    id,
    scenarioId: 'scn',
    scenarioName: 'pause alice',
    scenarioSchemaVersion: 1,
    snapshot: { id: 'scn', name: 'pause alice' },
    networkId: 'net_1',
    networkName: 'demo',
    targetNodes: [],
    requestedBy: 'test',
    replayOfRunId: null,
    state,
    currentStepId: null,
    currentStepOrder: null,
    steps: [],
    validation: null,
    warnings: [],
    error: null,
    cleanup: null,
    cancellation: null,
    createdAt: at,
    startedAt: at,
    updatedAt: at,
    finishedAt: at,
  } as unknown as ScenarioRunRecord);
}

describe('V3 API (real app + real SQLite, fake chain)', () => {
  let engine: KaizenEngine;
  let app: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-v3-api-'));
    engine = createEngine({ dataDir: dir, binaryCacheDir: path.join(dir, 'bin') });
    engine.v3Anchors = new V3AnchorService({
      store: engine.store,
      events: engine.events,
      connector: fakeChain,
      env: { KAIZEN_V3_SIGNER_SURI: '//Alice' },
      evmRpc: { post: async () => ({ httpStatus: 200, json: { result: '0x60' }, id: 1 }) },
    });
    app = createServer(engine, { probeV3: async () => fakeReport });
    await app.ready();
    insertRun(engine, 'run-done', 'completed');
    insertRun(engine, 'run-live', 'running');
  });

  afterAll(async () => {
    await app.close();
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves the read-only probe report', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v3/probe' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, report: { healthy: true } });
  });

  it('serves status with the public signer address only', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v3/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status.signer).toMatchObject({ configured: true, address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY' });
    expect(res.body).not.toContain('//Alice');
  });

  it('requires mode:execute and validates the body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v3/anchors', payload: { runId: 'run-done' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_INPUT');
    const bad = await app.inject({ method: 'POST', url: '/api/v3/anchors', payload: { mode: 'execute', runId: 'run-done', method: 'evm' } });
    expect(bad.statusCode).toBe(400);
  });

  it('maps engine refusals to structured 4xx', async () => {
    const noRegistry = await app.inject({ method: 'POST', url: '/api/v3/anchors', payload: { mode: 'execute', runId: 'run-done' } });
    expect(noRegistry.statusCode).toBe(409);
    expect(noRegistry.json().error.code).toBe('V3_REGISTRY_NOT_DEPLOYED');
    const live = await app.inject({ method: 'POST', url: '/api/v3/anchors', payload: { mode: 'execute', runId: 'run-live', method: 'remark' } });
    expect(live.statusCode).toBe(409);
    expect(live.json().error.code).toBe('V3_RUN_NOT_ANCHORABLE');
    const missing = await app.inject({ method: 'POST', url: '/api/v3/anchors', payload: { mode: 'execute', runId: 'nope', method: 'remark' } });
    expect(missing.statusCode).toBe(404);
    const anchorMissing = await app.inject({ method: 'GET', url: '/api/v3/anchors/anc-nope' });
    expect(anchorMissing.statusCode).toBe(404);
    expect(anchorMissing.json().error.code).toBe('V3_ANCHOR_NOT_FOUND');
  });

  it('anchors a finished run (201), lists it with the explorer template, and verifies it', async () => {
    const hash = await app.inject({ method: 'GET', url: '/api/v3/runs/run-done/hash' });
    expect(hash.json()).toMatchObject({ ok: true, runId: 'run-done', anchorable: true });

    const res = await app.inject({ method: 'POST', url: '/api/v3/anchors', payload: { mode: 'execute', runId: 'run-done', method: 'remark' } });
    expect(res.statusCode).toBe(201);
    const anchor = res.json().anchor;
    expect(anchor).toMatchObject({ runId: 'run-done', runHash: hash.json().runHash, status: 'finalized', requestedBy: 'api', blockNumber: 77 });

    const dup = await app.inject({ method: 'POST', url: '/api/v3/anchors', payload: { mode: 'execute', runId: 'run-done', method: 'remark' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('V3_ALREADY_ANCHORED');

    const list = await app.inject({ method: 'GET', url: '/api/v3/anchors?runId=run-done' });
    expect(list.json().anchors).toHaveLength(1);
    expect(list.json().explorerBlockUrlTemplate).toContain('{block}');

    const one = await app.inject({ method: 'GET', url: `/api/v3/anchors/${anchor.id}` });
    expect(one.json().anchor.id).toBe(anchor.id);

    const verify = await app.inject({ method: 'POST', url: `/api/v3/anchors/${anchor.id}/verify` });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().verification.hashMatches).toBe(true);
  });

  it('never exposes registry deployment over HTTP', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v3/registry', payload: {} });
    expect(res.statusCode).toBe(404);
  });
});
