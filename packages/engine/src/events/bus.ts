/**
 * Typed in-process event bus.
 *
 * The engine emits events for every meaningful state change; the API fans
 * them out over WebSocket, the CLI can subscribe for --watch flows (later).
 * Listener failures are isolated — a broken listener must never break
 * an operation.
 */

import type {
  NetworkStatus,
  NodeStatus,
  OperationResult,
  RpcSnapshot,
} from '../types';

export interface KaizenEventMap {
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
    at: string;
  };
  'rpc.sample': {
    networkId: string;
    nodeId: string;
    snapshot: RpcSnapshot;
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
