/**
 * ScenarioEngine (T-3.4, Phase 3D) — guarded, auditable execution of
 * validated scenario definitions through the existing FailureInjector.
 *
 * Execution discipline (one step at a time, declared order only):
 *  1. A run is created ONLY by an explicit execute() request carrying a
 *     literal mode:'execute' marker and an explicitly selected target
 *     network. A saved scenario is NEVER authorization to run it; loading,
 *     listing, or validating scenarios never executes anything.
 *  2. Before any side effect the engine revalidates EVERYTHING with fresh
 *     reads: the stored definition through the authoring validation
 *     pipeline (RSK-28), operation support in the registry (blocked/planned
 *     mechanisms are refused), the exact target network (designatedTest +
 *     local chain, DEC-008), topology labels → registered managed nodes,
 *     declared capabilities (fail closed when unverifiable), quarantine
 *     state, and conflicting executions. Every gate failure is persisted as
 *     a rejected run before it is thrown.
 *  3. Per step: the running state is persisted BEFORE the side effect;
 *     preconditions are evaluated (bounded, fail-closed); the target is
 *     revalidated through injector.preflight(); the fault runs through
 *     injector.execute() — the same typed gates as any direct fault; then
 *     postconditions are evaluated against INDEPENDENT observations; the
 *     declared failure policy is applied; the final step state is persisted
 *     before advancing.
 *  4. Cleanup is attempted on EVERY finish path (normal completion, step
 *     failure, verification failure, timeout, cancellation): active faults
 *     on the run's targets are cancelled through the injector's supported
 *     mechanism and verified. Unconfirmed cleanup ⇒ run cleanup-failed +
 *     high-severity event + quarantine — never a claim of recovery.
 *  5. Cancellation is explicit, persisted, and stops future steps; a fault
 *     in flight is interrupted only via injector.cancel() (bounded, cleanup
 *     still runs). Timeouts bound every wait; the whole run is bounded by
 *     the fresh validation's worst-case duration.
 *  6. Crash recovery: unfinished runs found at startup are terminalized
 *     (NEVER resumed); stuck fault records are quarantined and reconciled
 *     through the injector's existing evidence-based mechanism.
 *
 * There is no generic execution surface here: steps map 1:1 onto registered
 * operations, and every fault goes through the injector's own gates. Run
 * records/snapshots never contain secrets (redactDeep on every write).
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  KaizenError,
  type KaizenErrorCode,
  type KaizenErrorJson,
} from '../errors';
import type { EventBus } from '../events/bus';
import type { FailureInjector } from '../fault/injector';
import { isTerminalFaultState } from '../fault/lifecycle';
import { createRpcObserver, type FaultObserver } from '../fault/observer';
import { redactDeep } from '../fault/redact';
import type { FaultRequest, FaultType } from '../fault/types';
import type { MonitoringService } from '../monitor/service';
import type { StateStore } from '../state/store';
import type { NetworkRecord } from '../types';
import {
  createConditionEvaluator,
  resolveNodeLabel,
  SCENARIO_CONDITION_POLL_MS,
  type ConditionAttempt,
} from './conditions';
import type { ScenarioService } from './service';
import {
  REPLAYABLE_SCENARIO_RUN_STATES,
  canTransitionRun,
  canTransitionStep,
  isReplayableScenarioRunState,
  isTerminalScenarioRunState,
  isTerminalScenarioStepState,
  toRunSummary,
  type InterruptedFaultOutcome,
  type InterruptedRunOutcome,
  type ScenarioConditionEval,
  type ScenarioRunCleanup,
  type ScenarioRunCleanupAction,
  type ScenarioRunError,
  type ScenarioRunListResult,
  type ScenarioRunRecord,
  type ScenarioRunReconcileReport,
  type ScenarioRunState,
  type ScenarioRunSummary,
  type ScenarioStepRun,
  type ScenarioStepState,
} from './run-types';
import {
  SCENARIO_CONDITION_DEFAULT_TIMEOUT_MS,
  type ScenarioCondition,
  type ScenarioRecord,
  type ScenarioStep,
} from './types';
import { scenarioRecordToInput, validateScenarioInput } from './validate';

// ---------------------------------------------------------------------------
// Request schema (the ONLY way a run can be created)

export const scenarioRunRequestSchema = z
  .object({
    scenarioId: z.string().min(1).max(64),
    networkIdOrName: z.string().min(1).max(64),
    /** Literal marker: a saved scenario is not authorization to execute. */
    mode: z.literal('execute'),
    requestedBy: z.string().min(1).max(64).optional(),
  })
  .strict();
export type ScenarioRunRequest = z.infer<typeof scenarioRunRequestSchema>;

/**
 * Replay request (T-3.5): re-execute a finished run's RECORDED actions as a
 * NEW run. Same authorization posture as execute (literal mode marker +
 * EXPLICITLY confirmed target): the historical run is provenance, never
 * authorization, and the target is never inherited from the source run.
 */
export const scenarioReplayRequestSchema = z
  .object({
    runId: z.string().min(1).max(64),
    networkIdOrName: z.string().min(1).max(64),
    /** Literal marker — same posture as execute. */
    mode: z.literal('execute'),
    requestedBy: z.string().min(1).max(64).optional(),
  })
  .strict();
export type ScenarioReplayRequest = z.infer<typeof scenarioReplayRequestSchema>;

export interface ScenarioEngineOptions {
  store: StateStore;
  events: EventBus;
  /** Authoring service (registry + stored definitions). */
  scenarios: ScenarioService;
  /** The injector every fault step executes through. */
  faults: FailureInjector;
  monitoring: MonitoringService;
  /** Independent observation channel for conditions (defaults to RPC). */
  observer?: FaultObserver;
  /** Bounded wait for cancel-triggered rollback verification (default 120s). */
  cleanupWaitMs?: number;
}

export interface ScenarioRunListFilter {
  scenarioId?: string;
  networkId?: string;
  state?: ScenarioRunState;
  /** Only runs replayed FROM this source run (T-3.5 provenance). */
  replayOf?: string;
  limit?: number;
  offset?: number;
}

export interface ScenarioRunPage {
  runs: ScenarioRunSummary[];
  malformed: ScenarioRunListResult['malformed'];
  total: number;
  limit: number;
  offset: number;
}

/** Diagnostic view of the runs executing in THIS process. */
export interface ActiveScenarioRun {
  runId: string;
  scenarioId: string;
  networkId: string;
  state: ScenarioRunState;
  cancelRequested: boolean;
}

interface ActiveRunEntry {
  runId: string;
  networkId: string;
  scenarioId: string;
  cancelRequested: boolean;
  cancelInfo: { requestedBy: string; requestedAt: string; reason?: string } | null;
  /** Node whose injector fault is in flight (interrupt target for cancel). */
  faultNodeId: string | null;
  /** Absolute deadline for the whole run (fresh worst-case duration). */
  runDeadline: number;
  opId: number;
  promise: Promise<void>;
}

type StepOutcome =
  | { kind: 'continue' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: ScenarioRunError };

const DEFAULT_CLEANUP_WAIT_MS = 120_000;

/** Local bounded-wait helper (same convention as the injector). */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new KaizenError('OPERATION_TIMEOUT', `${label} exceeded ${ms}ms`, { label, ms })),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

class StepTimeoutSignal extends Error {
  constructor() {
    super('step budget exhausted');
    this.name = 'StepTimeoutSignal';
  }
}

export class ScenarioEngine {
  private readonly store: StateStore;
  private readonly events: EventBus;
  private readonly scenarios: ScenarioService;
  private readonly faults: FailureInjector;
  private readonly monitoring: MonitoringService;
  private readonly observer: FaultObserver;
  private readonly cleanupWaitMs: number;

  private readonly active = new Map<string, ActiveRunEntry>();
  private readonly activeNetworks = new Map<string, string>();
  private readonly activeScenarios = new Map<string, string>();
  private startupReconcilePromise: Promise<ScenarioRunReconcileReport> | null = null;
  private closed = false;

  constructor(options: ScenarioEngineOptions) {
    this.store = options.store;
    this.events = options.events;
    this.scenarios = options.scenarios;
    this.faults = options.faults;
    this.monitoring = options.monitoring;
    this.observer = options.observer ?? createRpcObserver({ rpcTimeoutMs: 1_500 });
    this.cleanupWaitMs = options.cleanupWaitMs ?? DEFAULT_CLEANUP_WAIT_MS;
  }

