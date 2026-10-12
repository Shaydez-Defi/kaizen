/**
 * SQLite-backed state store (DEC-005).
 *
 * Uses Node's built-in `node:sqlite` (stable in Node 24) — zero native
 * dependencies. Stores networks, node configs, and operation history.
 * NEVER stores secrets: node key material lives in files under the network
 * base dir, referenced by path only.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { FaultEvidence, FaultExecutionResult, FaultPlanStep, FaultPreflight, FaultRecord, FaultState } from '../fault/types';
import type {
  KaizenErrorJson,
} from '../errors';
import type {
  NetworkPreset,
  NetworkRecord,
  NetworkStatus,
  NodeConfig,
  NodeRecord,
  NodeStatus,
  NodePorts,
} from '../types';

const MIGRATIONS: string[] = [
  // 1: networks
  `CREATE TABLE IF NOT EXISTS networks (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     preset TEXT NOT NULL,
     status TEXT NOT NULL,
     designated_test INTEGER NOT NULL DEFAULT 1,
     chain TEXT NOT NULL,
     chain_spec_path TEXT,
     base_dir TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  // 2: nodes
  `CREATE TABLE IF NOT EXISTS nodes (
     id TEXT PRIMARY KEY,
     network_id TEXT NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     role TEXT NOT NULL,
     chain TEXT NOT NULL,
     chain_spec_path TEXT,
     well_known_key TEXT,
     bootnodes TEXT NOT NULL DEFAULT '[]',
     base_dir TEXT NOT NULL,
     node_key_file TEXT NOT NULL,
     log_file TEXT NOT NULL,
     p2p_port INTEGER NOT NULL,
     rpc_port INTEGER NOT NULL,
     ws_port INTEGER NOT NULL,
     prom_port INTEGER NOT NULL,
     status TEXT NOT NULL,
     pid INTEGER,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  // 3: operations
  `CREATE TABLE IF NOT EXISTS operations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     network_id TEXT,
     node_id TEXT,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     status TEXT NOT NULL,
     error_code TEXT,
     error_message TEXT,
     detail TEXT
   );`,
  // 4: node uptime + peer expectations (monitoring, T-2.4)
  `ALTER TABLE nodes ADD COLUMN started_at TEXT;`,
  `ALTER TABLE nodes ADD COLUMN expected_peers INTEGER NOT NULL DEFAULT 0;`,
  // 6-8: fault records (FailureInjector audit trail, T-3.2) — deliberately no
  // FK to networks: the audit must survive network removal (like operations).
  `CREATE TABLE IF NOT EXISTS faults (
     id TEXT PRIMARY KEY,
     network_id TEXT NOT NULL,
     node_id TEXT NOT NULL,
     node_name TEXT NOT NULL DEFAULT '',
     type TEXT NOT NULL,
     mode TEXT NOT NULL,
     state TEXT NOT NULL,
     requested_by TEXT NOT NULL,
     hold_duration_ms INTEGER,
     requested_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     finished_at TEXT,
     preflight TEXT,
     plan TEXT,
     evidence TEXT,
     result TEXT,
     error TEXT,
     reconciled INTEGER NOT NULL DEFAULT 0
   );`,
  `CREATE INDEX IF NOT EXISTS faults_network_idx ON faults(network_id);`,
  `CREATE INDEX IF NOT EXISTS faults_node_idx ON faults(node_id);`,
];

interface NetworkRow {
  id: string;
  name: string;
  preset: string;
  status: string;
  designated_test: number;
  chain: string;
  chain_spec_path: string | null;
  base_dir: string;
  created_at: string;
  updated_at: string;
}

interface NodeRow {
  id: string;
  network_id: string;
  name: string;
  role: string;
  chain: string;
  chain_spec_path: string | null;
  well_known_key: string | null;
  bootnodes: string;
  base_dir: string;
  node_key_file: string;
  log_file: string;
  p2p_port: number;
  rpc_port: number;
  ws_port: number;
  prom_port: number;
  status: string;
  pid: number | null;
  started_at: string | null;
  expected_peers: number;
}

export interface OperationRow {
  id: number;
  kind: string;
  network_id: string | null;
  node_id: string | null;
  started_at: string;
  finished_at: string | null;
  status: string;
  error_code: string | null;
  error_message: string | null;
  detail: string | null;
}

interface FaultRow {
  id: string;
  network_id: string;
  node_id: string;
  node_name: string;
  type: string;
  mode: string;
  state: string;
  requested_by: string;
  hold_duration_ms: number | null;
  requested_at: string;
  updated_at: string;
  finished_at: string | null;
  preflight: string | null;
  plan: string | null;
  evidence: string | null;
  result: string | null;
  error: string | null;
  reconciled: number;
}

export interface InsertNetworkInput {
  id: string;
  name: string;
  preset: NetworkPreset;
  status: NetworkStatus;
  designatedTest: boolean;
  chain: 'dev' | 'local-spec';
  chainSpecPath?: string;
  baseDir: string;
  createdAt: string;
}

export interface InsertNodeInput {
  config: NodeConfig;
  status: NodeStatus;
  createdAt: string;
}

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  /** Apply pending migrations. Idempotent — safe to call repeatedly. */
  private migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);',
    );
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM schema_version')
      .get() as { v: number | null };
    const current = row.v ?? 0;
    for (let v = current; v < MIGRATIONS.length; v++) {
      const sql = MIGRATIONS[v];
      if (!sql) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v + 1);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  get schemaVersion(): number {
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM schema_version')
      .get() as { v: number | null };
    return row.v ?? 0;
  }

  // -------------------------------------------------------------------------
  // Networks

  insertNetwork(input: InsertNetworkInput): NetworkRecord {
    this.db
      .prepare(
        `INSERT INTO networks
         (id, name, preset, status, designated_test, chain, chain_spec_path, base_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.preset,
        input.status,
        input.designatedTest ? 1 : 0,
        input.chain,
        input.chainSpecPath ?? null,
        input.baseDir,
        input.createdAt,
        input.createdAt,
      );
    return this.getNetwork(input.id);
  }

  getNetwork(id: string): NetworkRecord {
    const row = this.db.prepare('SELECT * FROM networks WHERE id = ?').get(id) as
      | NetworkRow
      | undefined;
    if (!row) throw new Error(`network not found: ${id}`);
    return mapNetwork(row);
  }

  tryGetNetwork(idOrName: string): NetworkRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM networks WHERE id = ? OR name = ?')
      .get(idOrName, idOrName) as NetworkRow | undefined;
    return row ? mapNetwork(row) : undefined;
  }

  listNetworks(): NetworkRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM networks ORDER BY created_at')
      .all() as unknown as NetworkRow[];
    return rows.map(mapNetwork);
  }

  updateNetworkStatus(id: string, status: NetworkStatus): void {
    this.db
      .prepare('UPDATE networks SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
  }

  // -------------------------------------------------------------------------
  // Nodes

  insertNode(input: InsertNodeInput): NodeRecord {
    const c = input.config;
    this.db
      .prepare(
        `INSERT INTO nodes
         (id, network_id, name, role, chain, chain_spec_path, well_known_key, bootnodes,
          base_dir, node_key_file, log_file, p2p_port, rpc_port, ws_port, prom_port,
          status, pid, started_at, expected_peers, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        c.id,
        c.networkId,
        c.name,
        c.role,
        c.chain,
        c.chainSpecPath ?? null,
        c.wellKnownKey ?? null,
        JSON.stringify(c.bootnodes),
        c.baseDir,
        c.nodeKeyFile,
        c.logFile,
        c.ports.p2p,
        c.ports.rpc,
        c.ports.ws,
        c.ports.prometheus,
        input.status,
        c.expectedPeers ?? 0,
        input.createdAt,
        input.createdAt,
      );
    return this.getNode(c.id);
  }

  getNode(id: string): NodeRecord {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as
      | NodeRow
      | undefined;
    if (!row) throw new Error(`node not found: ${id}`);
    return mapNode(row);
  }

  tryGetNode(id: string): NodeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as
      | NodeRow
      | undefined;
    return row ? mapNode(row) : undefined;
  }

  listNodes(networkId: string): NodeRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM nodes WHERE network_id = ? ORDER BY id')
      .all(networkId) as unknown as NodeRow[];
    return rows.map(mapNode);
  }

  updateNodeStatus(
    id: string,
    status: NodeStatus,
    pid?: number | null,
    startedAt?: string | null,
  ): void {
    this.db
      .prepare(
        'UPDATE nodes SET status = ?, pid = ?, started_at = COALESCE(?, started_at), updated_at = ? WHERE id = ?',
      )
      .run(status, pid ?? null, startedAt ?? null, new Date().toISOString(), id);
  }

  deleteNodes(networkId: string): void {
    this.db.prepare('DELETE FROM nodes WHERE network_id = ?').run(networkId);
  }

  // -------------------------------------------------------------------------
  // Operations

  startOperation(kind: string, networkId?: string, nodeId?: string): number {
    const res = this.db
      .prepare(
        `INSERT INTO operations (kind, network_id, node_id, started_at, status)
         VALUES (?, ?, ?, ?, 'running')`,
      )
      .run(kind, networkId ?? null, nodeId ?? null, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  /** Link an operation row to a network once its id exists (create flow). */
  attachOperationToNetwork(opId: number, networkId: string): void {
    this.db
      .prepare('UPDATE operations SET network_id = ? WHERE id = ?')
      .run(networkId, opId);
  }

  finishOperation(
    id: number,
    outcome: {
      status: 'ok' | 'error';
      errorCode?: string;
      errorMessage?: string;
      detail?: Record<string, unknown>;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE operations
         SET finished_at = ?, status = ?, error_code = ?, error_message = ?, detail = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        outcome.status,
        outcome.errorCode ?? null,
        outcome.errorMessage ?? null,
        outcome.detail ? JSON.stringify(outcome.detail) : null,
        id,
      );
  }

  getOperation(id: number): OperationRow | undefined {
    return this.db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as
      | OperationRow
      | undefined;
  }

  listOperations(filter: { networkId?: string; limit?: number } = {}): OperationRow[] {
    const limit = filter.limit ?? 100;
    if (filter.networkId) {
      return this.db
        .prepare(
          'SELECT * FROM operations WHERE network_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(filter.networkId, limit) as unknown as OperationRow[];
    }
    return this.db
      .prepare('SELECT * FROM operations ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as OperationRow[];
  }

  deleteNetwork(id: string): void {
    this.db.prepare('DELETE FROM networks WHERE id = ?').run(id);
  }

  // -------------------------------------------------------------------------
  // Faults (FailureInjector audit trail, T-3.2)

  insertFault(record: FaultRecord): void {
    this.db
      .prepare(
        `INSERT INTO faults
         (id, network_id, node_id, node_name, type, mode, state, requested_by, hold_duration_ms,
          requested_at, updated_at, finished_at, preflight, plan, evidence, result, error, reconciled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.networkId,
        record.nodeId,
        record.nodeName,
        record.type,
        record.mode,
        record.state,
        record.requestedBy,
        record.holdDurationMs ?? null,
        record.requestedAt,
        record.updatedAt,
        record.finishedAt ?? null,
        record.preflight ? JSON.stringify(record.preflight) : null,
        record.plan ? JSON.stringify(record.plan) : null,
        record.evidence ? JSON.stringify(record.evidence) : null,
        record.result ? JSON.stringify(record.result) : null,
        record.error ? JSON.stringify(record.error) : null,
        record.reconciled ? 1 : 0,
      );
  }

  updateFault(id: string, patch: {
    state?: FaultState;
    holdDurationMs?: number;
    finishedAt?: string;
    updatedAt: string;
    preflight?: FaultPreflight;
    plan?: FaultPlanStep[];
    evidence?: FaultEvidence;
    result?: FaultExecutionResult;
    error?: KaizenErrorJson;
    reconciled?: boolean;
  }): void {
    this.db
      .prepare(
        `UPDATE faults SET
           state = COALESCE(?, state),
           hold_duration_ms = COALESCE(?, hold_duration_ms),
           finished_at = COALESCE(?, finished_at),
           preflight = COALESCE(?, preflight),
           plan = COALESCE(?, plan),
           evidence = COALESCE(?, evidence),
           result = COALESCE(?, result),
           error = COALESCE(?, error),
           reconciled = COALESCE(?, reconciled),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.state ?? null,
        patch.holdDurationMs ?? null,
        patch.finishedAt ?? null,
        patch.preflight ? JSON.stringify(patch.preflight) : null,
        patch.plan ? JSON.stringify(patch.plan) : null,
        patch.evidence ? JSON.stringify(patch.evidence) : null,
        patch.result ? JSON.stringify(patch.result) : null,
        patch.error ? JSON.stringify(patch.error) : null,
        patch.reconciled === undefined ? null : patch.reconciled ? 1 : 0,
        patch.updatedAt,
        id,
      );
  }

  getFault(id: string): FaultRecord {
    const row = this.db.prepare('SELECT * FROM faults WHERE id = ?').get(id) as
      | FaultRow
      | undefined;
    if (!row) throw new Error(`fault not found: ${id}`);
    return mapFault(row);
  }

  tryGetFault(id: string): FaultRecord | undefined {
    const row = this.db.prepare('SELECT * FROM faults WHERE id = ?').get(id) as
      | FaultRow
      | undefined;
    return row ? mapFault(row) : undefined;
  }

  listFaults(filter: { networkId?: string; nodeId?: string; limit?: number } = {}): FaultRecord[] {
    const limit = filter.limit ?? 100;
    if (filter.networkId && filter.nodeId) {
      return (
        this.db
          .prepare(
            'SELECT * FROM faults WHERE network_id = ? AND node_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?',
          )
          .all(filter.networkId, filter.nodeId, limit) as unknown as FaultRow[]
      ).map(mapFault);
    }
    if (filter.networkId) {
      return (
        this.db
          .prepare('SELECT * FROM faults WHERE network_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?')
          .all(filter.networkId, limit) as unknown as FaultRow[]
      ).map(mapFault);
    }
    if (filter.nodeId) {
      return (
        this.db
          .prepare('SELECT * FROM faults WHERE node_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?')
          .all(filter.nodeId, limit) as unknown as FaultRow[]
      ).map(mapFault);
    }
    return (
      this.db
        .prepare('SELECT * FROM faults ORDER BY requested_at DESC, id DESC LIMIT ?')
        .all(limit) as unknown as FaultRow[]
    ).map(mapFault);
  }

  private closed = false;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function mapNetwork(row: NetworkRow): NetworkRecord {
  return {
    id: row.id,
    name: row.name,
    preset: row.preset as NetworkPreset,
    status: row.status as NetworkStatus,
    designatedTest: row.designated_test === 1,
    chain: row.chain as 'dev' | 'local-spec',
    chainSpecPath: row.chain_spec_path ?? undefined,
    baseDir: row.base_dir,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFault(row: FaultRow): FaultRecord {
  return {
    id: row.id,
    networkId: row.network_id,
    nodeId: row.node_id,
    nodeName: row.node_name,
    type: row.type as FaultRecord['type'],
    mode: row.mode as FaultRecord['mode'],
    state: row.state as FaultState,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? undefined,
    holdDurationMs: row.hold_duration_ms ?? undefined,
    preflight: row.preflight ? (JSON.parse(row.preflight) as FaultPreflight) : undefined,
    plan: row.plan ? (JSON.parse(row.plan) as FaultPlanStep[]) : undefined,
    evidence: row.evidence ? (JSON.parse(row.evidence) as FaultEvidence) : undefined,
    result: row.result ? (JSON.parse(row.result) as FaultExecutionResult) : undefined,
    error: row.error ? (JSON.parse(row.error) as KaizenErrorJson) : undefined,
    reconciled: row.reconciled === 1,
  };
}

function mapNode(row: NodeRow): NodeRecord {
  const ports: NodePorts = {
    p2p: row.p2p_port,
    rpc: row.rpc_port,
    ws: row.ws_port,
    prometheus: row.prom_port,
  };
  return {
    id: row.id,
    networkId: row.network_id,
    name: row.name,
    role: row.role as NodeConfig['role'],
    chain: row.chain as 'dev' | 'local-spec',
    chainSpecPath: row.chain_spec_path ?? undefined,
    wellKnownKey: (row.well_known_key as NodeConfig['wellKnownKey']) ?? undefined,
    bootnodes: JSON.parse(row.bootnodes) as string[],
    baseDir: row.base_dir,
    nodeKeyFile: row.node_key_file,
    logFile: row.log_file,
    ports,
    status: row.status as NodeStatus,
    pid: row.pid ?? undefined,
    startedAt: row.started_at ?? undefined,
    expectedPeers: row.expected_peers ?? 0,
  };
}
