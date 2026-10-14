/**
 * Scenario model (T-3.3, Phase 3C) — the reusable, validated, persistable
 * authoring foundation for the Failure Lab.
 *
 * A scenario is DATA: ordered steps with typed operations (from the safe
 * operation registry, which mirrors the FailureInjector's actual adapters),
 * bounded delays, typed pre/postconditions, per-step timeouts, and explicit
 * failure/cancellation semantics. Nothing here executes anything — scenario
 * CRUD and validation are pure (execution is T-3.4, the ScenarioEngine).
 *
 * Conditions are typed, inspectable data — never arbitrary executable
 * strings. Only conditions the current architecture can meaningfully
 * evaluate are 'supported'; known-but-not-yet-evaluable conditions exist in
 * the model with evaluability 'planned' and are REJECTED by validation
 * (never silently accepted as if they could be checked).
 */

import type { FaultType } from '../fault/types';
import type { NetworkPreset, NodeHealthState, NodeStatus } from '../types';

/** Bump when the persisted scenario shape changes (content migrations). */
export const SCENARIO_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Central authoring limits (single source for validation bounds)

export const SCENARIO_MAX_STEPS = 50;
export const SCENARIO_MAX_DELAY_MS = 300_000;
export const SCENARIO_MIN_STEP_TIMEOUT_MS = 5_000;
export const SCENARIO_MAX_STEP_TIMEOUT_MS = 900_000;
/** Worst-case sum of delays + step timeouts for one scenario run. */
export const SCENARIO_MAX_DURATION_MS = 1_800_000;
export const SCENARIO_MAX_TAGS = 8;
export const SCENARIO_MAX_CONDITIONS_PER_SIDE = 10;
/** A pause step's timeout must cover the hold + cleanup/recovery budget. */
export const SCENARIO_PAUSE_HOLD_HEADROOM_MS = 60_000;
export const SCENARIO_DEFAULT_PAUSE_HOLD_MS = 10_000;
export const SCENARIO_MAX_PAUSE_HOLD_MS = 600_000;
/** Condition evaluation is bounded (executor waits at most this per condition). */
export const SCENARIO_CONDITION_DEFAULT_TIMEOUT_MS = 30_000;
export const SCENARIO_MAX_CONDITION_TIMEOUT_MS = 60_000;
export const SCENARIO_MAX_NAME_LENGTH = 64;
export const SCENARIO_MAX_DESCRIPTION_LENGTH = 1_000;
export const SCENARIO_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
export const SCENARIO_TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,23}$/;
export const SCENARIO_STEP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Node label within a topology (suffix after "<networkName>-"). */
export const SCENARIO_NODE_LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// ---------------------------------------------------------------------------
// Operations

/**
 * Scenario operation types. Fault types come straight from the injector;
 * 'node-restart' is a planned lifecycle operation. Extend this union when
 * FAULT_TYPES grows — the operation registry is the runtime source of truth
 * for support status, this union is the compile-time contract.
 */
export type ScenarioOperationType = FaultType | 'node-restart';

export interface NodeTargetOperationConfig {
  /** Node label within the target topology (e.g. 'alice' → "<net>-alice"). */
  node: string;
}

export interface PauseOperationConfig extends NodeTargetOperationConfig {
  /** Hold duration for the pause (ms), bounded like the injector's. */
  durationMs?: number;
}

export type ScenarioOperation =
  | { type: 'pause'; config: PauseOperationConfig }
  | { type: 'terminate'; config: NodeTargetOperationConfig }
  | { type: 'peer-disconnect'; config: NodeTargetOperationConfig }
  | { type: 'partition'; config: NodeTargetOperationConfig }
  | { type: 'node-restart'; config: NodeTargetOperationConfig };

// ---------------------------------------------------------------------------
// Conditions (typed, inspectable data — never executable strings)

export const SCENARIO_CONDITION_KINDS = [
  'rpc-reachable',
  'process-state',
  'health-state',
  'peers',
  'syncing',
  'chain-progress',
  'recovery-verified',
  // known but NOT yet evaluable by current monitoring (validation rejects):
  'finality-progress',
  'runtime-event',
] as const;
export type ScenarioConditionKind = (typeof SCENARIO_CONDITION_KINDS)[number];

/** Whether the current architecture can meaningfully evaluate this condition. */
export type ConditionEvaluability = 'supported' | 'planned';

interface ConditionBase {
  /** Node label this condition observes (same namespace as step configs). */
  node: string;
  /** Bounded evaluation wait (executor polls until true or timeout). */
  timeoutMs?: number;
}

