/**
 * Typed API contract for the Kaizen web UI.
 *
 * Response shapes mirror what `apps/api/src/server.ts` actually returns.
 * Engine types are imported (type-only — zero runtime cost) so the UI can
 * never drift from the shared engine's models.
 */

import type {
  KaizenEventMap,
  KaizenEventName,
  NetworkMonitorSnapshot,
  NetworkPreset,
  NetworkRecord,
  NetworkStatus,
  NodeHealthReport,
  NodeHealthState,
  NodeMonitorSample,
  NodeRecord,
  NodeRole,
  NodeStatus,
  OperationResult,
  CustomTopologyNodeInput,
} from '@kaizen/engine';

export type {
  KaizenEventMap,
  KaizenEventName,
  NetworkMonitorSnapshot,
  NetworkPreset,
  NetworkRecord,
  NetworkStatus,
  NodeHealthReport,
  NodeHealthState,
  NodeMonitorSample,
  NodeRecord,
  NodeRole,
  NodeStatus,
  OperationResult,
};

/** Envelope for structured API errors ({ ok: false, error }). */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  dataDir: string;
}

export interface BinaryStatusResponse {
  ok: boolean;
  status: {
    available: boolean;
    version?: string;
    sha256?: string;
    path?: string;
    error?: string;
  };
}

/** `GET /api/networks` items: full record + node count. */
export type NetworkWithCount = NetworkRecord & { nodeCount: number };

export interface NetworkListResponse {
  ok: boolean;
  networks: NetworkWithCount[];
}

export interface NetworkDetailResponse {
  ok: boolean;
  network: NetworkRecord;
  nodes: NodeRecord[];
}

/** Lifecycle routes answer 200 with a possibly-failed OperationResult. */
export interface OperationResponse {
  ok: boolean;
  result: OperationResult;
}

export interface MonitorResponse {
  ok: boolean;
  snapshot: NetworkMonitorSnapshot;
}

export interface NodeDetailResponse {
  ok: boolean;
  node: NodeRecord;
  sample: NodeMonitorSample | null;
  health: NodeHealthReport | null;
}

export interface NodeLogsResponse {
  ok: boolean;
  nodeId: string;
  lines: string[];
}

/** Input accepted by POST /api/networks (mirrors the server's Zod schema). */
export interface CreateNetworkInput {
  name: string;
  preset: NetworkPreset;
  custom?: { nodes: CustomTopologyNodeInput[] };
}
