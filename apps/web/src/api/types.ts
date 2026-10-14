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
  ScenarioInput,
  ScenarioMalformedEntry,
  ScenarioRecord,
  ScenarioValidationResult,
  SerializedOperationDefinition,
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
  ScenarioInput,
  ScenarioMalformedEntry,
  ScenarioRecord,
  ScenarioValidationResult,
  SerializedOperationDefinition,
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

// ---------------------------------------------------------------------------
// Scenarios (T-3.3 authoring surface). Client contract only — the Failure
// Lab UI is a later phase (T-3.6); these methods exist so CLI/UI work can
// consume the same typed model.

export interface ScenarioListResponse {
  ok: boolean;
  scenarios: ScenarioRecord[];
  malformed: ScenarioMalformedEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface ScenarioResponse {
  ok: boolean;
  scenario: ScenarioRecord;
}

/** POST /api/scenarios/validate answers 200 with validity + structured result. */
export interface ScenarioValidateResponse {
  ok: boolean;
  result: ScenarioValidationResult;
}

export interface ScenarioOperationsResponse {
  ok: boolean;
  operations: SerializedOperationDefinition[];
}

export interface ScenarioDeleteResponse {
  ok: boolean;
  removed: string;
}
