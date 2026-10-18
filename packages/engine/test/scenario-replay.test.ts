/**
 * ScenarioEngine REPLAY unit tests (T-3.5, Phase 3E).
 *
 * Replay re-executes a finished run's immutable snapshot as a NEW run through
 * the SAME engine path (gates → injector → evidence). These tests pin the
 * contract: distinct run id + provenance, source-run immutability, snapshot
 * independence from scenario edits/deletion, eligibility rules, authorization
 * posture (explicit target + mode marker), fresh gate re-evaluation
 * (quarantine/conflicts/unsupported ops), fresh evidence, and identical
 * failure/cancel/timeout semantics. Harness: ./scenario-harness.ts (REAL
 * stand-in node processes). Live portaldot_dev replay coverage lives in
 * test/integration/scenario-runs.int.test.ts.
 */

import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  StateStore,
  scenarioRunReplayNote,
  type FaultRecord,
  type ScenarioRunRecord,
} from '@kaizen/engine';
import {
  createScenario,
  defaultRun,
  disposeHarnesses,
  expectRunRefusal,
  expectThrownCode,
  makeHarness,
  pauseStep,
  peersGte,
  processRunning,
  recoveryVerified,
  unreachable,
  waitUntil,
  type RunHarness,
} from './scenario-harness';

afterEach(async () => {
  await disposeHarnesses();
});

type Snapshot = ScenarioRunRecord['snapshot'];

let craftCounter = 0;

/**
 * Insert a fabricated run row (raw store insert — no engine execution). Used
 * to build eligible/ineligible SOURCE runs cheaply and to plant snapshots the
 * authoring path would refuse today (a snapshot can always be older than the
 * current registry — replay must fail closed, not trust it).
 */
function craftRun(
  h: RunHarness,
  snapshot: Snapshot,
  overrides: Partial<ScenarioRunRecord> = {},
): ScenarioRunRecord {
  const at = new Date().toISOString();
  craftCounter += 1;
  const record: ScenarioRunRecord = {
    id: `run-craft-${craftCounter}`,
    scenarioId: snapshot.id,
    scenarioName: snapshot.name,
    scenarioSchemaVersion: snapshot.schemaVersion,
    snapshot,
    networkId: h.networkId,
    networkName: 'run-net',
    targetNodes: [],
    requestedBy: 'test',
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
    ...overrides,
  };
  h.store.insertScenarioRun(record);
  return record;
}

