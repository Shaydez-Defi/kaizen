/**
 * Core typed models for the Kaizen engine.
 *
 * These types are the contract between engine services, the API, and the CLI.
 * They describe real infrastructure only — there is no placeholder data here.
 */

export type NodeRole = 'validator' | 'full';

export type NodeStatus =
  | 'created'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'crashed'
  | 'stale';

export type NetworkStatus =
  | 'created'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'stopping'
  | 'stopped'
  | 'error';

export type NetworkPreset =
  | 'single-node'
  | 'two-node'
  | 'four-validator'
  | 'validator-fullnode'
  | 'custom';

/** Port set assigned to one node process. */
export interface NodePorts {
  /** libp2p TCP port (--port) */
  p2p: number;
  /** HTTP JSON-RPC (--rpc-port) */
  rpc: number;
  /** WebSocket JSON-RPC (--ws-port) */
  ws: number;
  /** Prometheus metrics (--prometheus-port) */
  prometheus: number;
}

/** Persisted configuration of one node in a network. */
export interface NodeConfig {
  id: string;
  networkId: string;
  /** Human-facing node name (our record; distinct from on-chain identity). */
  name: string;
  role: NodeRole;
  /**
   * 'dev'       → `--dev` ephemeral development chain (single node)
   * 'local-spec'→ generated raw chain spec file shared by the network
   */
  chain: 'dev' | 'local-spec';
  chainSpecPath?: string;
  /** Substrate well-known development key (--alice … --ferdie). */
  wellKnownKey?: WellKnownKey;
  /** Bootnode multiaddrs used at start (--bootnodes). */
  bootnodes: string[];
  baseDir: string;
  nodeKeyFile: string;
  logFile: string;
  ports: NodePorts;
  /**
   * Peer count this node is expected to reach once the whole network is up
   * (full mesh: nodeCount − 1). Used by monitoring to detect peer shortfall;
   * a running process alone is not health evidence.
   */
  expectedPeers?: number;
}

// ---------------------------------------------------------------------------
// Custom topology input (validated at the system boundary before anything runs)

export interface CustomTopologyNodeInput {
  /** Node name suffix (unique within the network), e.g. "alice", "full-1". */
  name: string;
  role: NodeRole;
  /** Required for validators (alice…ferdie); must be absent for full nodes. */
  wellKnownKey?: string;
}

export interface CustomTopologyInput {
  nodes: CustomTopologyNodeInput[];
}

export type WellKnownKey =
  | 'alice'
  | 'bob'
  | 'charlie'
  | 'dave'
  | 'eve'
  | 'ferdie'
  | 'one'
  | 'two';

export interface NetworkRecord {
  id: string;
  name: string;
  preset: NetworkPreset;
  status: NetworkStatus;
  /**
   * Destructive/failure operations are only permitted against networks
   * flagged designatedTest (DEC-008). Local/development chains only.
   */
  designatedTest: boolean;
  chain: 'dev' | 'local-spec';
  chainSpecPath?: string;
  baseDir: string;
  createdAt: string;
  updatedAt: string;
}

export interface NodeRecord extends NodeConfig {
  status: NodeStatus;
  pid?: number;
  /** When the current process instance was started (for uptime). */
  startedAt?: string;
}

/** Result of a mutating engine operation. Never thrown across the API — returned. */
export interface OperationResult {
  ok: boolean;
  operationId: number;
  kind: string;
  networkId?: string;
  nodeId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// RPC snapshots (real data read from a live node)

export interface RpcHealth {
  isSyncing: boolean;
  peers: number;
  shouldHavePeers: boolean;
}

export interface RpcPeerInfo {
  peerId: string;
  bestHash: string;
  bestNumber: number;
  roles: string;
}

export interface RpcSnapshot {
  at: string;
  chain: string;
  nodeName: string;
  nodeVersion: string;
  localPeerId: string | null;
  health: RpcHealth;
  peers: RpcPeerInfo[] | null;
  sync: { startingBlock: number; currentBlock: number; highestBlock: number | null };
  head: { number: number; hash: string; parentHash: string };
  /** Last finalized block (GRANDPA); null if the read failed. */
  finalized: { number: number; hash: string } | null;
  runtime: {
    specName: string;
    specVersion: number;
    implName: string;
    transactionVersion: number;
  };
  /** Per-method read problems (e.g. unsafe RPC disabled). Never fabricated. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Process state as reported by the NodeProcessManager

export interface NodeRuntimeStatus {
  nodeId: string;
  state: NodeStatus;
  pid?: number;
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  /** Last startup failure reason, if any. */
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Inspection aggregates

export interface NodeInspection {
  nodeId: string;
  name: string;
  process: NodeRuntimeStatus;
  rpcUrl: string;
  /** Real RPC snapshot, or null when the node is not RPC-reachable. */
  snapshot: RpcSnapshot | null;
  rpcError?: string;
}

export interface NetworkInspection {
  networkId: string;
  name: string;
  status: NetworkStatus;
  nodes: NodeInspection[];
  inspectedAt: string;
}

// ---------------------------------------------------------------------------
// Monitoring (T-2.4) — real RPC-derived observations only. States distinguish
// unhealthy / unknown / unavailable / stale: a running process alone never
// proves health.

export type NodeHealthState =
  /** No sample has been collected yet. */
  | 'unknown'
  /** Process running, RPC fresh, chain progressing, peers within expectation. */
  | 'healthy'
  /**
   * Process dead/crashed, OR chain stalled (RPC answers but head stopped
   * advancing past the stall threshold), OR peer shortfall beyond grace.
   */
  | 'unhealthy'
  /** Process claims to run but RPC has failed repeatedly. */
  | 'unavailable'
  /** Monitoring data is too old to judge health (sampling degraded). */
  | 'stale';

/** One real observation of a node, gathered over HTTP JSON-RPC. */
export interface NodeMonitorSample {
  networkId: string;
  nodeId: string;
  name: string;
  at: string;
  process: { status: NodeStatus; pid?: number; startedAt?: string };
  /** HTTP JSON-RPC reachability for THIS sample. */
  rpc: { reachable: boolean; error?: string };
  /** system_health (null when unreachable). */
  health: { isSyncing: boolean; peers: number; shouldHavePeers: boolean } | null;
  /** Peer details + expected count (null when unreachable). */
  peers: { count: number; expected: number; list: RpcPeerInfo[] } | null;
  /** chain_getHeader of the current best block. */
  head: { number: number; hash: string } | null;
  /** chain_getFinalizedHead + header (best effort). */
  finalized: { number: number; hash: string } | null;
  /** Cached genesis hash (chain identity check). */
  genesisHash: string | null;
  sync: { startingBlock: number; currentBlock: number; highestBlock: number | null } | null;
  uptimeMs: number | null;
  /** Per-method read problems from this sample (never fabricated data). */
  warnings: string[];
}

/** Interpreted health of one node. */
export interface NodeHealthReport {
  nodeId: string;
  state: NodeHealthState;
  /** Human-readable, evidence-based explanations of the state. */
  reasons: string[];
  /** When the current state was entered. */
  since: string;
  lastSampleAt: string | null;
  lastHealthyAt: string | null;
  /** Consecutive failed RPC checks (0 when the last one succeeded). */
  rpcFailures: number;
}

export interface NetworkMonitorSnapshot {
  networkId: string;
  name: string;
  at: string;
  intervalMs: number;
  samples: NodeMonitorSample[];
  health: NodeHealthReport[];
}
