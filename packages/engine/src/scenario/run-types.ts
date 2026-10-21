/**
 * Scenario run model (T-3.4, Phase 3D) — the execution-side types of the
 * ScenarioEngine.
 *
 * A run is the durable, auditable record of ONE execution of a scenario
 * definition against ONE explicitly selected target network. It carries an
 * IMMUTABLE snapshot of the scenario it ran (history survives later edits
 * or deletion of the scenario), per-step outcomes with evidence, the fresh
 * run-time validation result, cleanup results, and cancellation info.
 *
 * Like the fault lifecycle, every run and step state change is typed and
 * asserted against a legal-transition map: illegal transitions are refused,
 * never coerced. A saved scenario never runs by itself — only ScenarioEngine
 * .execute() (an explicit, mode:'execute'-marked request) creates runs.
 *
 * NO SECRETS are ever stored in run records: the snapshot passes through
 * the same redaction as fault evidence, and evidence contains observed
 * facts (timestamps, pids, RPC observations) only.
 */

import type { FaultOutcome, FaultRunClaims, FaultType } from '../fault/types';
import type {
  ScenarioConditionKind,
  ScenarioOperationType,
  ScenarioRecord,
  ScenarioValidationResult,
} from './types';

// ---------------------------------------------------------------------------
// Run states

/**
 * Run lifecycle states:
 *  - queued                run record persisted, gates not yet evaluated
 *  - validating            fresh scenario/target/registry validation in progress
 *  - rejected              a safety/authoring gate refused BEFORE any side effect
 *  - running               a step's operation (or its gates) are executing
 *  - waiting               a bounded delay between actions
 *  - verifying             postconditions are being evaluated
 *  - cancel-requested      cancellation was requested; cleanup will follow
 *  - cleaning-up           an actual rollback/cleanup action is in progress
 *  - completed             all steps ran, all verifications held, cleanup confirmed
 *  - completed-with-warnings  finished, but with recorded warnings (skipped
 *                          step, inconclusive-then-continued verification, …)
 *  - failed                a step/policy aborted the run
 *  - cancelled             cancellation completed with cleanup confirmed
 *  - cleanup-failed        the run could NOT confirm its cleanup — the target
 *                          is quarantined until reconcile() proves the effect
 *                          is gone. Never claims recovery.
 */
export const SCENARIO_RUN_STATES = [
  'queued',
  'validating',
  'rejected',
  'running',
  'waiting',
  'verifying',
  'cancel-requested',
  'cleaning-up',
  'completed',
  'completed-with-warnings',
  'failed',
  'cancelled',
  'cleanup-failed',
] as const;
export type ScenarioRunState = (typeof SCENARIO_RUN_STATES)[number];

/** Legal run transitions. Every change is asserted against this map. */
export const SCENARIO_RUN_TRANSITIONS: Record<ScenarioRunState, readonly ScenarioRunState[]> = {
  queued: ['validating', 'rejected', 'cancel-requested', 'failed', 'cancelled'],
  validating: ['rejected', 'running', 'waiting', 'cancel-requested', 'failed', 'cancelled'],
  rejected: [],
  running: [
    'waiting',
    'verifying',
    'cancel-requested',
    'cleaning-up',
    'cleanup-failed',
    'completed',
    'completed-with-warnings',
    'failed',
  ],
  waiting: [
    'running',
    'verifying',
    'cancel-requested',
    'cleaning-up',
    'cleanup-failed',
    'completed',
    'completed-with-warnings',
    'failed',
    'cancelled',
  ],
  verifying: [
    'running',
    'waiting',
    'cancel-requested',
    'cleaning-up',
    'cleanup-failed',
    'completed',
    'completed-with-warnings',
    'failed',
    'cancelled',
  ],
  'cancel-requested': ['cleaning-up', 'cancelled', 'cleanup-failed', 'failed'],
  'cleaning-up': ['cancelled', 'cleanup-failed', 'failed', 'completed-with-warnings'],
  completed: [],
  'completed-with-warnings': [],
  failed: [],
  cancelled: [],
  'cleanup-failed': [],
};

export const TERMINAL_SCENARIO_RUN_STATES: readonly ScenarioRunState[] = [
  'rejected',
  'completed',
  'completed-with-warnings',
  'failed',
  'cancelled',
  'cleanup-failed',
];

