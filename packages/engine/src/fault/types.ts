/**
 * FailureInjector domain types (T-3.2, Phase 3B).
 *
 * Every fault request moves through an explicit lifecycle with a persisted,
 * auditable record (SQLite `faults` table) and typed events. Evidence is a
 * structured object of OBSERVED facts (timestamps, pids, RPC observations) —
 * never assumptions, never a single collapsed "success" flag: command
 * accepted, mechanism applied, effect observed, fault removed, target
 * recovered, and recovery verified are distinct claims (see FaultRunClaims).
 */

import type { KaizenErrorJson } from '../errors';

/**
 * Fault mechanisms. Only mechanisms whose safe operating envelope is
 * supported by Phase 3A evidence (R-22) may be added here:
 *  - pause          — SIGSTOP/SIGCONT on the managed PID        (R-22 A,  VERIFIED)
 *  - terminate      — engine stopNode (+ restore via startNode) (R-22 D,  VERIFIED)
 *  - peer-disconnect— removeReservedPeer on a reservation-bound (R-22 B2, VERIFIED
 *                     connection; requires --reserved-only spawn  conditional) /
 *                     connection — blocked today, see adapter
 *  - partition      — topology rewiring (C2) or kernel-level    (R-22 C2/C4/C5
 *                     isolation (C4/C5) — blocked today, see adapter
 * Mechanisms proven INEFFECTIVE in R-22 (plain reserved-peer RPC on normal
 * connections, proxy-only cuts, static port-scoped firewall rules) are never
 * substituted for a blocked mechanism — a blocked request fails explicitly.
 */
export const FAULT_TYPES = ['pause', 'terminate', 'peer-disconnect', 'partition'] as const;
export type FaultType = (typeof FAULT_TYPES)[number];

/** Fault lifecycle states (valid transitions enforced in fault/lifecycle.ts). */
export const FAULT_STATES = [
  'requested',
  'validating',
  'rejected',
  'ready',
  'executing',
  'verifying',
  'cleaning-up',
  'completed',
  'failed',
  'cancelled',
  'cleanup-failed',
] as const;
export type FaultState = (typeof FAULT_STATES)[number];

/** How the fault is executed. Dry-run is the default for new requests. */
export type FaultMode = 'dry-run' | 'execute';

/** Privilege class an adapter requires. Privileged (sudo) faults are NOT
 *  implemented in T-3.2 (DEC-018: they need an operator-authorization model). */
export type FaultPrivileges = 'none' | 'localhost-rpc' | 'privileged-sudo';

export interface FaultOptions {
  /** Hold duration for reversible faults (pause), ms. Default 10s. */
  durationMs?: number;
}

export interface FaultRequest {
  /** Network id or name — must resolve to a designatedTest network (DEC-008). */
  networkIdOrName: string;
  /** Target node id — must belong to the resolved network. */
  nodeId: string;
  type: FaultType;
  options?: FaultOptions;
  /** Audit actor label (e.g. 'api', 'cli', 'engine', 'test'). */
  requestedBy?: string;
}

/** One preflight check result (all checks are reported, pass or fail). */
export interface FaultCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** Stable managed-process identity — never a reused PID alone. */
export interface FaultTargetIdentity {
  pid: number;
  startedAt?: string;
  /** Content of <baseDir>/kaizen-node.pid, verified to match the pid
   *  (null when no pid file exists; mismatch = ambiguous ownership). */
  pidFilePid: number | null;
}

export interface FaultPreflight {
  networkId: string;
  networkName: string;
  nodeId: string;
  nodeName: string;
  type: FaultType;
  ok: boolean;
  /** Mechanism supported for THIS target (adapter preflight). */
  supported: boolean;
  checks: FaultCheck[];
  /** Human-actionable blocking reasons (failed checks / unsupported). */
  blockingReasons: string[];
  /** Precise evidence/action needed to unblock an unsupported mechanism. */
  unblock?: string;
  target: {
    designatedTest: boolean;
    chain: string;
    networkStatus: string;
    nodeStatus: string;
    identity: FaultTargetIdentity | null;
    processAlive: boolean;
  };
  checkedAt: string;
}

/** A dry-run plan step (describes intent — no command text, no argv). */
export interface FaultPlanStep {
  phase: 'apply' | 'verify-effect' | 'hold' | 'remove' | 'verify-recovery';
  description: string;
  timeoutMs: number;
}

export interface FaultPreview {
  faultId: string;
  mode: 'dry-run';
  state: FaultState;
  networkId: string;
  nodeId: string;
  type: FaultType;
  preflight: FaultPreflight;
  plan: FaultPlanStep[];
  expectedEffect: string;
  cleanup: string;
  holdDurationMs: number;
}

/** One bounded RPC/process observation of the target (observed facts only). */
export interface FaultObservation {
  at: string;
  rpcReachable: boolean;
  rpcError?: string;
  health?: { peers: number; isSyncing: boolean };
  head?: { hash: string; number: number };
}

export interface FaultEffectObservation {
  observed: boolean;
  attempts: number;
  detail: string;
  observation: FaultObservation;
  at: string;
}

export interface FaultRecoveryObservation {
  verified: boolean;
  attempts: number;
  detail: string;
  observation: FaultObservation | null;
  /** For restart-class faults: the pid after restore (null if unchanged). */
  newPid?: number;
  at: string;
}

/** Structured evidence: observed facts captured across the fault lifecycle. */
export interface FaultEvidence {
  before: FaultObservation | null;
  applied: { at: string; how: string } | null;
  effect: FaultEffectObservation | null;
  removed: { at: string; how: string } | null;
  recovery: FaultRecoveryObservation | null;
  notes: string[];
}

/**
 * The execution result separates the distinct claims — accepted, applied,
 * observed, removed, recovered, recovery-verified — instead of one flag.
 */
export interface FaultRunClaims {
  /** Mechanism was applied (e.g. signal delivered, engine stop returned ok). */
  applied: boolean;
  /** Expected observable effect was independently verified via RPC/process. */
  effectObserved: boolean;
  /** The fault was removed (rollback action taken). */
  faultRemoved: boolean;
  /** The target is running/answering again. */
  recovered: boolean;
  /** Recovery was independently verified (not merely attempted). */
  recoveryVerified: boolean;
}

export type FaultOutcome = 'verified' | 'inconclusive' | 'failed';

export interface FaultExecutionResult {
  ok: boolean;
  outcome: FaultOutcome;
  faultId: string;
  state: FaultState;
  networkId: string;
  nodeId: string;
  type: FaultType;
  claims: FaultRunClaims;
  evidence: FaultEvidence;
  durationMs: number;
  error?: KaizenErrorJson;
}

export interface FaultRecord {
  id: string;
  networkId: string;
  nodeId: string;
  nodeName: string;
  type: FaultType;
  mode: FaultMode;
  state: FaultState;
  requestedBy: string;
  requestedAt: string;
  updatedAt: string;
  finishedAt?: string;
  holdDurationMs?: number;
  preflight?: FaultPreflight;
  plan?: FaultPlanStep[];
  evidence?: FaultEvidence;
  result?: FaultExecutionResult;
  error?: KaizenErrorJson;
  /** cleanup-failed fault whose effect was later confirmed gone (reconcile). */
  reconciled?: boolean;
}
