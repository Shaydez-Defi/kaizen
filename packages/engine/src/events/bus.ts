/**
 * Typed in-process event bus.
 *
 * The engine emits events for every meaningful state change; the API fans
 * them out over WebSocket, the CLI can subscribe for --watch flows (later).
 * Listener failures are isolated — a broken listener must never break
 * an operation.
 */

import type { FaultState, FaultType } from '../fault/types';
import type { ScenarioRunState, ScenarioStepState } from '../scenario/run-types';
import type {
  NetworkMonitorSnapshot,
  NetworkPreset,
  NetworkStatus,
  NodeHealthState,
  NodeStatus,
  OperationResult,
  RpcSnapshot,
} from '../types';

export interface KaizenEventMap {
  'network.created': {
    networkId: string;
    name: string;
    preset: NetworkPreset;
    nodeCount: number;
    at: string;
  };
  'network.status': {
    networkId: string;
    name: string;
    status: NetworkStatus;
    at: string;
  };
  'node.status': {
    networkId: string;
    nodeId: string;
    name: string;
    status: NodeStatus;
    pid?: number;
    note?: string;
    at: string;
  };
  'operation.completed': {
    operationId: number;
    kind: string;
    ok: boolean;
    durationMs: number;
    networkId?: string;
    nodeId?: string;
    at: string;
  };
  'rpc.sample': {
    networkId: string;
    nodeId: string;
    snapshot: RpcSnapshot;
  };
  /** Full monitoring snapshot, emitted once per polling tick per network. */
  'monitor.sample': {
    networkId: string;
    at: string;
    snapshot: NetworkMonitorSnapshot;
  };
  /** A node's interpreted health state changed (with evidence-based reasons). */
  'monitor.health': {
    networkId: string;
    nodeId: string;
    name: string;
    from: NodeHealthState;
    to: NodeHealthState;
    reasons: string[];
    at: string;
  };
  /** A node's peer count changed (observed via system_peers/system_health). */
  'monitor.peers': {
    networkId: string;
    nodeId: string;
    name: string;
    from: number;
    to: number;
    expected: number;
    at: string;
  };
  /** Monitoring itself failed (sampler/evaluation error — not routine RPC failure). */
  'monitor.error': {
    networkId: string;
    nodeId?: string;
    message: string;
    at: string;
  };
  /** Fault lifecycle transition (audited; every state change is emitted). */
  'fault.state': {
    faultId: string;
    networkId: string;
    nodeId: string;
    nodeName: string;
    type: FaultType;
    from: FaultState;
    to: FaultState;
    at: string;
  };
  /** High severity: a fault could not be confirmed cleaned up — the target
   *  is quarantined until reconcile() proves the effect is gone. */
  'fault.cleanup-failed': {
    faultId: string;
    networkId: string;
    nodeId: string;
    nodeName: string;
    type: FaultType;
    severity: 'high';
    message: string;
    at: string;
  };
  /** Scenario authoring audit (T-3.3). NEVER implies execution: creating,
   *  updating, or deleting a scenario never runs anything. */
  'scenario.created': {
    scenarioId: string;
    name: string;
    validationStatus: 'valid' | 'warning';
    steps: number;
    actor: string;
    at: string;
  };
  'scenario.updated': {
    scenarioId: string;
    name: string;
    validationStatus: 'valid' | 'warning';
    steps: number;
    actor: string;
    at: string;
  };
  'scenario.deleted': {
    scenarioId: string;
    name: string;
    actor: string;
    at: string;
  };
  /** A scenario run was accepted (gates passed) — execution is starting.
   *  Runs are ONLY created by ScenarioEngine.execute() with an explicit
   *  mode:'execute' request; saving/updating a scenario never emits this. */
  'scenario-run.created': {
    runId: string;
    scenarioId: string;
    scenarioName: string;
    networkId: string;
    requestedBy: string;
    /** Present only on replays: the source run being re-executed (T-3.5). */
    replayOfRunId?: string;
    steps: number;
    at: string;
  };
  /** Run lifecycle transition (every state change is audited). */
  'scenario-run.state': {
    runId: string;
    scenarioId: string;
    networkId: string;
    from: ScenarioRunState;
    to: ScenarioRunState;
    at: string;
  };
  /** Step lifecycle transition within a run. */
  'scenario-run.step': {
    runId: string;
    stepId: string;
    order: number;
    operation: string;
    from: ScenarioStepState;
    to: ScenarioStepState;
    at: string;
  };
  /** Final condition-verification outcome for one step phase. */
  'scenario-run.verification': {
    runId: string;
    stepId: string;
    phase: 'precondition' | 'postcondition';
    verdict: 'satisfied' | 'failed' | 'inconclusive' | 'not-required';
    detail: string;
    at: string;
  };
  /** Cancellation was requested for a run (cleanup-then-stop). */
  'scenario-run.cancelled': {
    runId: string;
    requestedBy: string;
    at: string;
  };
  /** High severity: a run could not confirm cleanup — the target is
   *  quarantined until reconcile() proves the effect is gone. */
  'scenario-run.cleanup-failed': {
    runId: string;
    networkId: string;
    severity: 'high';
    message: string;
    at: string;
  };
  /** Terminal run outcome (any final state, including rejected). */
  'scenario-run.finished': {
    runId: string;
    scenarioId: string;
    networkId: string;
    state: ScenarioRunState;
    stepCount: number;
    warnings: number;
    at: string;
  };
}

export type KaizenEventName = keyof KaizenEventMap;

export type KaizenEventPayload<K extends KaizenEventName> = KaizenEventMap[K];

export type KaizenEventListener<K extends KaizenEventName = KaizenEventName> = (
  name: K,
  payload: KaizenEventMap[K],
) => void;

export class EventBus {
  private listeners = new Set<KaizenEventListener>();

  subscribe(listener: KaizenEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit<K extends KaizenEventName>(name: K, payload: KaizenEventMap[K]): void {
    for (const listener of this.listeners) {
      try {
        listener(name, payload);
      } catch (e) {
        // Listener errors must not affect engine operation.
        console.error(`[events] listener failed for ${name}:`, e);
      }
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** Convenience: build the operation.completed payload from a result. */
export function operationEventFrom(result: OperationResult): KaizenEventPayload<'operation.completed'> {
  return {
    operationId: result.operationId,
    kind: result.kind,
    ok: result.ok,
    durationMs: result.durationMs,
    networkId: result.networkId,
    at: result.finishedAt,
  };
}