export function isTerminalScenarioRunState(state: ScenarioRunState): boolean {
  return TERMINAL_SCENARIO_RUN_STATES.includes(state);
}

/**
 * States whose recorded actions may be replayed (T-3.5). Deliberately
 * EXCLUDES `rejected` (the run never executed any action — replay it by
 * executing the scenario, not by replaying a refusal) and every unfinished
 * state (the architecture never resumes unfinished runs — a crash-interrupted
 * run is reconciled to a terminal state first). `cleanup-failed` is included
 * because replay re-runs the current gates: an unreconciled quarantine still
 * blocks the target fail-closed.
 */
export const REPLAYABLE_SCENARIO_RUN_STATES = [
  'completed',
  'completed-with-warnings',
  'failed',
  'cancelled',
  'cleanup-failed',
] as const satisfies readonly ScenarioRunState[];

export function isReplayableScenarioRunState(state: ScenarioRunState): boolean {
  return (REPLAYABLE_SCENARIO_RUN_STATES as readonly ScenarioRunState[]).includes(state);
}

/**
 * Honest replay semantics for API responses and UI (T-3.5): a replay repeats
 * the source run's ACTIONS; it never claims identical outcomes (chain state,
 * node health, peers, timing, finality, and runtime events may differ), and
 * every piece of its evidence was freshly observed. Null for original runs.
 * Deliberately not a `warnings` entry — a clean replay must still reach
 * plain 'completed'.
 */
export function scenarioRunReplayNote(
  run: Pick<ScenarioRunRecord, 'replayOfRunId'>,
): string | null {
  return run.replayOfRunId !== null
    ? `Replay of run ${run.replayOfRunId}: repeats the recorded actions as a NEW run — identical outcomes are NOT guaranteed (chain state, peers, timing, finality, and runtime events may differ); every piece of evidence was freshly observed.`
    : null;
}

