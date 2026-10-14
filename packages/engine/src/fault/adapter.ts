/**
 * FaultAdapter contract (T-3.2) — narrow, mechanism-specific adapters.
 *
 * Each adapter declares its supported fault type, required capabilities and
 * privileges, preflight checks, execution, expected observable effect,
 * verification method, timeout behavior, cleanup, and failure behavior if
 * cleanup cannot be confirmed. There is NO generic command/signal/executable
 * surface: adapters act only through the engine's own services (process
 * signals to a verified managed PID, engine stop/start) or localhost RPC.
 *
 * Mechanisms and their safe envelopes come from Phase 3A (R-22). Adapters
 * never substitute a different mechanism for a blocked one.
 */

import type { NodeProcessManager } from '../process/manager';
import type { NetworkRecord, NodeRecord } from '../types';
import type { FaultObserver } from './observer';
import type {
  FaultCheck,
  FaultEffectObservation,
  FaultObservation,
  FaultPlanStep,
  FaultPrivileges,
  FaultRecoveryObservation,
  FaultType,
} from './types';

/** Engine operations the adapters may use (the same services the API uses). */
export interface FaultNetworkOps {
  stopNode(nodeId: string): Promise<{ ok: boolean }>;
  startNode(nodeId: string): Promise<{ ok: boolean }>;
}

export interface FaultAdapterContext {
  network: NetworkRecord;
  /** Fresh node record — re-read immediately before every step. */
  node: NodeRecord;
  /** Re-read the node record (identity/status may have changed). */
  reloadNode(): NodeRecord;
  observer: FaultObserver;
  processes: NodeProcessManager;
  networks: FaultNetworkOps;
  /** Resolved hold duration for reversible faults (ms). */
  holdMs: number;
  /** Cooperative cancellation probe (checked between polling iterations). */
  isCancelled(): boolean;
}

export interface AdapterPreflight {
  supported: boolean;
  reason?: string;
  unblock?: string;
  checks: FaultCheck[];
}

/**
 * STATIC support declaration (T-3.3): whether this mechanism can execute
 * through the injector at all today. Target-eligibility still comes from
 * `preflight()` — this is the always-true-per-adapter fact consumers (e.g.
 * the scenario operation registry) read WITHOUT needing a target context.
 * Blocked entries carry the exact reason/unblock text preflight reports, so
 * there is one source of truth for "why not, and what unblocks it".
 */
export type AdapterSupport =
  | { status: 'supported' }
  | { status: 'blocked'; reason: string; unblock: string };

/** Serializable description of one registered mechanism (read-only). */
export interface FaultMechanismInfo {
  type: FaultType;
  mechanism: string;
  privileges: FaultPrivileges;
  reversible: boolean;
  expectedEffect: string;
  cleanupDescription: string;
  timeouts: AdapterTimeouts;
  support: AdapterSupport;
}

export interface AdapterTimeouts {
  applyMs: number;
  verifyEffectMs: number;
  removeMs: number;
  verifyRecoveryMs: number;
}

export interface FaultApplyResult {
  at: string;
  how: string;
}

export interface FaultRemoveResult {
  at: string;
  how: string;
}

export interface FaultAdapter {
  readonly type: FaultType;
  /** Human description of the mechanism (audited in evidence, no argv). */
  readonly mechanism: string;
  /** Static support status (blocked adapters fail before any effect). */
  readonly support: AdapterSupport;
  /** Minimum permissions required by this adapter. */
  readonly privileges: FaultPrivileges;
  /** True when the fault is rolled back by a removal action (pause). */
  readonly reversible: boolean;
  readonly expectedEffect: string;
  readonly cleanupDescription: string;
  readonly timeoutBehavior: string;
  readonly failureBehavior: string;
  readonly timeouts: AdapterTimeouts;

  /** Capability + safety-envelope checks for THIS target (no side effects). */
  preflight(ctx: FaultAdapterContext): Promise<AdapterPreflight>;
  /** Dry-run plan steps (intent descriptions with their timeouts). */
  plan(ctx: FaultAdapterContext): FaultPlanStep[];
  /** Induce the fault. Throws on failure (the injector records the error). */
  apply(ctx: FaultAdapterContext): Promise<FaultApplyResult>;
  /** Independently verify the expected effect (bounded polling). */
  verifyEffect(ctx: FaultAdapterContext): Promise<FaultEffectObservation>;
  /** Roll back / restore. Must be safe to attempt even if apply half-ran. */
  remove(ctx: FaultAdapterContext): Promise<FaultRemoveResult>;
  /** Independently verify the target recovered (bounded polling). */
  verifyRecovery(ctx: FaultAdapterContext): Promise<FaultRecoveryObservation>;
}

export const DEFAULT_ADAPTER_TIMEOUTS: AdapterTimeouts = {
  applyMs: 30_000,
  verifyEffectMs: 15_000,
  removeMs: 60_000,
  verifyRecoveryMs: 30_000,
};

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Bounded polling: calls fn until it returns a result whose `stop` predicate
 * is true, or the timeout elapses (final attempt is always returned). Never
 * waits indefinitely — flaky timing assumptions are refused by construction.
 */
export async function pollBounded<T extends { stop: boolean }>(
  fn: () => Promise<T>,
  options: { timeoutMs: number; intervalMs: number; isCancelled?: () => boolean },
): Promise<{ result: T; attempts: number }> {
  const deadline = Date.now() + options.timeoutMs;
  let attempts = 0;
  let result: T = await fn();
  attempts += 1;
  while (!result.stop && Date.now() < deadline) {
    if (options.isCancelled?.()) break;
    await sleep(options.intervalMs);
    result = await fn();
    attempts += 1;
  }
  return { result, attempts };
}

/** Observation helper: a stop-polling probe result. */
export interface ObservationProbe {
  stop: boolean;
  observation: FaultObservation;
  detail: string;
}

export function observationDetail(obs: FaultObservation): string {
  if (!obs.rpcReachable) return `rpc unreachable (${obs.rpcError ?? 'no error'})`;
  const parts = [`rpc reachable (peers=${obs.health?.peers ?? '?'})`];
  if (obs.head) parts.push(`head=#${obs.head.number}`);
  return parts.join(', ');
}

export function unreachableProbe(observation: FaultObservation): ObservationProbe {
  return {
    stop: !observation.rpcReachable,
    observation,
    detail: observationDetail(observation),
  };
}

export function reachableProbe(observation: FaultObservation): ObservationProbe {
  return {
    stop: observation.rpcReachable,
    observation,
    detail: observationDetail(observation),
  };
}