  // -------------------------------------------------------------------------
  // Queries

  get(runId: string): ScenarioRunRecord {
    return redactDeep(this.store.getScenarioRun(runId));
  }

  list(filter: ScenarioRunListFilter = {}): ScenarioRunPage {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const listFilter = {
      ...(filter.scenarioId !== undefined ? { scenarioId: filter.scenarioId } : {}),
      ...(filter.networkId !== undefined ? { networkId: filter.networkId } : {}),
      ...(filter.state !== undefined ? { state: filter.state } : {}),
      ...(filter.replayOf !== undefined ? { replayOf: filter.replayOf } : {}),
      limit,
      offset,
    };
    const { runs, malformed } = this.store.listScenarioRuns(listFilter);
    const total = this.store.countScenarioRuns({
      ...(filter.scenarioId !== undefined ? { scenarioId: filter.scenarioId } : {}),
      ...(filter.networkId !== undefined ? { networkId: filter.networkId } : {}),
      ...(filter.state !== undefined ? { state: filter.state } : {}),
      ...(filter.replayOf !== undefined ? { replayOf: filter.replayOf } : {}),
    });
    return { runs: runs.map(toRunSummary), malformed, total, limit, offset };
  }

  activeRuns(): ActiveScenarioRun[] {
    return [...this.active.values()].map((e) => ({
      runId: e.runId,
      scenarioId: e.scenarioId,
      networkId: e.networkId,
      state: this.store.tryGetScenarioRun(e.runId)?.state ?? 'running',
      cancelRequested: e.cancelRequested,
    }));
  }

  // -------------------------------------------------------------------------
  // Execution (explicit, gated, synchronous through the gates)

