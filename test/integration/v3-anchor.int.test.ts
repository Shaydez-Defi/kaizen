/**
 * LIVE test — T-8.2 V3 run anchoring against the REAL Portaldot V3 test
 * network. This SPENDS tPOT from the operator's testnet-only signer.
 *
 * Gates (all required, otherwise the suite is SKIPPED — never "passed"):
 *   KAIZEN_TEST_V3_WRITE=1     explicit opt-in to on-chain writes
 *   KAIZEN_V3_SIGNER_SURI      testnet-only secret URI (never logged)
 * Optional:
 *   KAIZEN_V3_REGISTRY_ADDRESS also exercise the contract path against an
 *                              already-deployed KaizenRunRegistry
 *
 * The anchored run is a FIXTURE row (scenario name "kaizen-live-test-fixture")
 * inserted into a temp SQLite store — it exercises the write/verify path, it
 * is not Failure Lab evidence. Real-run evidence is produced with the CLI
 * (`kaizen v3 anchor <runId>`) and recorded in docs/PROGRESS.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventBus, StateStore, V3AnchorService, type ScenarioRunRecord } from '@kaizen/engine';

const WRITE = process.env['KAIZEN_TEST_V3_WRITE'] === '1' && !!process.env['KAIZEN_V3_SIGNER_SURI'];
const REGISTRY = process.env['KAIZEN_V3_REGISTRY_ADDRESS'];

function fixtureRun(store: StateStore): ScenarioRunRecord {
  const at = new Date().toISOString();
  const id = `run-livefixture-${Date.now().toString(36)}`;
  store.insertScenarioRun({
    id,
    scenarioId: 'scn-live-fixture',
    scenarioName: 'kaizen-live-test-fixture',
    scenarioSchemaVersion: 1,
    snapshot: { id: 'scn-live-fixture', note: 'live anchoring test fixture (not a Failure Lab run)' },
    networkId: 'none',
    networkName: 'none',
    targetNodes: [],
    requestedBy: 'v3-anchor.int.test',
    replayOfRunId: null,
    state: 'completed',
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
  return store.getScenarioRun(id);
}

describe.runIf(WRITE)('V3 anchoring (live writes to the V3 TEST network)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-v3-write-'));
  const store = new StateStore(path.join(dir, 'kaizen.db'));
  const svc = new V3AnchorService({ store, events: new EventBus() });

  it('reports a funded signer on the expected chain', async () => {
    const status = await svc.status();
    console.log(`[v3-write] status ${JSON.stringify({ ...status, signer: { ...status.signer } })}`);
    expect(status.error).toBeNull();
    expect(status.chainName).toBe('PortaldotV3 Test');
    expect(BigInt(status.signer.freeBalance ?? '0')).toBeGreaterThan(0n);
  });

  it('anchors a fixture run via system.remarkWithEvent and verifies it on chain', async () => {
    const run = fixtureRun(store);
    const anchor = await svc.anchorRun(run.id, { method: 'remark', requestedBy: 'live-test' });
    console.log(`[v3-write] remark anchor ${JSON.stringify(anchor)}`);
    expect(['in-block', 'finalized']).toContain(anchor.status);
    expect(anchor.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(anchor.blockNumber).toBeGreaterThan(0);
    const v = await svc.verify(anchor.id);
    console.log(`[v3-write] verify ${JSON.stringify(v)}`);
    expect(v.verdict).toBe('verified');
  });

  it.runIf(!!REGISTRY)('anchors a fixture run via KaizenRunRegistry and reads anchoredAt back', async () => {
    const run = fixtureRun(store);
    const anchor = await svc.anchorRun(run.id, { method: 'contract', requestedBy: 'live-test' });
    console.log(`[v3-write] contract anchor ${JSON.stringify(anchor)}`);
    expect(['in-block', 'finalized']).toContain(anchor.status);
    expect(anchor.contractAddress).toBe(REGISTRY?.toLowerCase());
    const v = await svc.verify(anchor.id);
    console.log(`[v3-write] verify ${JSON.stringify(v)}`);
    expect(v.verdict).toBe('verified');
    expect(v.onChainAnchoredAt).toBeGreaterThan(0);
    expect(v.contractCodePresent).toBe(true);
  });
});
