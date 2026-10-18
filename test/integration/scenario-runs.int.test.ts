/**
 * LIVE test — T-3.4 ScenarioEngine against REAL portaldot_dev networks.
 *
 * Uses only disposable, Kaizen-created networks (designatedTest — DEC-008).
 * Every run-level claim is backed by an INDEPENDENT observation from the
 * test itself (its own RPC polling + process identity checks), not just the
 * run record's result object:
 *
 *  - pause run:      a saved scenario executes through the injector; the
 *                    victim is unreachable while held, then reachable again
 *                    with the SAME pid and a resumed chain (independently
 *                    observed around the run)
 *  - sequential:     two pause steps execute in declared order with distinct
 *                    fault records and no interleaving
 *  - policies:       a failing precondition aborts (no fault on the node);
 *                    skip-step continues the drill and the healthy step
 *                    still executes for real
 *  - cancellation:   cancelling during the hold interrupts via the
 *                    injector's supported mechanism and rollback is
 *                    independently verified (same pid, RPC back, no leak)
 *  - timeout:        step-deadline exhaustion is reported as STEP_TIMEOUT
 *                    with no fault ever created
 *  - gates:          phantom networks (non-designated, non-local chain) and
 *                    unresolvable labels are refused fail-closed with a
 *                    persisted rejected run — and execute nothing
 *  - replay:         a finished run is replayed as a NEW run on the same
 *                    engine path: fresh effect + fresh fault id observed by
 *                    the test itself, the source run stays byte-identical,
 *                    and ineligible sources are refused before any side effect
 *
 * Nothing here ever touches mainnet; destructive/failure paths are gated to
 * designated test networks (DEC-008 / DEC-009).
 */

import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEngine,
  isPidAlive,
  scenarioRunReplayNote,
  type KaizenEngine,
  type NodeConfig,
  type ScenarioInput,
  type ScenarioRunRecord,
} from '@kaizen/engine';
import {
  LIVE,
  SHARED_BIN_CACHE,
  ensureSharedBinary,
  httpRpc,
  testRoot,
  waitFor,
} from './testkit';

interface Health {
  isSyncing: boolean;
  peers: number;
  shouldHavePeers: boolean;
}

