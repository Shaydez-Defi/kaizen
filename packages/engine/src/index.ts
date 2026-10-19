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

export { PortaldotRpcClient, readSnapshot, readProbeState } from './rpc/client';
export type { RpcClientOptions, SubstrateProbeRead } from './rpc/client';

// V3 connectivity probe (T-8.1, Phase 8) — configuration-driven, read-only
// checks of the official Portaldot V3 endpoints (DEC-023). No route/UI
// surface exists: this is an engine service with injectable transports.
export { V3ConnectivityProbe, probeV3Connectivity } from './v3/probe';
export type { V3ProbeOptions } from './v3/probe';
export {
  V3_ENDPOINT_DEFAULTS,
  V3_ENV_KEYS,
  resolveV3Config,
  redactEndpointUrl,
} from './v3/config';
export type { V3EndpointConfig } from './v3/config';
export {
  RealSubstrateTransport,
  FetchJsonRpcTransport,
  FetchHttpAvailabilityTransport,
} from './v3/transports';
export type {
  V3ProbeTransports,
  V3SubstrateTransport,
  V3SubstrateTransportInput,
  V3HttpJsonRpcTransport,
  V3JsonRpcTransportInput,
  V3HttpAvailabilityTransport,
  V3HttpAvailabilityTransportInput,
  V3HttpAvailabilityResult,
} from './v3/transports';
export type {
  V3ConnectivityReport,
  V3EndpointProbeResult,
  V3EndpointRole,
  V3EvmObservations,
  V3ExplorerObservations,
  V3ProbeFailure,
  V3ProbeStatus,
  V3SubstrateObservations,
} from './v3/types';

export { NetworkService } from './network/service';
export type { CreateNetworkInput, NetworkServiceOptions } from './network/service';

export {
  resolveTopology,
  needsAuthorityPatch,
  NETWORK_PRESETS,
  AUTHORITY_KEYS,
  GENESIS_AUTHORITIES,
  NAME_PATTERN,
  MAX_CUSTOM_NODES,
  MAX_VALIDATORS,
} from './network/topologies';
export type { TopologyPlan, TopologyNodeTemplate } from './network/topologies';

export {
  ChainSpecService,
  patchPlainSpec,
  parsePlainAuthorities,
  parseSs58,
  keyUri,
} from './network/chainspec';
export type {
  AuthorityKeyMaterial,
  ChainSpecResult,
  ChainSpecServiceOptions,
} from './network/chainspec';

export { MonitoringService } from './monitor/service';
export type { MonitoringServiceOptions } from './monitor/service';

export { FailureInjector } from './fault/injector';
export type { FailureInjectorOptions } from './fault/injector';
export type {
  FaultAdapter,
  FaultAdapterContext,
  FaultNetworkOps,
  AdapterPreflight,
  AdapterSupport,
  AdapterTimeouts,
  FaultMechanismInfo,
  FaultApplyResult,
  FaultRemoveResult,
} from './fault/adapter';
export { FAULT_TYPES, FAULT_STATES } from './fault/types';
export type {
  FaultType,
  FaultState,
  FaultMode,
  FaultRequest,
  FaultOptions,
  FaultCheck,
  FaultPreflight,
  FaultPlanStep,
  FaultPreview,
  FaultObservation,
  FaultEffectObservation,
  FaultRecoveryObservation,
  FaultEvidence,
  FaultRunClaims,
  FaultOutcome,
  FaultExecutionResult,
  FaultRecord,
  FaultTargetIdentity,
} from './fault/types';
export { canTransition, isTerminalFaultState, TERMINAL_FAULT_STATES } from './fault/lifecycle';
export { createRpcObserver } from './fault/observer';
export type { FaultObserver, RpcObserverOptions } from './fault/observer';
export { redactSecrets as redactFaultSecrets, redactDeep as redactFaultDeep } from './fault/redact';

export { createHttpSampler } from './monitor/sampler';
export type { NodeSampler, RpcNodeObservation, HttpSamplerOptions } from './monitor/sampler';

// Scenarios (T-3.3) — authoring model, safe operation registry, validation,
// and the CRUD service. Nothing here executes anything.
export { ScenarioService } from './scenario/service';
export type {
  ScenarioServiceOptions,
  ScenarioListFilter,
  ScenarioPage,
} from './scenario/service';
export {
  buildOperationRegistry,
  serializeOperationDefinition,
  SCENARIO_CONDITION_DEFINITIONS,
  EVALUABLE_CONDITION_KINDS,
  pauseConfigSchema,
  nodeTargetConfigSchema,
} from './scenario/operations';
export type {
  OperationDefinition,
  OperationSupportStatus,
  ScenarioOperationRegistry,
  SerializedOperationDefinition,
  ConditionDefinition,
} from './scenario/operations';
export { validateScenarioInput, prepareScenario, scenarioInputSchema, scenarioRecordToInput } from './scenario/validate';
export * from './scenario/types';
export {
  ScenarioEngine,
  scenarioRunRequestSchema,
  scenarioReplayRequestSchema,
} from './scenario/runner';
export type {
  ActiveScenarioRun,
  ScenarioEngineOptions,
  ScenarioReplayRequest,
  ScenarioRunListFilter,
  ScenarioRunPage,
  ScenarioRunRequest,
} from './scenario/runner';
export {
  REPLAYABLE_SCENARIO_RUN_STATES,
  SCENARIO_RUN_ERROR_CODES,
  SCENARIO_RUN_STATES,
  SCENARIO_RUN_TRANSITIONS,
  SCENARIO_STEP_STATES,
  SCENARIO_STEP_TRANSITIONS,
  TERMINAL_SCENARIO_RUN_STATES,
  TERMINAL_SCENARIO_STEP_STATES,
  canTransitionRun,
  canTransitionStep,
  isReplayableScenarioRunState,
  isTerminalScenarioRunState,
  isTerminalScenarioStepState,
  scenarioRunReplayNote,
  toRunSummary,
} from './scenario/run-types';
export type {
  InterruptedFaultOutcome,
  InterruptedRunOutcome,
  ScenarioConditionEval,
  ScenarioConditionVerdict,
  ScenarioRunCancellation,
  ScenarioRunCleanup,
  ScenarioRunCleanupAction,
  ScenarioRunError,
  ScenarioRunErrorCode,
  ScenarioRunListResult,
  ScenarioRunMalformedEntry,
  ScenarioRunRecord,
  ScenarioRunReconcileReport,
  ScenarioRunState,
  ScenarioRunSummary,
  ScenarioRunTargetNode,
  ScenarioStepRun,
  ScenarioStepState,
  ScenarioStepVerification,
} from './scenario/run-types';

export { evaluateNodeHealth, DEFAULT_HEALTH_OPTIONS } from './monitor/health';
export type { HealthEvalInput, HealthEvalOutput, HealthEvalOptions } from './monitor/health';

export type {
  NodeRole,
  NodeStatus,
  NetworkStatus,
  NetworkPreset,
  NodePorts,
  NodeConfig,
  CustomTopologyInput,
  CustomTopologyNodeInput,
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
  NodeHealthState,
  NodeHealthReport,
  NodeMonitorSample,
  NetworkMonitorSnapshot,
} from './types';
