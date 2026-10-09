/**
 * @kaizen/engine — the shared operations engine.
 *
 * Every operational capability of Kaizen (binary management, node process
 * orchestration, Portaldot RPC, network lifecycle) lives here and is consumed
 * by BOTH the CLI (in-process) and the API (REST/WS transport). See
 * docs/ARCHITECTURE.md and DEC-002.
 */

export { createEngine, resolveDataDir, KAIZEN_VERSION } from './engine';
export type { EngineOptions, KaizenEngine } from './engine';

export { KaizenError, isKaizenError, toErrorJson } from './errors';
export type { KaizenErrorCode, KaizenErrorJson } from './errors';

export { EventBus, operationEventFrom } from './events/bus';
export type { KaizenEventMap, KaizenEventName, KaizenEventListener } from './events/bus';

export { StateStore } from './state/store';
export type { OperationRow } from './state/store';

export { BinaryManager } from './binary/manager';
export type { BinaryManifestEntry, BinaryStatus, BinaryManagerOptions } from './binary/manager';

export { NodeProcessManager, isPidAlive, pidFileFor, readLogTail } from './process/manager';
export type { ManagedNodeSpec, NodeProcessManagerOptions } from './process/manager';

export { PortAllocator, isPortFree } from './process/ports';
export type { PortAllocatorOptions, PortRange } from './process/ports';

export {
  buildNodeArgs,
  assertSafeArgs,
  wsUrlForPort,
  httpUrlForPort,
  FORBIDDEN_FLAGS,
} from './process/args';
export type { NodeLaunchSpec } from './process/args';

export { PortaldotRpcClient, readSnapshot } from './rpc/client';
export type { RpcClientOptions } from './rpc/client';

export { NetworkService } from './network/service';
export type { CreateNetworkInput, NetworkServiceOptions } from './network/service';

export type {
  NodeRole,
  NodeStatus,
  NetworkStatus,
  NetworkPreset,
  NodePorts,
  NodeConfig,
  WellKnownKey,
  NetworkRecord,
  NodeRecord,
  OperationResult,
  RpcHealth,
  RpcPeerInfo,
  RpcSnapshot,
  NodeRuntimeStatus,
  NodeInspection,
  NetworkInspection,
} from './types';
