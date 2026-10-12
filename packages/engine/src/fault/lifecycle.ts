/**
 * Fault lifecycle state machine (T-3.2).
 *
 * A valid, auditable lifecycle — illegal transitions are refused everywhere
 * (the injector asserts through assertTransition on every state change).
 *
 *   requested → validating → rejected
 *                         ↘ ready → executing → verifying ↘
 *                                                  cleaning-up → completed
 *                                       (error/cancel) ↗       → failed
 *                                                        → cancelled
 *                                                        → cleanup-failed
 */

import { KaizenError } from '../errors';
import type { FaultState } from './types';

const TRANSITIONS: Record<FaultState, readonly FaultState[]> = {
  requested: ['validating'],
  validating: ['rejected', 'ready'],
  ready: ['executing', 'cancelled'],
  executing: ['verifying', 'cleaning-up'],
  verifying: ['cleaning-up'],
  // Cleanup always runs last; its outcome is the terminal state. A
  // cleanup-failed record keeps the target quarantined until reconciled.
  'cleaning-up': ['completed', 'failed', 'cancelled', 'cleanup-failed'],
  rejected: [],
  completed: [],
  failed: [],
  cancelled: [],
  'cleanup-failed': [],
};

export const TERMINAL_FAULT_STATES: readonly FaultState[] = [
  'rejected',
  'completed',
  'failed',
  'cancelled',
  'cleanup-failed',
];

export function isTerminalFaultState(state: FaultState): boolean {
  return TERMINAL_FAULT_STATES.includes(state);
}

export function canTransition(from: FaultState, to: FaultState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throw on an illegal transition — an invariant violation, never swallowed. */
export function assertTransition(from: FaultState, to: FaultState): void {
  if (!canTransition(from, to)) {
    throw new KaizenError(
      'INTERNAL',
      `Illegal fault lifecycle transition ${from} → ${to}`,
      { from, to },
    );
  }
}