function replayCall(h: RunHarness, runId: string, overrides: Record<string, unknown> = {}) {
  return h.runs.replay({
    runId,
    networkIdOrName: h.networkId,
    mode: 'execute',
    requestedBy: 'test',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe('ScenarioEngine replay contract', () => {
  it('creates a distinct run from the source snapshot with fresh evidence and provenance', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'replay me', [
      pauseStep('s1', { postconditions: [recoveryVerified('alice')] }),
    ]);
    const source = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(source.state).toBe('completed');
    expect(source.replayOfRunId).toBeNull();
    const sourceJson = JSON.stringify(source);

    // Replay re-enters the engine path: the synchronous part persists the NEW
    // run (unique id, own timestamps) with provenance and the honesty warning.
    const started = replayCall(h, source.id);
    expect(started.id).not.toBe(source.id);
    expect(started.replayOfRunId).toBe(source.id);
    // Honest semantics ride the provenance field + explicit note (NOT the
    // warnings channel — a clean replay must reach plain 'completed').
    expect(started.warnings).toEqual([]);
    expect(scenarioRunReplayNote(started)).toContain('identical outcomes are NOT guaranteed');
    expect(scenarioRunReplayNote(source)).toBeNull();
    const created = h.eventLog.find(
      (e) => e.name === 'scenario-run.created' && (e.payload as { runId: string }).runId === started.id,
    );
    expect(created).toBeTruthy();
    expect((created!.payload as { replayOfRunId?: string }).replayOfRunId).toBe(source.id);

    const run = await h.runs.wait(started.id, 60_000);
    expect(run.state).toBe('completed');
    // Same recorded actions…
    expect(run.snapshot).toEqual(source.snapshot);
    expect(run.steps.map((s) => s.stepId)).toEqual(source.steps.map((s) => s.stepId));
    // …but FRESH evidence: new fault ids, no source evidence copied, and real
    // verification against the current node state.
    expect(run.steps[0]!.faultId).toBeTruthy();
    expect(run.steps[0]!.faultId).not.toBe(source.steps[0]!.faultId);
    expect(JSON.stringify(run.steps)).not.toContain(source.steps[0]!.faultId!);
    expect(run.steps[0]!.claims).toMatchObject({
      applied: true,
      effectObserved: true,
      faultRemoved: true,
      recovered: true,
      recoveryVerified: true,
    });
    expect(run.cleanup).toMatchObject({ verified: true, quarantined: false, activeFaultsFound: 0 });
    expect(h.injector.activeFaults()).toHaveLength(0);
    // The source run and its evidence are untouched (append-only history).
    expect(JSON.stringify(h.runs.get(source.id))).toBe(sourceJson);

    // Provenance survives store reopen (column round-trip).
    const reopened = new StateStore(path.join(h.dir, 'kaizen.db'));
    try {
      expect(reopened.getScenarioRun(run.id).replayOfRunId).toBe(source.id);
      expect(reopened.getScenarioRun(source.id).replayOfRunId).toBeNull();
    } finally {
      reopened.close();
    }
  }, 120_000);

  it('replays the recorded actions even after the scenario is edited or deleted', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'edited later', [
      pauseStep('s1', { postconditions: [recoveryVerified('alice')] }),
    ]);
    const source = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(source.state).toBe('completed');

    // Edit: the CURRENT definition diverges — replay must use the snapshot.
    h.scenarios.update(id, { description: 'edited after the source run' }, 'test');
    expect(h.scenarios.get(id).description).toBe('edited after the source run');

    // Delete: authoring is gone entirely — history must still be replayable.
    h.scenarios.remove(id, 'test');
    expectThrownCode(() => defaultRun(h, id), 'SCENARIO_NOT_FOUND');

    const run = await h.runs.wait(replayCall(h, source.id).id, 60_000);
    expect(run.state).toBe('completed');
    expect(run.scenarioId).toBe(id); // provenance of the deleted scenario
    expect(run.snapshot.description).toBe('scenario engine run test'); // NOT the edit
    expect(run.steps.map((s) => s.stepId)).toEqual(['s1']);
    expect(run.steps[0]!.faultId).not.toBe(source.steps[0]!.faultId);
    expect(run.replayOfRunId).toBe(source.id);
  }, 120_000);

  it('refuses ineligible, unknown, and snapshot-less sources without creating runs', async () => {
    const h = await makeHarness();
    const scen = h.scenarios.create(
      {
        name: 'eligibility',
        description: 'd',
        requires: { designatedTest: true, preset: 'two-node' },
        steps: [pauseStep('s1')],
      } as never,
      'test',
    );
    const snapshot = h.scenarios.get(scen.id);

    // rejected: terminal but never executed an action — execute() instead.
    const rejected = craftRun(h, snapshot, { state: 'rejected' });
    const err1 = expectThrownCode(() => replayCall(h, rejected.id), 'SCENARIO_RUN_NOT_REPLAYABLE');
    expect(err1.message).toContain('never executed');
    // Unfinished runs are never resumed or replayed.
    const unfinished = craftRun(h, snapshot, { state: 'running' });
    const err2 = expectThrownCode(() => replayCall(h, unfinished.id), 'SCENARIO_RUN_NOT_REPLAYABLE');
    expect(err2.message).toContain('unfinished');
    // Unknown source run.
    expectThrownCode(() => replayCall(h, 'run_missing'), 'SCENARIO_RUN_NOT_FOUND');
    // Malformed snapshots (missing or empty step list) fail closed.
    const noSnapshot = craftRun(h, { ...snapshot, steps: [] } as Snapshot);
    const err3 = expectThrownCode(
      () => replayCall(h, noSnapshot.id),
      'SCENARIO_RUN_NOT_REPLAYABLE',
    );
    expect(err3.message).toContain('no usable scenario snapshot');
    const emptySnapshot = craftRun(h, { ...snapshot, steps: undefined } as unknown as Snapshot);
    expectThrownCode(() => replayCall(h, emptySnapshot.id), 'SCENARIO_RUN_NOT_REPLAYABLE');

    // None of these pre-run refusals left a phantom run record behind:
    // only the four crafted source rows exist (nothing was executed).
    expect(h.runs.list({ limit: 200 }).runs).toHaveLength(4);
  });

  it('requires the explicit execute marker and an explicitly confirmed target', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'auth posture', [pauseStep('s1')]);
    const source = await h.runs.wait(defaultRun(h, id).id, 60_000);

    // No mode marker / no target → INVALID_INPUT, no run created.
    const before = h.runs.list({ limit: 200 }).total;
    expectThrownCode(() => h.runs.replay({ runId: source.id, mode: 'execute' }), 'INVALID_INPUT');
    expectThrownCode(
      () => h.runs.replay({ runId: source.id, networkIdOrName: h.networkId }),
      'INVALID_INPUT',
    );
    expect(h.runs.list({ limit: 200 }).total).toBe(before);

    // Unknown target → persisted rejection carrying replay provenance.
    const refusal = expectRunRefusal(
      h,
      () => replayCall(h, source.id, { networkIdOrName: 'ghost-net' }),
      'NETWORK_NOT_FOUND',
      'is not registered',
    );
    expect(refusal.replayOfRunId).toBe(source.id);

    // A target that is not designated for testing → gate refusal (current
    // DEC-008 state decides — past success grants nothing).
    const h2 = await makeHarness({ designatedTest: false });
    const scen2 = h2.scenarios.create(
      {
        name: 'needs designated',
        description: 'd',
        requires: { designatedTest: true, preset: 'two-node' },
        steps: [pauseStep('s1')],
      } as never,
      'test',
    );
    const phantomSource = craftRun(h2, h2.scenarios.get(scen2.id));
    const gateRefusal = expectRunRefusal(
      h2,
      () => replayCall(h2, phantomSource.id),
      'SCENARIO_EXEC_NOT_ALLOWED',
      'designated',
    );
    expect(gateRefusal.replayOfRunId).toBe(phantomSource.id);
  }, 120_000);

  it('re-evaluates current gates: conflicts and quarantine still block replay', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'gates fresh', [
      pauseStep('s1', { postconditions: [recoveryVerified('alice')] }),
    ]);
    const source = await h.runs.wait(defaultRun(h, id).id, 60_000);

    // Concurrent execution of the same scenario → replay conflicts (exactly
    // one run in flight per scenario/target — no duplicate side effects).
    const active = defaultRun(h, id);
    expectRunRefusal(
      h,
      () => replayCall(h, source.id),
      'SCENARIO_RUN_CONFLICT',
    );
    const cancelled = await h.runs.cancel(active.id, 'test');
    await h.runs.wait(cancelled.id, 30_000);

    // Quarantine planted AFTER the source ran: replay is refused fail-closed
    // (the source succeeding proves nothing about the current target state).
    const stuck: FaultRecord = {
      id: 'flt_replay_stuck',
      networkId: h.networkId,
      nodeId: h.nodeIds.alice,
      nodeName: 'run-net-alice',
      type: 'pause',
      mode: 'execute',
      state: 'cleanup-failed',
      requestedBy: 'test',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      reconciled: false,
    };
    h.store.insertFault(stuck);
    expectRunRefusal(h, () => replayCall(h, source.id), 'SCENARIO_EXEC_NOT_ALLOWED', 'quarantined');
  }, 120_000);

  it('keeps currently unsupported operations blocked even though the snapshot once ran', async () => {
    const h = await makeHarness();
    const scen = h.scenarios.create(
      {
        name: 'stale capability',
        description: 'd',
        requires: { designatedTest: true, preset: 'two-node' },
        steps: [pauseStep('s1')],
      } as never,
      'test',
    );
    const record = h.scenarios.get(scen.id);
    // A snapshot containing an operation the CURRENT registry refuses
    // (node-restart is planned, never implemented): replay must re-check
    // support with current capabilities and refuse — never trust the past
    // success the snapshot implies.
    const staleSnapshot: Snapshot = {
      ...record,
      steps: [
        {
          ...record.steps[0]!,
          operation: { type: 'node-restart', config: { node: 'alice' } },
        } as never,
      ],
    };
    const source = craftRun(h, staleSnapshot);
    const refusal = expectRunRefusal(
      h,
      () => replayCall(h, source.id),
      'SCENARIO_EXEC_NOT_ALLOWED',
      'node-restart',
    );
    expect(refusal.replayOfRunId).toBe(source.id);
    expect(refusal.validation?.valid ?? false).toBe(true); // authoring warns, run gates refuse
    expect(h.injector.activeFaults()).toHaveLength(0);
  });

  it('replays failed runs under the same failure semantics with fresh failure evidence', async () => {
    const h = await makeHarness();
    const id = createScenario(
      h,
      'failed source',
      [
        pauseStep('s1', {
          preconditions: [processRunning('alice')],
          postconditions: [unreachable('alice', 500)],
        }),
      ],
      { execution: { onStepFailed: 'abort-run' } },
    );
    const source = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(source.state).toBe('failed');
    expect(source.error?.code).toBe('VERIFICATION_FAILED');

    // failed is a REPLAYABLE state: same pipeline, same failure outcome —
    // but the replay's failure evidence is its own, not a copy.
    const run = await h.runs.wait(replayCall(h, source.id).id, 60_000);
    expect(run.state).toBe('failed');
    expect(run.error?.code).toBe(source.error!.code);
    expect(run.replayOfRunId).toBe(source.id);
    expect(run.steps[0]!.error?.code).toBe('VERIFICATION_FAILED');
    expect(run.steps[0]!.faultId).not.toBe(source.steps[0]!.faultId);
    expect(run.cleanup).toMatchObject({ verified: true, quarantined: false });
  }, 120_000);

  it('cancels a replay through injector.cancel with verified rollback (existing semantics)', async () => {
    const h = await makeHarness();
    const scen = h.scenarios.create(
      {
        name: 'cancel replay',
        description: 'd',
        requires: { designatedTest: true, preset: 'two-node' },
        steps: [pauseStep('s1')],
      } as never,
      'test',
    );
    // Source snapshot: a LONG hold so the replay is still mid-operation when
    // cancellation arrives (the source itself never executed this hold). The
    // preconditions keep the mandatory baseline + process-state pair.
    const record = h.scenarios.get(scen.id);
    const longHold: Snapshot = {
      ...record,
      steps: [
        {
          ...record.steps[0]!,
          timeoutMs: 120_000,
          operation: { type: 'pause', config: { node: 'alice', durationMs: 60_000 } },
          preconditions: [...(record.steps[0]!.preconditions as unknown[]), processRunning('alice')],
          postconditions: [recoveryVerified('alice')],
        } as never,
      ],
    };
    const source = craftRun(h, longHold);

    const pidBefore = h.childPid('alice');
    const replayed = replayCall(h, source.id);
    await waitUntil(() => h.injector.activeFaults().length === 1, 10_000);
    const cancelled = await h.runs.cancel(replayed.id, 'test');
    const run = await h.runs.wait(cancelled.id, 60_000);
    expect(run.state).toBe('cancelled');
    expect(run.steps[0]!.state).toBe('cancelled');
    expect(run.steps[0]!.claims).toMatchObject({
      applied: true,
      faultRemoved: true,
      recovered: true,
      recoveryVerified: true,
    });
    expect(run.cleanup).toMatchObject({ verified: true, quarantined: false });
    expect(h.injector.activeFaults()).toHaveLength(0);
    expect(h.childPid('alice')).toBe(pidBefore);
  }, 120_000);

  it('replays hit the step deadline with STEP_TIMEOUT and no fault (existing semantics)', async () => {
    const h = await makeHarness();
    const scen = h.scenarios.create(
      {
        name: 'timeout replay',
        description: 'd',
        requires: { designatedTest: true, preset: 'two-node' },
        steps: [pauseStep('s1')],
      } as never,
      'test',
    );
    const record = h.scenarios.get(scen.id);
    // Step deadline (5s, the schema minimum) hits while a conclusively-false
    // precondition is still polling (60s budget) → STEP_TIMEOUT before any
    // side effect.
    const tightSnapshot: Snapshot = {
      ...record,
      steps: [
        {
          ...record.steps[0]!,
          timeoutMs: 5_000,
          preconditions: [
            ...(record.steps[0]!.preconditions as unknown[]),
            peersGte(999, 60_000),
          ],
        } as never,
      ],
    };
    const source = craftRun(h, tightSnapshot);

    const run = await h.runs.wait(replayCall(h, source.id).id, 60_000);
    expect(run.state).toBe('failed');
    expect(run.error?.code).toBe('STEP_TIMEOUT');
    expect(run.steps[0]!.faultId).toBeNull(); // deadline hit BEFORE the operation
    expect(h.injector.activeFaults()).toHaveLength(0);
  }, 120_000);

  it('read-only access never executes; duplicate replays conflict; provenance is queryable', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'query provenance', [
      pauseStep('s1', { postconditions: [recoveryVerified('alice')] }),
    ]);
    const source = await h.runs.wait(defaultRun(h, id).id, 60_000);

    // Read-only: get + list never create runs or start execution.
    const before = h.runs.list({ limit: 200 }).total;
    h.runs.get(source.id);
    h.runs.list({ replayOf: source.id });
    expect(h.runs.list({ limit: 200 }).total).toBe(before);
    expect(h.runs.activeRuns()).toHaveLength(0);

    // Duplicate requests: the second replay conflicts while the first is in
    // flight (no accidental concurrent duplicate execution). The refused
    // attempt is itself a persisted replay with provenance — queryable, not
    // silently dropped.
    const first = replayCall(h, source.id);
    const conflictRun = expectRunRefusal(h, () => replayCall(h, source.id), 'SCENARIO_RUN_CONFLICT');
    expect(conflictRun.replayOfRunId).toBe(source.id);
    await h.runs.wait(first.id, 60_000);

    // After the first replay is terminal, a new replay is allowed again.
    const second = await h.runs.wait(replayCall(h, source.id).id, 60_000);
    expect(second.state).toBe('completed');

    // Every replay attempt is queryable from the source run, and the
    // summaries carry provenance (original-vs-replay is visible without
    // history edits).
    const replays = h.runs.list({ replayOf: source.id, limit: 50 });
    expect(replays.total).toBe(3);
    expect(replays.runs.map((r) => r.id).sort()).toEqual(
      [first.id, second.id, conflictRun.id].sort(),
    );
    expect(replays.runs.every((r) => r.replayOfRunId === source.id)).toBe(true);
    expect(replays.runs.find((r) => r.id === conflictRun.id)?.state).toBe('rejected');
    const all = h.runs.list({ limit: 200 });
    expect(all.runs.filter((r) => r.replayOfRunId === null).map((r) => r.id)).toContain(source.id);
  }, 180_000);
});