  /**
   * Execute a saved scenario against an explicitly selected target. The
   * synchronous part validates + persists the run record and re-runs EVERY
   * gate with fresh reads; when the gates pass, the step loop continues in
   * the background and this method returns the persisted run record. Use
   * wait(runId) to await completion (tests/CLI); the API surface is polling
   * + cancellation, never a held connection.
   *
   * Gate failures are persisted as a `rejected` run FIRST, then thrown.
   */
  execute(input: unknown): ScenarioRunRecord {
    if (this.closed) {
      throw new KaizenError('SCENARIO_EXEC_NOT_ALLOWED', 'ScenarioEngine is shut down');
    }
    const parsed = scenarioRunRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new KaizenError('INVALID_INPUT', 'Invalid scenario execution request', {
        issues: parsed.error.issues,
        hint: 'execution requires an explicit mode:"execute" marker and an explicitly selected target network',
      });
    }
    const req = parsed.data;
    // Throws SCENARIO_NOT_FOUND before any run record exists.
    const scenario = this.store.getScenario(req.scenarioId);
    return this.startRun(scenario, req, null);
  }

  /**
   * Replay a finished run's RECORDED actions as a NEW run (T-3.5). The new
   * run executes the source run's immutable snapshot (never the scenario's
   * possibly-edited current definition), re-enters the SAME execution path
   * (gates → injector → evidence), and records provenance (`replayOfRunId`).
   * Replay repeats ACTIONS; it never claims identical outcomes, and no
   * source evidence is copied — every verdict below is freshly observed.
   */
  replay(input: unknown): ScenarioRunRecord {
    if (this.closed) {
      throw new KaizenError('SCENARIO_EXEC_NOT_ALLOWED', 'ScenarioEngine is shut down');
    }
    const parsed = scenarioReplayRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new KaizenError('INVALID_INPUT', 'Invalid scenario replay request', {
        issues: parsed.error.issues,
        hint: 'replay requires the explicit mode:"execute" marker and an EXPLICITLY confirmed target network — a historical run is provenance, never authorization',
      });
    }
    const req = parsed.data;
    const source = this.store.getScenarioRun(req.runId);
    if (!isReplayableScenarioRunState(source.state)) {
      throw new KaizenError(
        'SCENARIO_RUN_NOT_REPLAYABLE',
        source.state === 'rejected'
          ? `Run ${source.id} was rejected — it never executed any action; execute the scenario directly instead of replaying a refusal`
          : `Run ${source.id} is unfinished (${source.state}) — unfinished runs are never resumed or replayed; startup reconciliation must first move it to a terminal state`,
        {
          runId: source.id,
          state: source.state,
          replayableStates: [...REPLAYABLE_SCENARIO_RUN_STATES],
        },
      );
    }
    const snapshot = source.snapshot;
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      !Array.isArray(snapshot.steps) ||
      snapshot.steps.length === 0
    ) {
      throw new KaizenError(
        'SCENARIO_RUN_NOT_REPLAYABLE',
        `Run ${source.id} has no usable scenario snapshot — its recorded actions cannot be replayed; execute the scenario directly instead`,
        { runId: source.id },
      );
    }
    return this.startRun(snapshot, {
      scenarioId: source.scenarioId,
      networkIdOrName: req.networkIdOrName,
      mode: 'execute',
      requestedBy: req.requestedBy ?? 'engine',
    }, source.id);
  }

  /** Shared run-start path (execute + replay) — one executor, one gate chain. */
  private startRun(
    scenario: ScenarioRecord,
    req: ScenarioRunRequest,
    replayOfRunId: string | null,
  ): ScenarioRunRecord {
    const record = this.newRunRecord(scenario, req, replayOfRunId);
    this.store.insertScenarioRun(record);
    this.events.emit('scenario-run.created', {
      runId: record.id,
      scenarioId: record.scenarioId,
      scenarioName: record.scenarioName,
      networkId: record.networkId,
      requestedBy: record.requestedBy,
      ...(replayOfRunId !== null ? { replayOfRunId } : {}),
      steps: scenario.steps.length,
      at: record.createdAt,
    });
    const opId = this.store.startOperation('scenario.run', undefined, undefined);

    // ---- gates (fresh reads; synchronous — no interleaving possible) ----
    this.setRunState(record, 'validating');
    this.persistRun(record);
    try {
      const gate = this.evaluateGates(record, scenario, req);
      this.store.attachOperationToNetwork(opId, record.networkId);
      record.validation = gate.validation;
      record.targetNodes = gate.targetNodes;
      record.networkId = gate.network.id;
      record.networkName = gate.network.name;
      record.steps = scenario.steps.map((step) => this.newStepRun(step, gate));
      const firstStep = record.steps[0];
      record.currentStepId = firstStep?.stepId ?? null;
      record.currentStepOrder = firstStep?.order ?? null;
      record.startedAt = nowIso();
      this.setRunState(record, 'running');
      this.persistRun(record);
    } catch (e) {
      // Gate refusals persist their precise error BEFORE throwing — never
      // overwrite it with a generic mapping of the thrown error.
      const runError = record.error ?? toRunError(e);
      record.error = runError;
      this.store.finishOperation(opId, {
        status: 'error',
        errorCode: runError.code,
        errorMessage: runError.message,
        detail: { runId: record.id, scenarioId: record.scenarioId },
      });
      this.setRunState(record, 'rejected');
      this.persistRun(record);
      this.emitFinished(record);
      throw e;
    }

    // ---- register + start (still synchronous: the loop runs until its
    // first await, so duplicate/concurrent requests are refused by the
    // guard above before anything can interleave) ----
    const entry: ActiveRunEntry = {
      runId: record.id,
      networkId: record.networkId,
      scenarioId: record.scenarioId,
      cancelRequested: false,
      cancelInfo: null,
      faultNodeId: null,
      runDeadline: Date.now() + (record.validation?.worstCaseDurationMs ?? 60_000),
      opId,
      promise: Promise.resolve(),
    };
    this.active.set(entry.runId, entry);
    this.activeNetworks.set(entry.networkId, entry.runId);
    this.activeScenarios.set(entry.scenarioId, entry.runId);
    entry.promise = this.driveRun(entry);
    return redactDeep(this.store.getScenarioRun(record.id));
  }

  /** Await a run's completion (bounded). Never rejects. */
  async wait(runId: string, timeoutMs = 300_000): Promise<ScenarioRunRecord> {
    const entry = this.active.get(runId);
    if (entry) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          entry.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new KaizenError('OPERATION_TIMEOUT', `run ${runId} did not finish in ${timeoutMs}ms`, {
                    runId,
                    ms: timeoutMs,
                  }),
                ),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return this.get(runId);
  }

  /**
   * Request cancellation of an active run: explicit, persisted, and — when
   * a fault is in flight — interrupted through the injector's supported
   * cancellation mechanism (bounded; the injector's cleanup still runs).
   * The run finishes as `cancelled` (cleanup confirmed) or `cleanup-failed`
   * (never claimed as recovered).
   */
  async cancel(runId: string, requestedBy = 'engine'): Promise<ScenarioRunRecord> {
    const stored = this.store.getScenarioRun(runId);
    if (isTerminalScenarioRunState(stored.state)) {
      throw new KaizenError(
        'SCENARIO_RUN_CONFLICT',
        `Run ${runId} already finished (${stored.state}) — nothing to cancel`,
        { runId, state: stored.state },
      );
    }
    const entry = this.active.get(runId);
    if (!entry) {
      throw new KaizenError(
        'SCENARIO_RUN_CONFLICT',
        `Run ${runId} is not active in this process (interrupted by a restart?) — it cannot be cancelled here`,
        { runId, state: stored.state },
      );
    }
    const info = { requestedBy, requestedAt: nowIso() };
    entry.cancelRequested = true;
    entry.cancelInfo = info;

    // Persist the cancellation request immediately (fresh read + patch).
    const fresh = this.store.getScenarioRun(runId);
    fresh.cancellation = info;
    if (canTransitionRun(fresh.state, 'cancel-requested')) {
      fresh.state = 'cancel-requested';
    }
    fresh.updatedAt = info.requestedAt;
    this.store.updateScenarioRun(fresh);
    this.events.emit('scenario-run.cancelled', { runId, requestedBy, at: info.requestedAt });

    // Interrupt a fault in flight through the ONLY supported mechanism.
    if (entry.faultNodeId) {
      const active = this.faults
        .activeFaults()
        .find((f) => f.nodeId === entry.faultNodeId);
      if (active) {
        try {
          await withTimeout(this.faults.cancel(active.faultId), this.cleanupWaitMs, 'run.cancel');
        } catch {
          // The run loop observes the injector's own terminal result and
          // runs the cleanup path; nothing is silently swallowed here —
          // the fault record itself carries the outcome.
        }
      }
    }
    return this.get(runId);
  }

  // -------------------------------------------------------------------------
  // Startup reconciliation (crash recovery — never resumes execution)

  /**
   * Reconcile runs left unfinished by a process restart (idempotent; the
   * promise never rejects). Stuck execute-mode fault records of those runs
   * are quarantined and reconciled through the injector's existing
   * evidence-based mechanism; the runs themselves are terminalized
   * (`failed` or `cleanup-failed`) — execution is NEVER auto-resumed.
   */
  reconcileOnStartup(): Promise<ScenarioRunReconcileReport> {
    this.startupReconcilePromise ??= this.performStartupReconcile();
    return this.startupReconcilePromise;
  }

  private async performStartupReconcile(): Promise<ScenarioRunReconcileReport> {
    const at = nowIso();
    const runs: InterruptedRunOutcome[] = [];
    let quarantined = false;
    try {
      for (const run of this.store.listUnfinishedScenarioRuns()) {
        const outcome = await this.reconcileInterruptedRun(run);
        runs.push(outcome);
        if (outcome.finalState === 'cleanup-failed') quarantined = true;
      }
    } catch (e) {
      // Recorded in the report — startup reconciliation never throws.
      return { at, runs, quarantined, error: e instanceof Error ? e.message : String(e) };
    }
    return { at, runs, quarantined };
  }

  private async reconcileInterruptedRun(run: ScenarioRunRecord): Promise<InterruptedRunOutcome> {
    const targetIds = run.targetNodes.map((t) => t.nodeId);
    const faults: InterruptedFaultOutcome[] = [];
    for (const nodeId of targetIds) {
      const records = this.store.listFaults({ nodeId, limit: 50 });
      for (const record of records) {
        if (record.mode !== 'execute' || isTerminalFaultState(record.state)) continue;
        const before = record.state;
        const recovered = await this.faults.recoverInterrupted(record.id);
        const released = recovered.reconciled === true;
        faults.push({
          faultId: record.id,
          nodeId,
          transitioned: `${before} → ${recovered.state}`,
          released,
          detail: released
            ? 'effect provably gone from fresh evidence — quarantine released'
            : 'target quarantined: the effect could not be proven gone',
        });
      }
    }
    const stillQuarantined = targetIds.some((nodeId) =>
      this.store
        .listFaults({ nodeId, limit: 50 })
        .some((f) => f.state === 'cleanup-failed' && f.reconciled !== true),
    );

    const finalState: ScenarioRunState = stillQuarantined ? 'cleanup-failed' : 'failed';
    if (!canTransitionRun(run.state, finalState)) {
      // Defensive hop for states with no direct edge (queued/validating).
      this.setRunState(run, 'cancel-requested');
    }
    run.cleanup = {
      checkedAt: nowIso(),
      activeFaultsFound: 0,
      actions: [],
      quarantined: stillQuarantined,
      verified: !stillQuarantined,
      detail:
        faults.length > 0
          ? `startup reconciliation of ${faults.length} interrupted fault record(s)`
          : 'startup reconciliation: no stuck fault records on the run targets',
    };
    run.error = {
      code: 'INTERRUPTED',
      message:
        'run was interrupted by a process restart — execution is NEVER resumed automatically; reconcile or re-run explicitly',
      details: { faults },
    };
    run.finishedAt = nowIso();
    this.setRunState(run, finalState);
    this.persistRun(run);
    this.emitFinished(run);
    return {
      runId: run.id,
      scenarioId: run.scenarioId,
      networkId: run.networkId,
      finalState,
      faults,
      detail: run.error.message,
    };
  }

  // -------------------------------------------------------------------------
  // Shutdown

  /**
   * Graceful engine shutdown: active runs are cancelled through the normal
   * cleanup-then-stop path (the injector is still alive at this point), and
   * startup reconciliation is awaited. Never leaves a run un-terminalized in
   * this process.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.active.values()) {
      entry.cancelRequested = true;
      entry.cancelInfo = { requestedBy: 'engine-shutdown', requestedAt: nowIso() };
    }
    // Interrupt faults in flight through the supported mechanism (bounded),
    // so shutdown does not wait out a full hold and cleanup still runs.
    await Promise.all(
      [...this.active.values()].map(async (entry) => {
        if (!entry.faultNodeId) return;
        const active = this.faults
          .activeFaults()
          .find((f) => f.nodeId === entry.faultNodeId);
        if (!active) return;
        try {
          await withTimeout(this.faults.cancel(active.faultId), this.cleanupWaitMs, 'engine.close');
        } catch {
          // The run loop observes the injector's real terminal result and
          // runs the cleanup path; the fault record carries the outcome.
        }
      }),
    );
    await Promise.allSettled([...this.active.values()].map((e) => e.promise));
    if (this.startupReconcilePromise) await this.startupReconcilePromise;
  }

  // -------------------------------------------------------------------------
  // Gates (fresh reads, before any side effect)

  private evaluateGates(
    record: ScenarioRunRecord,
    scenario: ScenarioRecord,
    req: ScenarioRunRequest,
  ): {
    validation: ReturnType<typeof validateScenarioInput>;
    targetNodes: ScenarioRunRecord['targetNodes'];
    network: NetworkRecord;
  } {
    /** The caller persists record.error before this throws (rejected run). */
    const refuse = (
      kaizenCode: KaizenErrorCode,
      message: string,
      details?: Record<string, unknown>,
    ): never => {
      throw new KaizenError(kaizenCode, message, { runId: record.id, ...details });
    };

    // 1. Fresh full validation of the STORED definition (RSK-28 gate).
    const validation = validateScenarioInput(
      scenarioRecordToInput(scenario),
      this.scenarios.operations,
    );
    record.validation = validation;
    if (!validation.valid) {
      record.error = {
        code: 'VALIDATION_FAILED',
        message: `fresh run-time validation found ${validation.errorCount} error(s)`,
        details: { issues: validation.issues },
      };
      refuse(
        'SCENARIO_INVALID',
        `Scenario ${scenario.id} failed fresh run-time validation — execution refused`,
        { issues: validation.issues, errorCount: validation.errorCount },
      );
    }

    // 2. Every referenced operation must be SUPPORTED right now.
    const unsupported = scenario.steps
      .filter((s) => this.scenarios.operations.get(s.operation.type)?.status !== 'supported')
      .map((s) => ({
        stepId: s.id,
        type: s.operation.type,
        status: this.scenarios.operations.get(s.operation.type)?.status ?? 'unknown',
      }));
    if (unsupported.length > 0) {
      record.error = {
        code: 'UNSUPPORTED_OPERATION',
        message: `steps reference operations that are not executable today: ${unsupported
          .map((u) => `${u.stepId} (${u.type}: ${u.status})`)
          .join(', ')}`,
        details: { steps: unsupported },
      };
      refuse('SCENARIO_EXEC_NOT_ALLOWED', record.error.message, { steps: unsupported });
    }

    // 3. Exact target resolution.
    const network = this.store.tryGetNetwork(req.networkIdOrName);
    if (!network) {
      record.error = {
        code: 'TARGET_UNRESOLVED',
        message: `target network "${req.networkIdOrName}" is not registered`,
        details: { networkIdOrName: req.networkIdOrName },
      };
      throw new KaizenError('NETWORK_NOT_FOUND', record.error.message, {
        runId: record.id,
        idOrName: req.networkIdOrName,
      });
    }

    // 4. Safety gates (DEC-008 posture, re-checked with fresh reads).
    const gateFailures: string[] = [];
    if (network.designatedTest !== true) {
      gateFailures.push(
        `network ${network.name} is not a designated test network — scenario execution is refused (DEC-008)`,
      );
    }
    if (network.chain !== 'dev' && network.chain !== 'local-spec') {
      gateFailures.push(
        `chain scope "${network.chain}" is not a local/development chain — refused (DEC-008)`,
      );
    }
    if (scenario.requires.preset !== undefined && scenario.requires.preset !== network.preset) {
      gateFailures.push(
        `scenario requires preset "${scenario.requires.preset}" but the target is preset "${network.preset}"`,
      );
    }
    const nodes = this.store.listNodes(network.id);
    if (scenario.requires.minNodes !== undefined && nodes.length < scenario.requires.minNodes) {
      gateFailures.push(
        `target has ${nodes.length} node(s) but the scenario requires at least ${scenario.requires.minNodes}`,
      );
    }
    const BASE_CAPABILITIES = ['managed-process', 'rpc-baseline'];
    for (const capability of scenario.requires.capabilities ?? []) {
      if (!BASE_CAPABILITIES.includes(capability)) {
        gateFailures.push(
          `declared target capability "${capability}" cannot be verified by the current architecture — failing closed`,
        );
      }
    }

    // 5. Label → managed-node resolution (operation + condition targets).
    const labels = new Set<string>();
    for (const step of scenario.steps) {
      const node = (step.operation.config as { node?: unknown }).node;
      if (typeof node === 'string') labels.add(node);
      for (const cond of [...step.preconditions, ...step.postconditions]) labels.add(cond.node);
    }
    const unresolved: string[] = [];
    const targetNodes: ScenarioRunRecord['targetNodes'] = [];
    for (const label of labels) {
      const node = resolveNodeLabel(this.store, network, label);
      if (!node) {
        unresolved.push(label);
        continue;
      }
      targetNodes.push({ label, nodeId: node.id, nodeName: node.name });
    }
    if (unresolved.length > 0) {
      gateFailures.push(
        `node label(s) ${unresolved.map((u) => `"${u}"`).join(', ')} do not resolve to managed nodes of network ${network.name} (${nodes
          .map((n) => n.name)
          .join(', ') || 'no nodes'})`,
      );
    }

    // 6. Quarantine: an unresolved cleanup failure blocks conflicting runs.
    const quarantined = targetNodes.filter((t) =>
      this.store
        .listFaults({ nodeId: t.nodeId, limit: 50 })
        .some((f) => f.state === 'cleanup-failed' && f.reconciled !== true),
    );
    for (const q of quarantined) {
      gateFailures.push(
        `node ${q.nodeName} has an unreconciled cleanup failure (quarantined until reconcile())`,
      );
    }

    if (gateFailures.length > 0) {
      record.error = {
        code: 'GATE_REFUSED',
        message: gateFailures.join('; '),
        details: { gates: gateFailures },
      };
      refuse('SCENARIO_EXEC_NOT_ALLOWED', record.error.message, {
        gates: gateFailures,
      });
    }

    // 7. Conflicting executions (synchronous block — no interleaving).
    const activeRunOnNetwork = this.activeNetworks.get(network.id);
    if (activeRunOnNetwork !== undefined) {
      record.error = {
        code: 'CONFLICT',
        message: `run ${activeRunOnNetwork} is already active against network ${network.name}`,
        details: { activeRunId: activeRunOnNetwork },
      };
      refuse('SCENARIO_RUN_CONFLICT', record.error.message, {
        activeRunId: activeRunOnNetwork,
      });
    }
    const activeRunOnScenario = this.activeScenarios.get(scenario.id);
    if (activeRunOnScenario !== undefined) {
      record.error = {
        code: 'CONFLICT',
        message: `run ${activeRunOnScenario} of this scenario is still active`,
        details: { activeRunId: activeRunOnScenario },
      };
      refuse('SCENARIO_RUN_CONFLICT', record.error.message, {
        activeRunId: activeRunOnScenario,
      });
    }
    const targetNodeIds = new Set(targetNodes.map((t) => t.nodeId));
    const activeFault = this.faults.activeFaults().find((f) => targetNodeIds.has(f.nodeId));
    if (activeFault !== undefined) {
      record.error = {
        code: 'CONFLICT',
        message: `fault ${activeFault.faultId} (${activeFault.type}) is active on target node ${activeFault.nodeId}`,
        details: { activeFaultId: activeFault.faultId, nodeId: activeFault.nodeId },
      };
      refuse('SCENARIO_RUN_CONFLICT', record.error.message, {
        activeFaultId: activeFault.faultId,
      });
    }

    return { validation, targetNodes, network };
  }

  // -------------------------------------------------------------------------
  // Run loop

  private async driveRun(entry: ActiveRunEntry): Promise<void> {
    try {
      const record = this.store.getScenarioRun(entry.runId);
      for (const stepRun of record.steps) {
        if (entry.cancelRequested) {
          await this.enterCancelPath(record, entry);
          return;
        }
        const outcome = await this.runStep(record, entry, stepRun);
        if (outcome.kind === 'continue') continue;
        if (outcome.kind === 'cancelled') {
          await this.enterCancelPath(record, entry);
          return;
        }
        await this.finishRun(record, entry, 'failed', outcome.error);
        return;
      }
      const finalState: ScenarioRunState =
        record.warnings.length > 0 ? 'completed-with-warnings' : 'completed';
      await this.finishRun(record, entry, finalState, null);
    } catch (e) {
      // Last-resort invariant: terminalize honestly, never leave the run
      // dangling in a non-terminal state within this process.
      try {
        const record = this.store.getScenarioRun(entry.runId);
        if (!isTerminalScenarioRunState(record.state)) {
          const error: ScenarioRunError = {
            code: 'INTERNAL',
            message: `executor internal error: ${e instanceof Error ? e.message : String(e)}`,
          };
          record.error = error;
          await this.finishRun(record, entry, 'failed', error);
        }
      } catch {
        this.releaseActive(entry);
      }
    }
  }

  private async runStep(
    record: ScenarioRunRecord,
    entry: ActiveRunEntry,
    stepRun: ScenarioStepRun,
  ): Promise<StepOutcome> {
    const policy = record.snapshot.execution;
    const step = record.snapshot.steps.find((s) => s.id === stepRun.stepId);
    if (!step) {
      return this.applyStepFailedPolicy(record, entry, stepRun, {
        code: 'STEP_FAILED',
        message: `step ${stepRun.stepId} is missing from the run snapshot`,
      });
    }
    const def = this.scenarios.operations.get(step.operation.type);
    const network = this.store.getNetwork(record.networkId);
    const nodeLabel = (step.operation.config as { node: string }).node;
    const targetNode = resolveNodeLabel(this.store, network, nodeLabel);
    if (!targetNode) {
      return this.applyStepFailedPolicy(record, entry, stepRun, {
        code: 'TARGET_UNRESOLVED',
        message: `node label "${nodeLabel}" no longer resolves in network ${network.name}`,
      });
    }
    stepRun.nodeId = targetNode.id;
    stepRun.nodeName = targetNode.name;
    record.currentStepId = stepRun.stepId;
    record.currentStepOrder = stepRun.order;

    // ---- delayBefore (bounded, cancel-aware) ----
    if (step.delayBeforeMs > 0) {
      this.setStepState(record, stepRun, 'waiting');
      this.setRunState(record, 'waiting');
      this.persistRun(record, entry);
      const d = await this.delay(entry, step.delayBeforeMs);
      if (d === 'cancelled') {
        this.setStepState(record, stepRun, 'cancelled');
        stepRun.error = { code: 'CANCELLED', message: 'cancelled during delayBeforeMs' };
        stepRun.finishedAt = nowIso();
        this.persistRun(record, entry);
        return { kind: 'cancelled' };
      }
      if (d === 'timeout') {
        return this.handleStepTimeout(record, entry, stepRun, 'run deadline expired during delayBeforeMs');
      }
    }

    // ---- persist RUNNING before the side effect ----
    stepRun.startedAt = stepRun.startedAt ?? nowIso();
    this.setStepState(record, stepRun, 'running');
    this.setRunState(record, 'running');
    this.persistRun(record, entry);
    const stepDeadline = Date.now() + Math.max(0, Math.min(step.timeoutMs, entry.runDeadline - Date.now()));

    // ---- preconditions (bounded, fail-closed) ----
    if (step.preconditions.length > 0) {
      const evals = await this.evaluateConditions(
        step.preconditions,
        record,
        entry,
        stepDeadline,
      );
      stepRun.preconditions = evals;
      this.persistRun(record, entry);
      const unsatisfied = evals.filter((e) => e.verdict !== 'satisfied');
      if (unsatisfied.length > 0 && entry.cancelRequested) {
        this.setStepState(record, stepRun, 'cancelled');
        stepRun.error = { code: 'CANCELLED', message: 'cancelled while preconditions were being evaluated' };
        stepRun.finishedAt = nowIso();
        this.persistRun(record, entry);
        return { kind: 'cancelled' };
      }
      if (unsatisfied.length > 0 && Date.now() >= stepDeadline) {
        return this.handleStepTimeout(record, entry, stepRun, 'step budget exhausted while waiting for preconditions');
      }
      if (unsatisfied.length > 0) {
        const error: ScenarioRunError = {
          code: 'PRECONDITION_FAILED',
          message: `precondition(s) did not hold: ${unsatisfied
            .map((u) => `${u.kind}@${u.node} [${u.verdict}] ${u.detail}`)
            .join('; ')}`,
          details: { evaluations: unsatisfied },
        };
        const policyName = policy.onPreconditionFailed;
        stepRun.policyApplied = `onPreconditionFailed=${policyName}`;
        if (policyName === 'skip-step') {
          stepRun.warnings.push(`skipped: ${error.message}`);
          record.warnings.push(`step ${stepRun.stepId} skipped (precondition not met)`);
          this.setStepState(record, stepRun, 'skipped');
          stepRun.finishedAt = nowIso();
          this.emitVerification(record, stepRun, 'precondition', 'failed', error.message);
          this.persistRun(record, entry);
          return { kind: 'continue' };
        }
        this.emitVerification(record, stepRun, 'precondition', 'failed', error.message);
        stepRun.error = error;
        this.setStepState(record, stepRun, 'failed');
        stepRun.finishedAt = nowIso();
        this.persistRun(record, entry);
        if (policyName === 'abort-run') return { kind: 'failed', error };
        record.cancellation = {
          requestedBy: 'policy: onPreconditionFailed=cancel-run',
          requestedAt: nowIso(),
          reason: error.message,
        };
        entry.cancelInfo = record.cancellation;
        return { kind: 'cancelled' };
      }
      this.emitVerification(record, stepRun, 'precondition', 'satisfied', 'all preconditions held');
    }

    if (entry.cancelRequested) {
      this.setStepState(record, stepRun, 'cancelled');
      stepRun.error = { code: 'CANCELLED', message: 'cancelled before the operation' };
      stepRun.finishedAt = nowIso();
      this.persistRun(record, entry);
      return { kind: 'cancelled' };
    }
    if (Date.now() >= stepDeadline) {
      return this.handleStepTimeout(record, entry, stepRun, 'step budget exhausted before the operation');
    }

    // ---- the operation: fault steps execute ONLY through the injector ----
    if (!def || def.kind !== 'fault') {
      return this.applyStepFailedPolicy(record, entry, stepRun, {
        code: 'UNSUPPORTED_OPERATION',
        message: `operation "${step.operation.type}" is not executable (no injector mechanism)`,
      });
    }
    const faultRequest: FaultRequest = {
      networkIdOrName: record.networkId,
      nodeId: targetNode.id,
      type: step.operation.type as FaultType,
      requestedBy: record.requestedBy,
      ...(pauseDurationOf(step) !== undefined
        ? { options: { durationMs: pauseDurationOf(step) } }
        : {}),
    };

    // Revalidate target + permissions immediately before the fault.
    const preflight = await this.faults.preflight(faultRequest);
    if (!preflight.ok) {
      return this.applyStepFailedPolicy(record, entry, stepRun, {
        code: 'GATE_REFUSED',
        message: `injector preflight refused the target: ${preflight.blockingReasons.join('; ')}`,
        details: { blockingReasons: preflight.blockingReasons, checks: preflight.checks },
      });
    }
    if (entry.cancelRequested) {
      // Cancellation arrived during revalidation — no fault is ever created.
      this.setStepState(record, stepRun, 'cancelled');
      stepRun.error = { code: 'CANCELLED', message: 'cancelled after revalidation, before the operation' };
      stepRun.finishedAt = nowIso();
      this.persistRun(record, entry);
      return { kind: 'cancelled' };
    }

    entry.faultNodeId = targetNode.id;
    const executePromise = this.faults.execute(faultRequest);
    let result;
    try {
      let timer: NodeJS.Timeout | undefined;
      try {
        result = await Promise.race([
          executePromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new StepTimeoutSignal()), Math.max(1, stepDeadline - Date.now()));
          }),
        ]);
      } catch (e) {
        if (e instanceof StepTimeoutSignal) {
          // The injector call keeps running in the background; cancellation
          // below awaits its real terminal result — nothing is assumed.
          executePromise.catch(() => undefined);
          return await this.handleStepTimeout(record, entry, stepRun, 'step budget exhausted during the operation');
        }
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (e) {
      return this.applyStepFailedPolicy(record, entry, stepRun, {
        code: 'STEP_FAILED',
        message: `injector refused/failed the operation: ${e instanceof Error ? e.message : String(e)}`,
        details: { code: isKaizen(e) ? e.code : 'INTERNAL' },
      });
    } finally {
      entry.faultNodeId = null;
    }

    stepRun.faultId = result.faultId;
    stepRun.outcome = result.outcome;
    stepRun.claims = result.claims;
    stepRun.durationMs = result.durationMs;
    this.persistRun(record, entry);

    if (result.state === 'cleanup-failed') {
      return this.handleQuarantinedStep(
        record,
        entry,
        stepRun,
        result.error ?? {
          code: 'INTERNAL',
          message: 'fault ended cleanup-failed without an error payload',
        },
      );
    }
    if (result.state === 'cancelled') {
      // Cancelled through the injector: recovery was verified (the injector
      // only reports `cancelled` after a verified recovery).
      this.setStepState(record, stepRun, 'cancelled');
      stepRun.error = {
        code: 'CANCELLED',
        message: 'operation cancelled through the injector; recovery verified',
        details: { faultId: result.faultId, claims: result.claims },
      };
      stepRun.finishedAt = nowIso();
      this.persistRun(record, entry);
      return { kind: 'cancelled' };
    }
    if (result.state !== 'completed') {
      return this.applyStepFailedPolicy(record, entry, stepRun, {
        code: 'STEP_FAILED',
        message: `fault ended ${result.state} (${result.outcome}): ${(result.error?.message ?? result.evidence.notes.join('; ')) || 'no further detail'}`,
        details: { faultId: result.faultId, outcome: result.outcome, claims: result.claims },
      });
    }

    // ---- postconditions (independent observations, bounded) ----
    this.setStepState(record, stepRun, 'verifying');
    this.setRunState(record, 'verifying');
    this.persistRun(record, entry);
    if (step.postconditions.length === 0) {
      stepRun.verification = 'not-required';
      const warning = 'no postconditions authored — outcome verified only by the injector\'s independently observed recovery claims';
      stepRun.warnings.push(warning);
      record.warnings.push(`step ${stepRun.stepId}: ${warning}`);
      this.emitVerification(record, stepRun, 'postcondition', 'not-required', warning);
      this.setStepState(record, stepRun, 'completed-with-warnings');
      stepRun.finishedAt = nowIso();
      this.persistRun(record, entry);
      return this.finishStepDelay(record, entry, stepRun, step);
    }
    const post = await this.evaluateConditions(
      step.postconditions,
      record,
      entry,
      stepDeadline,
    );
    stepRun.postconditions = post;
    this.persistRun(record, entry);
    const falseEvals = post.filter((e) => e.verdict === 'not-satisfied');
    const inconclusive = post.filter((e) => e.verdict === 'inconclusive');
    const summary = post
      .map((p) => `${p.kind}@${p.node} [${p.verdict}] ${p.detail}`)
      .join('; ');
    if (entry.cancelRequested) {
      this.setStepState(record, stepRun, 'cancelled');
      stepRun.error = { code: 'CANCELLED', message: 'cancelled while postconditions were being evaluated' };
      stepRun.finishedAt = nowIso();
      this.persistRun(record, entry);
      return { kind: 'cancelled' };
    }
    if (falseEvals.length > 0) {
      stepRun.verification = 'failed';
      this.emitVerification(record, stepRun, 'postcondition', 'failed', summary);
      return this.applyStepFailedPolicy(record, entry, stepRun, {
        code: 'VERIFICATION_FAILED',
        message: `postcondition(s) evaluated false: ${summary}`,
        details: { evaluations: post },
      });
    }
    if (inconclusive.length > 0) {
      stepRun.verification = 'inconclusive';
      this.emitVerification(record, stepRun, 'postcondition', 'inconclusive', summary);
      if (policy.onVerificationInconclusive === 'warn-and-continue') {
        const warning = `verification inconclusive (warn-and-continue): ${summary}`;
        stepRun.warnings.push(warning);
        record.warnings.push(`step ${stepRun.stepId}: ${warning}`);
        stepRun.policyApplied = 'onVerificationInconclusive=warn-and-continue';
        this.setStepState(record, stepRun, 'completed-with-warnings');
        stepRun.finishedAt = nowIso();
        this.persistRun(record, entry);
        return this.finishStepDelay(record, entry, stepRun, step);
      }
      stepRun.policyApplied = 'onVerificationInconclusive=fail-step';
      return this.applyStepFailedPolicy(record, entry, stepRun, {
        code: 'VERIFICATION_FAILED',
        message: `verification inconclusive: ${summary}`,
        details: { evaluations: post },
      });
    }
    stepRun.verification = 'satisfied';
    this.emitVerification(record, stepRun, 'postcondition', 'satisfied', summary);
    this.setStepState(record, stepRun, 'completed');
    stepRun.finishedAt = nowIso();
    this.persistRun(record, entry);
    return this.finishStepDelay(record, entry, stepRun, step);
  }

  /** delayAfter after a terminal step state (persisted BEFORE advancing). */
  private async finishStepDelay(
    record: ScenarioRunRecord,
    entry: ActiveRunEntry,
    stepRun: ScenarioStepRun,
    step: ScenarioStep,
  ): Promise<StepOutcome> {
    if (step.delayAfterMs <= 0) return { kind: 'continue' };
    this.setRunState(record, 'waiting');
    this.persistRun(record, entry);
    const d = await this.delay(entry, step.delayAfterMs);
    if (d === 'cancelled') return { kind: 'cancelled' };
    if (d === 'timeout') {
      const policy = record.snapshot.execution;
      const error: ScenarioRunError = {
        code: 'STEP_TIMEOUT',
        message: `run deadline expired during delayAfterMs of step ${stepRun.stepId}`,
      };
      record.warnings.push(error.message);
      if (policy.onStepTimeout === 'cancel-run') {
        record.cancellation = {
          requestedBy: 'policy: onStepTimeout=cancel-run',
          requestedAt: nowIso(),
          reason: error.message,
        };
        entry.cancelInfo = record.cancellation;
        return { kind: 'cancelled' };
      }
      return { kind: 'failed', error };
    }
    return { kind: 'continue' };
  }

  // -------------------------------------------------------------------------
  // Policies

  private async applyStepFailedPolicy(
    record: ScenarioRunRecord,
    entry: ActiveRunEntry,
    stepRun: ScenarioStepRun,
    error: ScenarioRunError,
  ): Promise<StepOutcome> {
    stepRun.error = error;
    if (!isTerminalScenarioStepState(stepRun.state)) {
      this.setStepState(record, stepRun, 'failed');
      stepRun.finishedAt = nowIso();
    }
    const policyName = record.snapshot.execution.onStepFailed;
    stepRun.policyApplied = stepRun.policyApplied ?? `onStepFailed=${policyName}`;
    this.persistRun(record, entry);
    if (policyName === 'abort-run') return { kind: 'failed', error };
    if (policyName === 'cancel-run') {
      record.cancellation = {
        requestedBy: 'policy: onStepFailed=cancel-run',
        requestedAt: nowIso(),
        reason: error.message,
      };
      entry.cancelInfo = record.cancellation;
      return { kind: 'cancelled' };
    }
    // 'continue' is only honored when the resulting target state is provably
    // safe — never after an uncertain fault state, failed cleanup, or
    // ambiguous target.
    const unsafe = this.targetUnsafeReason(record, stepRun);
    if (unsafe !== undefined) {
      record.warnings.push(`step ${stepRun.stepId}: continue-policy REFUSED — ${unsafe}`);
      return {
        kind: 'failed',
        error: {
          code: error.code,
          message: `continue-policy refused: ${unsafe} (original: ${error.message})`,
          details: { original: error },
        },
      };
    }
    record.warnings.push(`step ${stepRun.stepId} failed (policy continue): ${error.message}`);
    return { kind: 'continue' };
  }

  private targetUnsafeReason(record: ScenarioRunRecord, stepRun: ScenarioStepRun): string | undefined {
    const targetIds = new Set(record.targetNodes.map((t) => t.nodeId));
    const active = this.faults.activeFaults().find((f) => targetIds.has(f.nodeId));
    if (active !== undefined) {
      return `fault ${active.faultId} (${active.type}) is still active on node ${active.nodeId}`;
    }
    for (const id of targetIds) {
      const quarantined = this.store
        .listFaults({ nodeId: id, limit: 50 })
        .some((f) => f.state === 'cleanup-failed' && f.reconciled !== true);
      if (quarantined) return `node ${id} has an unreconciled cleanup failure (quarantined)`;
    }
    if (stepRun.claims && stepRun.claims.applied && !stepRun.claims.recoveryVerified) {
      return `fault ${stepRun.faultId ?? ''} was applied but recovery was not verified`;
    }
    return undefined;
  }

  private async handleStepTimeout(
    record: ScenarioRunRecord,
    entry: ActiveRunEntry,
    stepRun: ScenarioStepRun,
    reason: string,
  ): Promise<StepOutcome> {
    // Interrupt a fault in flight through the supported mechanism (bounded).
    const active = entry.faultNodeId
      ? this.faults.activeFaults().find((f) => f.nodeId === entry.faultNodeId)
      : undefined;
    if (active !== undefined) {
      try {
        await withTimeout(this.faults.cancel(active.faultId), this.cleanupWaitMs, 'step-timeout cancel');
      } catch {
        // The cleanup path below re-checks reality; the fault record carries
        // its own outcome.
      }
      const faultRecord = this.store.tryGetFault(active.faultId);
      if (faultRecord?.state === 'cleanup-failed') {
        return this.handleQuarantinedStep(
          record,
          entry,
          stepRun,
          faultRecord.error ?? { code: 'INTERNAL', message: 'cleanup unverified after timeout cancel' },
        );
      }
    }
    const error: ScenarioRunError = {
      code: 'STEP_TIMEOUT',
      message: `step ${stepRun.stepId} timed out: ${reason}`,
      details: { reason },
    };
    stepRun.error = error;
    if (!isTerminalScenarioStepState(stepRun.state)) {
      this.setStepState(record, stepRun, 'failed');
      stepRun.finishedAt = nowIso();
    }
    const policyName = record.snapshot.execution.onStepTimeout;
    stepRun.policyApplied = `onStepTimeout=${policyName}`;
    this.persistRun(record, entry);
    if (policyName === 'cancel-run') {
      record.cancellation = {
        requestedBy: 'policy: onStepTimeout=cancel-run',
        requestedAt: nowIso(),
        reason: error.message,
      };
      entry.cancelInfo = record.cancellation;
      return { kind: 'cancelled' };
    }
    return { kind: 'failed', error };
  }

  private handleQuarantinedStep(
    record: ScenarioRunRecord,
    entry: ActiveRunEntry,
    stepRun: ScenarioStepRun,
    faultError: KaizenErrorJson | ScenarioRunError,
  ): StepOutcome {
    stepRun.verification = 'inconclusive';
    const error: ScenarioRunError = {
      code: 'CLEANUP_UNVERIFIED',
      message: `fault ${stepRun.faultId ?? ''} ended cleanup-failed — the target is quarantined; the run cannot claim recovery`,
      details: { faultId: stepRun.faultId, faultError, claims: stepRun.claims },
    };
    stepRun.error = error;
    stepRun.policyApplied = 'onCleanupFailed=cancel-run';
    if (!isTerminalScenarioStepState(stepRun.state)) {
      this.setStepState(record, stepRun, 'cleaning-up');
      this.setStepState(record, stepRun, 'cleanup-failed');
      stepRun.finishedAt = nowIso();
    }
    // The cancel path's cleanup check finds the quarantine and terminalizes
    // the run as cleanup-failed (record.error is already set).
    record.error = error;
    record.warnings.push(`step ${stepRun.stepId}: cleanup unverified — target quarantined`);
    this.persistRun(record, entry);
    return { kind: 'cancelled' };
  }

  // -------------------------------------------------------------------------
  // Cancellation & cleanup paths

  private async enterCancelPath(record: ScenarioRunRecord, entry: ActiveRunEntry): Promise<void> {
    if (entry.cancelInfo && !record.cancellation) record.cancellation = entry.cancelInfo;
    if (canTransitionRun(record.state, 'cancel-requested')) {
      this.setRunState(record, 'cancel-requested');
      this.persistRun(record, entry);
    }
    const cleanup = await this.runCleanup(record, entry);
    record.cleanup = cleanup;
    if (!cleanup.verified) {
      record.error ??= {
        code: 'CLEANUP_UNVERIFIED',
        message: `cancellation could not confirm cleanup: ${cleanup.detail}`,
        details: { cleanup },
      };
      await this.finishRun(record, entry, 'cleanup-failed', record.error, true);
      return;
    }
    record.error ??= {
      code: 'CANCELLED',
      message: 'run cancelled by request; cleanup confirmed',
    };
    await this.finishRun(record, entry, 'cancelled', record.error, true);
  }

  /**
   * Guaranteed run-level cleanup (attempted on EVERY finish path): cancel
   * any active injector fault on the run's targets through the supported
   * mechanism (bounded wait), then verify nothing is active and no target
   * stays quarantined.
   */
  private async runCleanup(
    record: ScenarioRunRecord,
    entry: ActiveRunEntry,
  ): Promise<ScenarioRunCleanup> {
    const targetIds = record.targetNodes.map((t) => t.nodeId);
    let active = this.faults.activeFaults().filter((f) => targetIds.includes(f.nodeId));
    const actions: ScenarioRunCleanupAction[] = [];
    if (active.length > 0 && canTransitionRun(record.state, 'cleaning-up')) {
      this.setRunState(record, 'cleaning-up');
      this.persistRun(record, entry);
    }
    for (const fault of active) {
      try {
        await withTimeout(this.faults.cancel(fault.faultId), this.cleanupWaitMs, 'run cleanup');
        const faultRecord = this.store.tryGetFault(fault.faultId);
        const verified =
          faultRecord?.state === 'cancelled' || faultRecord?.state === 'completed';
        actions.push({
          faultId: fault.faultId,
          nodeId: fault.nodeId,
          action: 'cancel',
          verified,
          detail: verified
            ? `fault ended ${faultRecord?.state} with verified recovery`
            : `fault ended ${faultRecord?.state ?? 'unknown'} — recovery NOT verified`,
          at: nowIso(),
        });
      } catch (e) {
        actions.push({
          faultId: fault.faultId,
          nodeId: fault.nodeId,
          action: 'cancel',
          verified: false,
          detail: `cancel failed: ${e instanceof Error ? e.message : String(e)}`,
          at: nowIso(),
        });
      }
    }
    active = this.faults.activeFaults().filter((f) => targetIds.includes(f.nodeId));
    const quarantined = targetIds.some((nodeId) =>
      this.store
        .listFaults({ nodeId, limit: 50 })
        .some((f) => f.state === 'cleanup-failed' && f.reconciled !== true),
    );
    const verified = active.length === 0 && !quarantined && actions.every((a) => a.verified);
    const detail = [
      `active faults at finish: ${actions.length > 0 ? actions.length : 0}`,
      actions.length > 0 ? `actions: ${actions.map((a) => `${a.faultId}→${a.verified ? 'verified' : 'unverified'}`).join(', ')}` : 'nothing to roll back',
      quarantined ? 'target quarantined (unreconciled cleanup failure)' : 'no quarantine',
    ].join('; ');
    return {
      checkedAt: nowIso(),
      activeFaultsFound: actions.length,
      actions,
      quarantined,
      verified,
      detail,
    };
  }

  private async finishRun(
    record: ScenarioRunRecord,
    entry: ActiveRunEntry,
    finalState: ScenarioRunState,
    error: ScenarioRunError | null,
    cleanupAlreadyRan = false,
  ): Promise<void> {
    const cleanup = cleanupAlreadyRan && record.cleanup ? record.cleanup : await this.runCleanup(record, entry);
    record.cleanup = cleanup;
    let state = finalState;
    if (!cleanup.verified && state !== 'cleanup-failed') state = 'cleanup-failed';
    if (state === 'completed' && record.state === 'cleaning-up') {
      // Run-level cleanup had to intervene on a normal finish — say so.
      state = 'completed-with-warnings';
      record.warnings.push('run-level cleanup intervened before completion');
    }
    if (error) record.error = error;
    if (state === 'failed' && !record.error) {
      record.error = { code: 'STEP_FAILED', message: 'run failed' };
    }
    if (!cleanup.verified && state === 'cleanup-failed') {
      record.error ??= {
        code: 'CLEANUP_UNVERIFIED',
        message: `run could not confirm cleanup: ${cleanup.detail}`,
        details: { cleanup },
      };
      this.events.emit('scenario-run.cleanup-failed', {
        runId: record.id,
        networkId: record.networkId,
        severity: 'high',
        message: `Scenario run ${record.id} ended cleanup-failed — target quarantined until reconcile() proves the effect gone`,
        at: nowIso(),
      });
    }
    record.finishedAt = nowIso();
    this.setRunState(record, state);
    this.persistRun(record);
    this.store.finishOperation(entry.opId, {
      status: state === 'completed' || state === 'completed-with-warnings' ? 'ok' : 'error',
      ...(state === 'completed' || state === 'completed-with-warnings'
        ? {}
        : { errorCode: record.error?.code ?? 'STEP_FAILED', errorMessage: record.error?.message }),
      detail: { runId: record.id, state, warnings: record.warnings.length },
    });
    this.emitFinished(record);
    this.releaseActive(entry);
  }

  private releaseActive(entry: ActiveRunEntry): void {
    this.active.delete(entry.runId);
    if (this.activeNetworks.get(entry.networkId) === entry.runId) {
      this.activeNetworks.delete(entry.networkId);
    }
    if (this.activeScenarios.get(entry.scenarioId) === entry.runId) {
      this.activeScenarios.delete(entry.scenarioId);
    }
  }

  // -------------------------------------------------------------------------
  // Condition evaluation (bounded; evidence recorded per condition)

  private async evaluateConditions(
    conditions: ScenarioCondition[],
    record: ScenarioRunRecord,
    entry: ActiveRunEntry,
    deadline: number,
  ): Promise<ScenarioConditionEval[]> {
    const network = this.store.getNetwork(record.networkId);
    const evals: ScenarioConditionEval[] = [];
    for (const cond of conditions) {
      const started = Date.now();
      const budget = Math.min(
        cond.timeoutMs ?? SCENARIO_CONDITION_DEFAULT_TIMEOUT_MS,
        Math.max(0, deadline - Date.now()),
      );
      const evaluator = createConditionEvaluator(cond, {
        store: this.store,
        monitoring: this.monitoring,
        observer: this.observer,
        network,
        isCancelled: () => entry.cancelRequested,
      });
      let attempts = 0;
      let last: ConditionAttempt = { satisfied: false, detail: 'not evaluated' };
      for (;;) {
        attempts += 1;
        last = await evaluator.attempt();
        if (last.satisfied || entry.cancelRequested) break;
        const remaining = budget - (Date.now() - started);
        if (remaining <= 0) break;
        await sleep(Math.min(SCENARIO_CONDITION_POLL_MS, remaining));
      }
      const verdict: ScenarioConditionEval['verdict'] = last.satisfied
        ? 'satisfied'
        : last.inconclusive !== undefined
          ? 'inconclusive'
          : 'not-satisfied';
      const node = resolveNodeLabel(this.store, network, cond.node);
      evals.push({
        kind: cond.kind,
        node: cond.node,
        nodeId: node?.id ?? null,
        verdict,
        detail: last.inconclusive ?? last.detail,
        attempts,
        waitedMs: Date.now() - started,
        at: nowIso(),
      });
    }
    return evals;
  }

  private async delay(
    entry: ActiveRunEntry,
    ms: number,
  ): Promise<'done' | 'cancelled' | 'timeout'> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (entry.cancelRequested) return 'cancelled';
      if (Date.now() >= entry.runDeadline) return 'timeout';
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    }
    if (entry.cancelRequested) return 'cancelled';
    return Date.now() >= entry.runDeadline ? 'timeout' : 'done';
  }

  // -------------------------------------------------------------------------
  // Record construction + state transitions

  private newRunRecord(
    scenario: ScenarioRecord,
    req: ScenarioRunRequest,
    replayOfRunId: string | null,
  ): ScenarioRunRecord {
    const at = nowIso();
    return {
      id: `run-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      scenarioSchemaVersion: scenario.schemaVersion,
      snapshot: structuredClone(scenario),
      networkId: req.networkIdOrName,
      networkName: '',
      targetNodes: [],
      requestedBy: req.requestedBy ?? 'engine',
      replayOfRunId,
      // NOTE: replay honesty is exposed via scenarioRunReplayNote(run) and
      // the `replayOfRunId` provenance field — NOT via `warnings`, which are
      // reserved for execution-time observations (a clean replay must reach
      // plain 'completed', exactly like a clean original run).
      warnings: [],
      state: 'queued',
      currentStepId: null,
      currentStepOrder: null,
      steps: [],
      validation: null,
      error: null,
      cleanup: null,
      cancellation: null,
      createdAt: at,
      startedAt: null,
      updatedAt: at,
      finishedAt: null,
    };
  }

  private newStepRun(
    step: ScenarioStep,
    gate: { targetNodes: ScenarioRunRecord['targetNodes'] },
  ): ScenarioStepRun {
    const nodeLabel = (step.operation.config as { node: string }).node;
    const resolved = gate.targetNodes.find((t) => t.label === nodeLabel);
    return {
      stepId: step.id,
      order: step.order,
      operationType: step.operation.type,
      faultType:
        this.scenarios.operations.get(step.operation.type)?.kind === 'fault'
          ? (step.operation.type as FaultType)
          : null,
      nodeLabel,
      nodeId: resolved?.nodeId ?? null,
      nodeName: resolved?.nodeName ?? null,
      state: 'pending',
      startedAt: null,
      finishedAt: null,
      preconditions: [],
      postconditions: [],
      verification: 'pending',
      faultId: null,
      outcome: null,
      claims: null,
      durationMs: null,
      policyApplied: null,
      warnings: [],
      error: null,
    };
  }

  private setRunState(record: ScenarioRunRecord, to: ScenarioRunState): void {
    const from = record.state;
    if (from === to) return;
    if (!canTransitionRun(from, to)) {
      throw new KaizenError('INTERNAL', `Illegal scenario-run transition ${from} → ${to}`, {
        from,
        to,
        runId: record.id,
      });
    }
    record.state = to;
    record.updatedAt = nowIso();
    this.events.emit('scenario-run.state', {
      runId: record.id,
      scenarioId: record.scenarioId,
      networkId: record.networkId,
      from,
      to,
      at: record.updatedAt,
    });
  }

  private setStepState(
    record: ScenarioRunRecord,
    stepRun: ScenarioStepRun,
    to: ScenarioStepState,
  ): void {
    const from = stepRun.state;
    if (from === to) return;
    if (!canTransitionStep(from, to)) {
      throw new KaizenError(
        'INTERNAL',
        `Illegal scenario-step transition ${from} → ${to} (step ${stepRun.stepId})`,
        { from, to, runId: record.id, stepId: stepRun.stepId },
      );
    }
    stepRun.state = to;
    this.events.emit('scenario-run.step', {
      runId: record.id,
      stepId: stepRun.stepId,
      order: stepRun.order,
      operation: stepRun.operationType,
      from,
      to,
      at: nowIso(),
    });
  }

  private emitVerification(
    record: ScenarioRunRecord,
    stepRun: ScenarioStepRun,
    phase: 'precondition' | 'postcondition',
    verdict: 'satisfied' | 'failed' | 'inconclusive' | 'not-required',
    detail: string,
  ): void {
    this.events.emit('scenario-run.verification', {
      runId: record.id,
      stepId: stepRun.stepId,
      phase,
      verdict,
      detail,
      at: nowIso(),
    });
  }

  private emitFinished(record: ScenarioRunRecord): void {
    this.events.emit('scenario-run.finished', {
      runId: record.id,
      scenarioId: record.scenarioId,
      networkId: record.networkId,
      state: record.state,
      stepCount: record.steps.length,
      warnings: record.warnings.length,
      at: record.finishedAt ?? nowIso(),
    });
  }

  /** Persist the whole run row (atomic single statement), merging the
   *  cancellation request that may have arrived via cancel(). */
  private persistRun(record: ScenarioRunRecord, entry?: ActiveRunEntry): void {
    if (entry?.cancelInfo && !record.cancellation) record.cancellation = entry.cancelInfo;
    record.updatedAt = nowIso();
    this.store.updateScenarioRun(redactDeep(record));
  }
}

// ---------------------------------------------------------------------------
// helpers

function pauseDurationOf(step: ScenarioStep): number | undefined {
  if (step.operation.type !== 'pause') return undefined;
  const duration = (step.operation.config as { durationMs?: number }).durationMs;
  return typeof duration === 'number' ? duration : undefined;
}

function toRunError(e: unknown): ScenarioRunError {
  if (isKaizen(e)) {
    const code: ScenarioRunError['code'] =
      e.code === 'SCENARIO_INVALID'
        ? 'VALIDATION_FAILED'
        : e.code === 'SCENARIO_RUN_CONFLICT'
          ? 'CONFLICT'
          : e.code === 'NETWORK_NOT_FOUND'
            ? 'TARGET_UNRESOLVED'
            : e.code === 'SCENARIO_EXEC_NOT_ALLOWED'
              ? 'GATE_REFUSED'
              : 'GATE_REFUSED';
    return { code, message: e.message, details: e.details };
  }
  return { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) };
}

function isKaizen(e: unknown): e is KaizenError {
  return e instanceof KaizenError;
}