export function canTransitionRun(from: ScenarioRunState, to: ScenarioRunState): boolean {
  return SCENARIO_RUN_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Step states

/**
 * Step lifecycle states (mirrors the per-step execution semantics):
 *  - pending   ordered, not yet entered
 *  - waiting   delayBefore in progress
 *  - running   preconditions → revalidation → the operation itself
 *  - verifying postconditions being evaluated
 *  - cleaning-up  rollback/cleanup engaged (cancel during the operation)
 * Terminal: completed / completed-with-warnings / failed / skipped /
 * cancelled / cleanup-failed.
 */
export const SCENARIO_STEP_STATES = [
  'pending',
  'waiting',
  'running',
  'verifying',
  'cleaning-up',
  'completed',
  'completed-with-warnings',
  'failed',
  'skipped',
  'cancelled',
  'cleanup-failed',
] as const;
export type ScenarioStepState = (typeof SCENARIO_STEP_STATES)[number];

export const SCENARIO_STEP_TRANSITIONS: Record<ScenarioStepState, readonly ScenarioStepState[]> = {
  pending: ['waiting', 'running', 'skipped', 'cancelled', 'failed'],
  waiting: ['running', 'skipped', 'cancelled', 'failed'],
  running: ['verifying', 'cleaning-up', 'failed', 'cancelled', 'skipped'],
  verifying: ['cleaning-up', 'completed', 'completed-with-warnings', 'failed', 'cancelled'],
  'cleaning-up': ['completed', 'completed-with-warnings', 'failed', 'cancelled', 'cleanup-failed'],
  completed: [],
  'completed-with-warnings': [],
  failed: [],
  skipped: [],
  cancelled: [],
  'cleanup-failed': [],
};

export const TERMINAL_SCENARIO_STEP_STATES: readonly ScenarioStepState[] = [
  'completed',
  'completed-with-warnings',
  'failed',
  'skipped',
  'cancelled',
  'cleanup-failed',
];

export function isTerminalScenarioStepState(state: ScenarioStepState): boolean {
  return TERMINAL_SCENARIO_STEP_STATES.includes(state);
}

export function canTransitionStep(from: ScenarioStepState, to: ScenarioStepState): boolean {
  return SCENARIO_STEP_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Persisted errors (run/step evidence taxonomy — distinct from thrown
// KaizenError codes: these describe OUTCOMES inside a run, they are never
// transport errors)

export const SCENARIO_RUN_ERROR_CODES = [
  /** Fresh run-time validation refused the definition (registry drift, …). */
  'VALIDATION_FAILED',
  /** A safety/authorization gate refused the target before any side effect. */
  'GATE_REFUSED',
  /** A referenced operation is not supported/executable today. */
  'UNSUPPORTED_OPERATION',
  /** Target network/label could not be resolved. */
  'TARGET_UNRESOLVED',
  /** A conflicting run/fault is already active against the target. */
  'CONFLICT',
  /** Precondition did not hold within its bounded wait. */
  'PRECONDITION_FAILED',
  /** The operation itself failed. */
  'STEP_FAILED',
  /** Required postconditions evaluated false. */
  'VERIFICATION_FAILED',
  /** Step budget or the run deadline was exhausted. */
  'STEP_TIMEOUT',
  /** The run was cancelled (cleanup confirmed — else it is cleanup-failed). */
  'CANCELLED',
  /** Cleanup could not be confirmed; the target is quarantined. */
  'CLEANUP_UNVERIFIED',
  /** The process restarted mid-run; the run was NOT resumed. */
  'INTERRUPTED',
  /** Unexpected executor-internal failure (terminalized honestly). */
  'INTERNAL',
] as const;
export type ScenarioRunErrorCode = (typeof SCENARIO_RUN_ERROR_CODES)[number];

export interface ScenarioRunError {
  code: ScenarioRunErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Evidence: condition evaluations and step outcomes

export type ScenarioConditionVerdict = 'satisfied' | 'not-satisfied' | 'inconclusive';

/** One condition's FINAL evaluated outcome (with its wait/attempt budget). */
export interface ScenarioConditionEval {
  kind: ScenarioConditionKind;
  /** Node label the condition observed. */
  node: string;
  /** Resolved engine node id (null when the label could not be resolved). */
  nodeId: string | null;
  verdict: ScenarioConditionVerdict;
  /** Observed facts explaining the verdict (never assumptions). */
  detail: string;
  attempts: number;
  waitedMs: number;
  at: string;
}

export type ScenarioStepVerification =
  | 'pending'
  /** All postconditions held within their bounded waits. */
  | 'satisfied'
  /** No postconditions were authored; the injector's independently observed
   *  recovery claims are the recorded evidence (flagged as a warning). */
  | 'not-required'
  /** At least one postcondition evaluated false. */
  | 'failed'
  /** At least one postcondition could not be evaluated (none false). */
  | 'inconclusive';

/** One executed step's durable record (ordered, evidence-carrying). */
export interface ScenarioStepRun {
  stepId: string;
  order: number;
  operationType: ScenarioOperationType;
  /** Underlying injector fault type for fault steps (else null). */
  faultType: FaultType | null;
  /** Node label targeted by the operation. */
  nodeLabel: string;
  nodeId: string | null;
  nodeName: string | null;
  state: ScenarioStepState;
  startedAt: string | null;
  finishedAt: string | null;
  preconditions: ScenarioConditionEval[];
  postconditions: ScenarioConditionEval[];
  verification: ScenarioStepVerification;
  /** Fault id created in the FailureInjector for this step (null if none). */
  faultId: string | null;
  /** Injector outcome/claims for this step (null when no fault ran). */
  outcome: FaultOutcome | null;
  claims: FaultRunClaims | null;
  durationMs: number | null;
  /** Which policy decided this step's run-level reaction (e.g.
   *  'onStepFailed=abort-run'). */
  policyApplied: string | null;
  warnings: string[];
  error: ScenarioRunError | null;
}

// ---------------------------------------------------------------------------
// Run-level results

export interface ScenarioRunTargetNode {
  /** Topology label as authored ('alice'). */
  label: string;
  nodeId: string;
  nodeName: string;
}

export interface ScenarioRunCleanupAction {
  faultId: string;
  nodeId: string;
  action: 'cancel';
  verified: boolean;
  detail: string;
  at: string;
}

/** Run-level guaranteed-cleanup outcome (attempted on EVERY finish path). */
export interface ScenarioRunCleanup {
  checkedAt: string;
  /** Active injector faults found on the run's target nodes at finish time. */
  activeFaultsFound: number;
  actions: ScenarioRunCleanupAction[];
  /** True when a target node remains quarantined (unreconciled cleanup
   *  failure) — the run never claims recovery in that case. */
  quarantined: boolean;
  verified: boolean;
  detail: string;
}

export interface ScenarioRunCancellation {
  requestedBy: string;
  requestedAt: string;
  reason?: string;
}

/** The full durable record of one scenario run. */
export interface ScenarioRunRecord {
  id: string;
  scenarioId: string;
  scenarioName: string;
  scenarioSchemaVersion: number;
  /** IMMUTABLE snapshot of the definition this run executed. */
  snapshot: ScenarioRecord;
  /** Resolved target network id (or the requested ref before resolution). */
  networkId: string;
  networkName: string;
  /** Label → node resolution used for this run (empty before resolution). */
  targetNodes: ScenarioRunTargetNode[];
  /** Audit actor ('api', 'cli', 'test', …). */
  requestedBy: string;
  /** Source run this run REPLAYS (null for original executions, T-3.5). */
  replayOfRunId: string | null;
  /**
   * OS pid of the process executing this run — set at insert by the owning
   * engine and immutable afterwards (like `replayOfRunId`). Startup
   * reconciliation consults it: a non-terminal run whose executor pid is
   * still alive is NOT an orphan and is never terminalized — nodes are
   * daemons and CLI/API processes are short-lived and concurrent (T-3.6A),
   * so "unfinished" alone never proves a crash. Absent/null on rows created
   * before this field existed → treated as unknown → reconciled as before.
   */
  executorPid?: number | null;
  state: ScenarioRunState;
  currentStepId: string | null;
  currentStepOrder: number | null;
  steps: ScenarioStepRun[];
  /** Fresh validation executed at run time (RSK-28 gate). */
  validation: ScenarioValidationResult | null;
  /** Execution-time warnings (drive completed-with-warnings). */
  warnings: string[];
  error: ScenarioRunError | null;
  cleanup: ScenarioRunCleanup | null;
  cancellation: ScenarioRunCancellation | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
}

/** Lightweight list view (history browsing) — no snapshot/steps payload. */
export interface ScenarioRunSummary {
  id: string;
  scenarioId: string;
  scenarioName: string;
  networkId: string;
  networkName: string;
  state: ScenarioRunState;
  currentStepId: string | null;
  currentStepOrder: number | null;
  stepCount: number;
  completedSteps: number;
  requestedBy: string;
  replayOfRunId: string | null;
  warnings: number;
  error: ScenarioRunError | null;
  cancellation: ScenarioRunCancellation | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** A run row this build cannot read (corrupt JSON) — surfaced, never dropped. */
export interface ScenarioRunMalformedEntry {
  id: string;
  message: string;
}

export interface ScenarioRunListResult {
  runs: ScenarioRunRecord[];
  malformed: ScenarioRunMalformedEntry[];
}

// ---------------------------------------------------------------------------
// Startup reconciliation (crash recovery — never resumes execution)

export interface InterruptedFaultOutcome {
  faultId: string;
  nodeId: string;
  /** State the stuck record was moved to before reconciliation. */
  transitioned: string;
  /** True when reconcile() proved the effect gone (quarantine released). */
  released: boolean;
  detail: string;
}

export interface InterruptedRunOutcome {
  runId: string;
  scenarioId: string;
  networkId: string;
  finalState: ScenarioRunState;
  faults: InterruptedFaultOutcome[];
  detail: string;
}

export interface ScenarioRunReconcileReport {
  at: string;
  /**
   * Runs that were unfinished at startup: terminalized when their executor
   * process is gone (crash orphans), or DEFERRED — `finalState` unchanged,
   * `detail` names the live executor — when another live process still owns
   * them (multi-process CLI/API topology, T-3.6A). Never resumed either way.
   */
  runs: InterruptedRunOutcome[];
  /** True when at least one target stayed quarantined. */
  quarantined: boolean;
  error?: string;
}

export function toRunSummary(record: ScenarioRunRecord): ScenarioRunSummary {
  return {
    id: record.id,
    scenarioId: record.scenarioId,
    scenarioName: record.scenarioName,
    networkId: record.networkId,
    networkName: record.networkName,
    state: record.state,
    currentStepId: record.currentStepId,
    currentStepOrder: record.currentStepOrder,
    stepCount: record.steps.length,
    completedSteps: record.steps.filter(
      (s) => s.state === 'completed' || s.state === 'completed-with-warnings',
    ).length,
    requestedBy: record.requestedBy,
    replayOfRunId: record.replayOfRunId,
    warnings: record.warnings.length,
    error: record.error,
    cancellation: record.cancellation,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };
}