export type ScenarioCondition =
  | (ConditionBase & { kind: 'rpc-reachable'; expect: boolean })
  /** Process state: one of the engine's persisted NodeStatus values. */
  | (ConditionBase & { kind: 'process-state'; expect: NodeStatus[] })
  /** Interpreted health from the monitoring machine (T-2.4). */
  | (ConditionBase & { kind: 'health-state'; expect: NodeHealthState[] })
  /** Peer count as observed via system_health/system_peers. */
  | (ConditionBase & { kind: 'peers'; op: 'gte' | 'lte' | 'eq'; value: number })
  | (ConditionBase & { kind: 'syncing'; expect: boolean })
  /** Block-production progress (health-machine stall detection). */
  | (ConditionBase & { kind: 'chain-progress'; expect: 'advancing' | 'stalled' })
  /** Recovery claim of the most recent fault step on this node. */
  | (ConditionBase & { kind: 'recovery-verified' })
  /** Planned: finalized-head progression is sampled but not tracked yet. */
  | (ConditionBase & { kind: 'finality-progress'; expect: 'advancing' | 'stalled' })
  /** Planned: runtime events (imOnline etc.) are Phase 5 diagnostics work. */
  | (ConditionBase & {
      kind: 'runtime-event';
      event: string;
      expect: 'observed' | 'not-observed';
    });

// ---------------------------------------------------------------------------
// Failure / cancellation semantics (persisted + validated now, executed later)

export interface ScenarioExecutionPolicy {
  /** Precondition did not hold within its bounded wait. */
  onPreconditionFailed: 'skip-step' | 'abort-run' | 'cancel-run';
  /** The step itself failed (apply error, failed postcondition). */
  onStepFailed: 'abort-run' | 'continue' | 'cancel-run';
  /** Postcondition neither true nor false within bounds (inconclusive). */
  onVerificationInconclusive: 'fail-step' | 'warn-and-continue';
  /** Step timeout (covers delays outside the step + condition waits). */
  onStepTimeout: 'fail-step' | 'cancel-run';
  /** A fault step ended cleanup-failed. Injector already quarantines the
   *  node; the only safe scenario reaction today is to stop the run. */
  onCleanupFailed: 'cancel-run';
  /** How cancellation behaves: faults are always rolled back first. */
  cancellation: 'cleanup-then-stop';
}

export const DEFAULT_SCENARIO_EXECUTION_POLICY: ScenarioExecutionPolicy = {
  onPreconditionFailed: 'abort-run',
  onStepFailed: 'abort-run',
  onVerificationInconclusive: 'fail-step',
  onStepTimeout: 'fail-step',
  onCleanupFailed: 'cancel-run',
  cancellation: 'cleanup-then-stop',
};

// ---------------------------------------------------------------------------
// Target requirements

/**
 * Capabilities a target network must provide for an operation to run.
 * 'managed-process' / 'rpc-baseline' are guaranteed by ANY Kaizen-managed
 * network; the others are future wiring (reserved-only topologies,
 * operator-authorized privileged execution).
 */
export const SCENARIO_CAPABILITIES = [
  'managed-process',
  'rpc-baseline',
  'reserved-only-topology',
  'privileged-host',
] as const;
export type ScenarioCapability = (typeof SCENARIO_CAPABILITIES)[number];

/** Guaranteed by every Kaizen-managed network (DEC-008 targets included). */
export const BASE_SCENARIO_CAPABILITIES: readonly ScenarioCapability[] = [
  'managed-process',
  'rpc-baseline',
];

export interface ScenarioTargetRequirements {
  /**
   * Always true for scenarios (DEC-008): fault/lifecycle steps only ever run
   * against designated test networks. Validation enforces it — the executor
   * re-checks at run time with fresh reads.
   */
  designatedTest: true;
  /** Optional topology expectation; when declared, step node labels must
   *  exist in that preset. */
  preset?: NetworkPreset;
  minNodes?: number;
  /** Extra capabilities the author asserts the target provides (future
   *  custom topologies, e.g. reserved-only wiring). */
  capabilities?: ScenarioCapability[];
}

// ---------------------------------------------------------------------------
// Steps

export interface ScenarioStep {
  id: string;
  /** Explicit deterministic order (0-based, equals array index). */
  order: number;
  description?: string;
  operation: ScenarioOperation;
  delayBeforeMs: number;
  delayAfterMs: number;
  /** Worst-case budget for this step (delays excluded — they are separate). */
  timeoutMs: number;
  preconditions: ScenarioCondition[];
  postconditions: ScenarioCondition[];
}