interface Header {
  number: string;
  hash: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function ping(port: number, timeoutMs = 800): Promise<boolean> {
  try {
    await httpRpc<Health>(port, 'system_health', [], timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function headNumber(port: number): Promise<number> {
  const h = await httpRpc<Header>(port, 'chain_getHeader');
  return Number.parseInt(h.number, 16);
}

const TERMINAL = ['completed', 'completed-with-warnings', 'failed', 'cancelled', 'cleanup-failed'];

describe.runIf(LIVE)('ScenarioEngine (live, real networks)', () => {
  let engine: KaizenEngine;
  let dir: string;
  let networkId: string;
  let aliceId: string;
  let aliceLabel: string;
  let alicePort: number;
  let bobLabel: string;

  async function waitTerminal(runId: string, timeoutMs = 120_000): Promise<ScenarioRunRecord> {
    const run = await engine.scenarioRuns.wait(runId, timeoutMs);
    expect(TERMINAL).toContain(run.state);
    return run;
  }

  function createRun(
    name: string,
    steps: Record<string, unknown>[],
    overrides: Record<string, unknown> = {},
  ): { scenarioId: string; run: ScenarioRunRecord } {
    const scenario = engine.scenarios.create(
      {
        name,
        description: 'live scenario run test',
        requires: { designatedTest: true, preset: 'two-node' },
        steps,
        ...overrides,
      } as unknown as ScenarioInput,
      'it',
    );
    const run = engine.scenarioRuns.execute({
      scenarioId: scenario.id,
      networkIdOrName: networkId,
      mode: 'execute',
      requestedBy: 'it',
    });
    return { scenarioId: scenario.id, run };
  }

  function pauseStep(
    id: string,
    node: string,
    opts: { durationMs?: number; timeoutMs?: number; extraPre?: unknown[] } = {},
  ): Record<string, unknown> {
    return {
      id,
      operation: {
        type: 'pause',
        config: {
          node,
          ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
        },
      },
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      preconditions: [
        { kind: 'rpc-reachable', node, expect: true },
        { kind: 'process-state', node, expect: ['running'] },
        ...(opts.extraPre ?? []),
      ],
      postconditions: [
        { kind: 'recovery-verified', node },
        { kind: 'rpc-reachable', node, expect: true },
      ],
    };
  }

  beforeAll(async () => {
    await ensureSharedBinary();
    dir = testRoot('scenario-runs');
    engine = createEngine({
      dataDir: dir,
      binaryCacheDir: SHARED_BIN_CACHE,
      healthTimeoutMs: 120_000,
    });

    const net = await engine.networks.create({ name: 'scen-it', preset: 'two-node' });
    expect(net.designatedTest).toBe(true); // the DEC-008 gate basis
    networkId = net.id;
    const { nodes } = engine.networks.getNetwork(networkId);
    aliceLabel = nodes[0]!.name.replace('scen-it-', '');
    bobLabel = nodes[1]!.name.replace('scen-it-', '');
    aliceId = nodes[0]!.id;
    alicePort = nodes[0]!.ports.rpc;

    const start = await engine.networks.start(networkId);
    expect(start.ok, `start failed: ${JSON.stringify(start.error)}`).toBe(true);

    await waitFor(
      async () =>
        (await httpRpc<Health>(nodes[1]!.ports.rpc, 'system_health')).peers >= 1 &&
        (await httpRpc<Health>(alicePort, 'system_health')).peers >= 1,
      { timeoutMs: 90_000, label: 'both nodes peers >= 1' },
    );
    expect(isPidAlive(engine.store.getNode(aliceId).pid!)).toBe(true);
  }, 300_000);

  afterAll(async () => {
    try {
      for (const n of engine.networks.list()) {
        if (n.status === 'running' || n.status === 'starting') {
          await engine.networks.stop(n.id);
        }
      }
    } finally {
      await engine.processes.killAll();
      await engine.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('executes a saved pause scenario through the injector with independent effect + recovery observation', async () => {
    const pidBefore = engine.store.getNode(aliceId).pid!;
    const headBefore = await headNumber(alicePort);

    const { run: accepted } = createRun('live pause drill', [
      pauseStep('s1', aliceLabel, { durationMs: 8_000, timeoutMs: 70_000 }),
    ]);
    expect(accepted.validation?.valid).toBe(true);

    // Independent observation of the EFFECT: while the run's fault is held,
    // the victim must stop answering RPC (R-22 A), sampled by the TEST
    // itself (the injector's active-fault list is the live truth channel).
    const samples: Array<{ reachable: boolean }> = [];
    const watcher = (async () => {
      for (;;) {
        samples.push({ reachable: await ping(alicePort) });
        const fresh = engine.scenarioRuns.get(accepted.id);
        if (TERMINAL.includes(fresh.state)) return;
        await sleep(500);
      }
    })();

    const run = await waitTerminal(accepted.id);
    await watcher;

    expect(run.state).toBe('completed');
    const step = run.steps[0]!;
    expect(step.state).toBe('completed');
    expect(step.claims).toMatchObject({
      applied: true,
      effectObserved: true,
      faultRemoved: true,
      recovered: true,
      recoveryVerified: true,
    });
    expect(step.verification).toBe('satisfied');
    expect(run.cleanup).toMatchObject({ verified: true, quarantined: false });

    // the run's effect really happened while it was held…
    expect(samples.some((s) => !s.reachable)).toBe(true);

    // …and recovery is proven INDEPENDENTLY: same pid, RPC back, chain moved.
    expect(engine.store.getNode(aliceId).pid).toBe(pidBefore);
    expect(isPidAlive(pidBefore)).toBe(true);
    await waitFor(async () => (await ping(alicePort)) ? true : null, {
      timeoutMs: 30_000,
      label: 'alice RPC back after the run',
    });
    const headAfter = await waitFor(
      async () => {
        const head = await headNumber(alicePort);
        return head > headBefore ? head : null;
      },
      { timeoutMs: 60_000, label: 'chain resumed after the run' },
    );
    expect(headAfter).toBeGreaterThan(headBefore);

    // no injector bypass, no leak: the fault record is terminal and released
    expect(engine.faults.activeFaults()).toEqual([]);
    const fault = engine.store.getFault(step.faultId!);
    expect(['completed', 'cancelled']).toContain(fault.state);
    expect(fault.reconciled).not.toBe(true); // never needed quarantine
  }, 180_000);

  it('runs two sequential pause steps in declared order with distinct fault records', async () => {
    const pidBefore = engine.store.getNode(aliceId).pid!;
    const { run: accepted } = createRun('live sequential drill', [
      pauseStep('s1', aliceLabel, { durationMs: 5_000, timeoutMs: 70_000 }),
      pauseStep('s2', bobLabel, { durationMs: 5_000, timeoutMs: 70_000 }),
    ]);

    const run = await waitTerminal(accepted.id);
    expect(run.state).toBe('completed');
    expect(run.steps.map((s) => s.state)).toEqual(['completed', 'completed']);
    expect(run.steps.map((s) => s.order)).toEqual([0, 1]);
    expect(run.steps[0]!.faultId).not.toBe(run.steps[1]!.faultId);
    expect(run.steps[1]!.claims?.recoveryVerified).toBe(true);

    // both faults are terminal records that ran in order
    const f1 = engine.store.getFault(run.steps[0]!.faultId!);
    const f2 = engine.store.getFault(run.steps[1]!.faultId!);
    expect(new Date(f2.requestedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(f1.requestedAt).getTime(),
    );
    expect(engine.faults.activeFaults()).toEqual([]);

    // independent recovery: alice same pid and answering again
    expect(engine.store.getNode(aliceId).pid).toBe(pidBefore);
    await waitFor(async () => (await ping(alicePort)) ? true : null, {
      timeoutMs: 30_000,
      label: 'alice RPC back after sequential drill',
    });
  }, 180_000);

  it('aborts the run when a precondition fails: no fault ever touches the live node', async () => {
    const faultsBefore = engine.store.listFaults({ limit: 200 }).length;
    const pidBefore = engine.store.getNode(aliceId).pid!;
    const headBefore = await headNumber(alicePort);

    const { run: accepted } = createRun(
      'live abort drill',
      [
        pauseStep('s1', aliceLabel, {
          durationMs: 5_000,
          timeoutMs: 70_000,
          extraPre: [{ kind: 'peers', node: aliceLabel, op: 'gte', value: 999, timeoutMs: 2_000 }],
        }),
      ],
      { execution: { onPreconditionFailed: 'abort-run' } },
    );

    const run = await waitTerminal(accepted.id);
    expect(run.state).toBe('failed');
    expect(run.error?.code).toBe('PRECONDITION_FAILED');
    expect(run.steps[0]!.state).toBe('failed');
    expect(run.steps[0]!.faultId).toBeNull();

    // no injector involvement at all, node untouched
    expect(engine.store.listFaults({ limit: 200 }).length).toBe(faultsBefore);
    expect(engine.store.getNode(aliceId).pid).toBe(pidBefore);
    expect(isPidAlive(pidBefore)).toBe(true);
    await waitFor(
      async () => ((await headNumber(alicePort)) > headBefore ? true : null),
      { timeoutMs: 60_000, label: 'alice producing blocks (untouched)' },
    );
  }, 120_000);

  it('skip-step continues the drill: the unmet step is skipped and the healthy step still executes', async () => {
    const { run: accepted } = createRun(
      'live skip-step drill',
      [
        pauseStep('s1', aliceLabel, {
          durationMs: 5_000,
          timeoutMs: 70_000,
          extraPre: [{ kind: 'peers', node: aliceLabel, op: 'gte', value: 999, timeoutMs: 2_000 }],
        }),
        pauseStep('s2', bobLabel, { durationMs: 5_000, timeoutMs: 70_000 }),
      ],
      { execution: { onPreconditionFailed: 'skip-step' } },
    );

    const run = await waitTerminal(accepted.id);
    expect(run.state).toBe('completed-with-warnings');
    expect(run.steps[0]!.state).toBe('skipped');
    expect(run.steps[0]!.policyApplied).toBe('onPreconditionFailed=skip-step');
    expect(run.steps[0]!.faultId).toBeNull();
    // the second step executed FOR REAL through the injector
    expect(run.steps[1]!.state).toBe('completed');
    expect(run.steps[1]!.faultId).toBeTruthy();
    expect(engine.store.getFault(run.steps[1]!.faultId!).state).toMatch(/completed|cancelled/);
    expect(engine.faults.activeFaults()).toEqual([]);

    await waitFor(async () => (await ping(alicePort)) ? true : null, {
      timeoutMs: 30_000,
      label: 'alice RPC back after skip-step drill',
    });
  }, 180_000);

  it('cancels during the hold: interrupted via injector.cancel, rollback independently verified', async () => {
    const pidBefore = engine.store.getNode(aliceId).pid!;
    const headBefore = await headNumber(alicePort);

    const { run: accepted } = createRun('live cancel drill', [
      pauseStep('s1', aliceLabel, { durationMs: 60_000, timeoutMs: 120_000 }),
    ]);

    // the run record's faultId is persisted after the fault finishes — the
    // injector's active list is where an IN-FLIT pause is observed live
    const active = await waitFor(
      async () => engine.faults.activeFaults().find((f) => f.nodeId === aliceId) ?? null,
      { timeoutMs: 30_000, label: 'pause fault active on alice' },
    );
    expect(active.type).toBe('pause');
    // independent observation of the held effect
    expect(await ping(alicePort, 1_500)).toBe(false);

    const requested = await engine.scenarioRuns.cancel(accepted.id, 'it');
    expect(['cancel-requested', 'cancelled']).toContain(requested.state);
    expect(requested.cancellation?.requestedBy).toBe('it');

    const run = await waitTerminal(accepted.id, 90_000);
    expect(run.state).toBe('cancelled');
    expect(run.steps[0]!.state).toBe('cancelled');
    expect(run.steps[0]!.claims?.recoveryVerified).toBe(true);
    expect(run.cleanup).toMatchObject({ verified: true, quarantined: false });
    expect(engine.faults.activeFaults()).toEqual([]);

    // independent rollback proof: same pid (a cancelled pause never restarts
    // or leaks the process), RPC back, chain advancing
    expect(engine.store.getNode(aliceId).pid).toBe(pidBefore);
    expect(isPidAlive(pidBefore)).toBe(true);
    await waitFor(async () => (await ping(alicePort)) ? true : null, {
      timeoutMs: 30_000,
      label: 'alice RPC back after cancellation',
    });
    await waitFor(
      async () => ((await headNumber(alicePort)) > headBefore ? true : null),
      { timeoutMs: 60_000, label: 'chain resumed after cancellation' },
    );
  }, 180_000);

  it('reports step-deadline exhaustion as STEP_TIMEOUT with no fault ever created', async () => {
    const faultsBefore = engine.store.listFaults({ limit: 200 }).length;
    const { run: accepted } = createRun('live timeout drill', [
      {
        id: 's1',
        operation: { type: 'pause', config: { node: aliceLabel } },
        timeoutMs: 5_000, // the minimum step budget
        preconditions: [
          { kind: 'rpc-reachable', node: aliceLabel, expect: true },
          { kind: 'process-state', node: aliceLabel, expect: ['running'] },
          // a live, advancing chain can never satisfy 'stalled' inside the
          // 15s observation window — and the authored condition budget (8s)
          // deliberately exceeds the step budget: the executor must report
          // STEP_TIMEOUT (honest budget accounting), not fabricate a verdict
          { kind: 'chain-progress', node: aliceLabel, expect: 'stalled', timeoutMs: 8_000 },
        ],
        postconditions: [{ kind: 'recovery-verified', node: aliceLabel }],
      },
    ]);

    const run = await waitTerminal(accepted.id, 60_000);
    expect(run.state).toBe('failed');
    expect(run.error?.code).toBe('STEP_TIMEOUT');
    expect(run.steps[0]!.state).toBe('failed');
    expect(run.steps[0]!.faultId).toBeNull(); // the deadline hit during preconditions
    expect(engine.store.listFaults({ limit: 200 }).length).toBe(faultsBefore);

    // the live node was never touched
    expect(isPidAlive(engine.store.getNode(aliceId).pid!)).toBe(true);
    expect(await ping(alicePort)).toBe(true);
  }, 120_000);

  it('refuses phantom targets fail-closed: non-designated and non-local chains (persisted rejections, zero faults)', () => {
    const faultsBefore = engine.store.listFaults({ limit: 200 }).length;
    const phantom = (id: string, name: string, designatedTest: boolean, chain: string): void => {
      engine.store.insertNetwork({
        id,
        name,
        preset: 'single-node' as const,
        status: 'running' as const,
        designatedTest,
        // simulated foreign scope — real Kaizen networks are dev/local-spec;
        // the gate must refuse anything else regardless of how it appears
        chain: chain as 'dev',
        baseDir: `${dir}/${id}`,
        createdAt: new Date().toISOString(),
      });
      const config: NodeConfig = {
        id: `${id}-alice`,
        networkId: id,
        name: `${name}-alice`,
        role: 'validator',
        chain: chain as 'dev',
        wellKnownKey: 'alice',
        bootnodes: [],
        baseDir: `${dir}/${id}/alice`,
        nodeKeyFile: `${dir}/${id}.key`,
        logFile: `${dir}/${id}.log`,
        ports: { p2p: 59881, rpc: 59880, ws: 59882, prometheus: 59883 },
        expectedPeers: 0,
      };
      engine.store.insertNode({
        config,
        status: 'running' as const,
        createdAt: new Date().toISOString(),
      });
    };
    phantom('phantom1', 'phantom-nodes', false, 'local-spec');
    phantom('phantom2', 'phantom-mainnet', true, 'mainnet');

    for (const [name, netName, fragment] of [
      ['live phantom gate non-designated', 'phantom-nodes', 'designated test network'],
      ['live phantom gate mainnet chain', 'phantom-mainnet', 'chain scope'],
    ] as const) {
      const scenario = engine.scenarios.create(
        {
          name,
          description: 'gate drill against a phantom target',
          requires: { designatedTest: true, preset: 'single-node' },
          steps: [pauseStep('s1', 'alice', { durationMs: 5_000, timeoutMs: 70_000 })],
        } as unknown as ScenarioInput,
        'it',
      );
      let refusal: string | undefined;
      try {
        engine.scenarioRuns.execute({
          scenarioId: scenario.id,
          networkIdOrName: netName,
          mode: 'execute',
          requestedBy: 'it',
        });
      } catch (e) {
        expect((e as { code: string }).code).toBe('SCENARIO_EXEC_NOT_ALLOWED');
        refusal = (e as Error).message;
      }
      expect(refusal).toBeDefined();
      expect(refusal).toContain(fragment);
    }

    // both refusals are persisted as rejected runs — audit, not execution
    const runs = engine.scenarioRuns.list({ state: 'rejected', limit: 20 });
    const phantomRuns = runs.runs.filter((r) => r.scenarioName.startsWith('live phantom gate'));
    expect(phantomRuns).toHaveLength(2);
    expect(phantomRuns.every((r) => r.error?.code === 'GATE_REFUSED')).toBe(true);
    expect(engine.store.listFaults({ limit: 200 }).length).toBe(faultsBefore);
    expect(engine.faults.activeFaults()).toEqual([]);
  }, 60_000);

  it('refuses unresolvable topology labels at run time with a persisted rejection', async () => {
    const faultsBefore = engine.store.listFaults({ limit: 200 }).length;
    const scenario = engine.scenarios.create(
      {
        name: 'live ghost label drill',
        description: 'targets a node label that does not exist',
        // no preset declared: authoring cannot verify labels, so this saves
        // as a warning — run-time resolution must refuse fail-closed
        requires: { designatedTest: true },
        steps: [pauseStep('s1', 'ghost', { durationMs: 5_000, timeoutMs: 70_000 })],
      } as unknown as ScenarioInput,
      'it',
    );
    expect(() =>
      engine.scenarioRuns.execute({
        scenarioId: scenario.id,
        networkIdOrName: networkId,
        mode: 'execute',
        requestedBy: 'it',
      }),
    ).toThrowError(/do not resolve/);

    const rejected = engine.scenarioRuns.list({ scenarioId: scenario.id, limit: 10 });
    expect(rejected.total).toBe(1);
    expect(rejected.runs[0]?.state).toBe('rejected');
    expect(rejected.runs[0]?.error?.code).toBe('GATE_REFUSED');
    expect(engine.store.listFaults({ limit: 200 }).length).toBe(faultsBefore);
    // live nodes untouched
    expect(isPidAlive(engine.store.getNode(aliceId).pid!)).toBe(true);
    expect(await ping(alicePort)).toBe(true);
  }, 60_000);

  it('replays a finished run as a NEW run: fresh effect and fault, source immutable, provenance queryable', async () => {
    const pidBefore = engine.store.getNode(aliceId).pid!;

    // Source: a real pause run against alice (short hold).
    const { run: accepted } = createRun('live replay source', [
      pauseStep('s1', aliceLabel, { durationMs: 4_000, timeoutMs: 70_000 }),
    ]);
    const source = await waitTerminal(accepted.id);
    expect(source.state).toBe('completed');
    expect(source.replayOfRunId).toBeNull();
    const sourceJson = JSON.stringify(source);
    const sourceFaultId = source.steps[0]!.faultId!;

    // Replay re-enters the engine path with an EXPLICITLY confirmed target
    // and the mode marker — never inherited from the source run.
    const replayed = engine.scenarioRuns.replay({
      runId: source.id,
      networkIdOrName: networkId,
      mode: 'execute',
      requestedBy: 'it',
    });
    expect(replayed.id).not.toBe(source.id);
    expect(replayed.replayOfRunId).toBe(source.id);
    expect(replayed.warnings).toEqual([]);
    expect(scenarioRunReplayNote(replayed)).toContain('identical outcomes are NOT guaranteed');
    expect(replayed.snapshot).toEqual(source.snapshot); // same recorded actions

    // Independent observation of the REPLAY's OWN effect (sampled by the
    // test, not read from the run record): the victim stops answering RPC
    // while the replay's fault is held.
    const samples: boolean[] = [];
    const watcher = (async () => {
      for (;;) {
        samples.push(await ping(alicePort));
        const fresh = engine.scenarioRuns.get(replayed.id);
        if (TERMINAL.includes(fresh.state)) return;
        await sleep(500);
      }
    })();
    const run = await waitTerminal(replayed.id);
    await watcher;

    expect(run.state).toBe('completed');
    const step = run.steps[0]!;
    expect(step.state).toBe('completed');
    expect(step.claims).toMatchObject({
      applied: true,
      effectObserved: true,
      faultRemoved: true,
      recovered: true,
      recoveryVerified: true,
    });
    expect(run.cleanup).toMatchObject({ verified: true, quarantined: false });
    // The replay genuinely re-executed: its own fresh effect and a fresh
    // fault record — the source's evidence was never reused.
    expect(samples.some((r) => !r)).toBe(true);
    expect(step.faultId).toBeTruthy();
    expect(step.faultId).not.toBe(sourceFaultId);
    expect(JSON.stringify(run.steps)).not.toContain(sourceFaultId);
    expect(['completed', 'cancelled']).toContain(engine.store.getFault(step.faultId!).state);

    // Recovery is independently re-verified: same pid, RPC back.
    expect(engine.store.getNode(aliceId).pid).toBe(pidBefore);
    expect(isPidAlive(pidBefore)).toBe(true);
    await waitFor(async () => ((await ping(alicePort)) ? true : null), {
      timeoutMs: 30_000,
      label: 'alice RPC back after the replay',
    });

    // The source run remains byte-identical immutable history.
    expect(JSON.stringify(engine.scenarioRuns.get(source.id))).toBe(sourceJson);

    // Provenance is queryable; nothing leaked from either run.
    const replays = engine.scenarioRuns.list({ replayOf: source.id, limit: 10 });
    expect(replays.total).toBe(1);
    expect(replays.runs[0]?.id).toBe(run.id);
    expect(engine.faults.activeFaults()).toEqual([]);

    // Ineligible sources are refused BEFORE any side effect: unknown run,
    // and the rejected ghost-label run persisted by the test above.
    expect(() =>
      engine.scenarioRuns.replay({
        runId: 'run_ghost',
        networkIdOrName: networkId,
        mode: 'execute',
      }),
    ).toThrowError(/not found/i);
    const rejected = engine.scenarioRuns.list({ state: 'rejected', limit: 20 }).runs[0];
    expect(rejected).toBeTruthy(); // persisted by the gate tests above
    expect(() =>
      engine.scenarioRuns.replay({
        runId: rejected!.id,
        networkIdOrName: networkId,
        mode: 'execute',
      }),
    ).toThrowError(/never executed/);
    // …and an explicitly requested unknown target still fails closed.
    expect(() =>
      engine.scenarioRuns.replay({
        runId: source.id,
        networkIdOrName: 'ghost-net',
        mode: 'execute',
      }),
    ).toThrowError(/not registered/);
    expect(engine.faults.activeFaults()).toEqual([]);
    expect(isPidAlive(engine.store.getNode(aliceId).pid!)).toBe(true);
  }, 240_000);
});
