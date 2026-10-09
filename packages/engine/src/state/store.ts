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
          status, pid, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
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

  listNodes(networkId: string): NodeRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM nodes WHERE network_id = ? ORDER BY id')
      .all(networkId) as unknown as NodeRow[];
    return rows.map(mapNode);
  }

  updateNodeStatus(id: string, status: NodeStatus, pid?: number | null): void {
    this.db
      .prepare('UPDATE nodes SET status = ?, pid = ?, updated_at = ? WHERE id = ?')
      .run(status, pid ?? null, new Date().toISOString(), id);
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

  close(): void {
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
  };
}