// ---------------------------------------------------------------------------
// Validation output (structured, deterministic — no timestamps inside, so
// identical input + registry ⇒ byte-identical result)

export const SCENARIO_ISSUE_CODES = [
  'INPUT_INVALID',
  'SCHEMA_VERSION_UNSUPPORTED',
  'SCENARIO_NAME_INVALID',
  'SCENARIO_DESCRIPTION_TOO_LONG',
  'TAG_INVALID',
  'TAG_DUPLICATE',
  'SECRET_CONTENT',
  'SCENARIO_NO_STEPS',
  'SCENARIO_TOO_MANY_STEPS',
  'DURATION_EXCEEDS_MAX',
  'SAFETY_DESIGNATED_TEST_REQUIRED',
  'TARGET_CAPABILITY_MISSING',
  'TARGET_NODE_NOT_IN_PRESET',
  'TARGET_NODE_UNVERIFIABLE',
  'STEP_ID_INVALID',
  'STEP_ID_DUPLICATE',
  'STEP_ORDER_MISMATCH',
  'DELAY_OUT_OF_BOUNDS',
  'TIMEOUT_OUT_OF_BOUNDS',
  'TIMEOUT_TOO_SHORT_FOR_HOLD',
  'OPERATION_UNKNOWN',
  'OPERATION_BLOCKED',
  'OPERATION_PLANNED',
  'OPERATION_CONFIG_INVALID',
  'PRECONDITION_MISSING',
  'POSTCONDITION_MISSING',
  'CONDITION_NOT_EVALUABLE',
  'CONDITION_UNSUPPORTED_FOR_OPERATION',
  'CONDITION_NODE_INVALID',
  'CONDITION_TIMEOUT_OUT_OF_BOUNDS',
  'CONDITION_UNPOSSIBLE',
  'CONDITION_CONTRADICTORY',
] as const;
export type ScenarioIssueCode = (typeof SCENARIO_ISSUE_CODES)[number];

export interface ScenarioValidationIssue {
  code: ScenarioIssueCode;
  severity: 'error' | 'warning';
  /** Human-readable explanation of what is wrong. */
  message: string;
  /** Actionable remediation (how to make it right). */
  remediation: string;
  /** Field path, e.g. 'steps[2].timeoutMs', 'requires.designatedTest'. */
  path: string;
  stepId?: string;
}

export interface ScenarioValidationResult {
  valid: boolean;
  schemaVersion: number;
  issues: ScenarioValidationIssue[];
  errorCount: number;
  warningCount: number;
  /** Deterministic worst-case: Σ(step delays + step timeouts). */
  worstCaseDurationMs: number;
  stepCount: number;
}

export type ScenarioValidationStatus = 'valid' | 'warning';

// ---------------------------------------------------------------------------
// Authoring input + persisted record

export interface ScenarioStepInput {
  id?: string;
  order?: number;
  description?: string;
  operation: { type: string; config: Record<string, unknown> };
  delayBeforeMs?: number;
  delayAfterMs?: number;
  timeoutMs?: number;
  preconditions?: ScenarioCondition[];
  postconditions?: ScenarioCondition[];
}

export interface ScenarioInput {
  name: string;
  description?: string;
  tags?: string[];
  /** Partial policy merged over DEFAULT_SCENARIO_EXECUTION_POLICY. */
  execution?: Partial<ScenarioExecutionPolicy>;
  requires?: {
    designatedTest?: boolean;
    preset?: NetworkPreset;
    minNodes?: number;
    capabilities?: ScenarioCapability[];
  };
  steps: ScenarioStepInput[];
  /** Must equal SCENARIO_SCHEMA_VERSION when provided. */
  schemaVersion?: number;
  createdBy?: string;
}

export interface ScenarioRecord {
  id: string;
  name: string;
  description: string;
  schemaVersion: number;
  tags: string[];
  requires: ScenarioTargetRequirements;
  steps: ScenarioStep[];
  execution: ScenarioExecutionPolicy;
  validation: ScenarioValidationResult;
  validationStatus: ScenarioValidationStatus;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One stored row that could not be parsed/supported by this build. */
export interface ScenarioMalformedEntry {
  id: string;
  code: 'SCENARIO_MALFORMED' | 'SCENARIO_VERSION_UNSUPPORTED';
  message: string;
}

export interface ScenarioListResult {
  scenarios: ScenarioRecord[];
  /** Rows this build cannot read (corrupt or newer schema) — surfaced
   *  honestly instead of silently dropped. */
  malformed: ScenarioMalformedEntry[];
}
