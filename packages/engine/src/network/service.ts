/**
 * NetworkService — network + node lifecycle over real Portaldot processes.
 *
 * Owns: creation (topology plan → chain spec → node keys → ports, with
 * rollback of partial creations), start (ordered spawn + RPC health gating,
 * with rollback), stop (ordered SIGTERM→SIGKILL via NodeProcessManager),
 * per-node start/stop, chain purge, inspect (real RPC snapshots), and removal.
 * All state and operation history is persisted.
 *
 * Topology presets are data (see topologies.ts): single-node (--dev), two-node
 * (Local Testnet, alice+bob genesis authorities), four-validator and
 * validator-fullnode (patched Local Testnet specs — the base spec seeds only
 * two authorities, verified live), and custom (user-defined node list).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { KaizenError, toErrorJson } from '../errors';
import { EventBus, operationEventFrom } from '../events/bus';
import { buildNodeArgs, httpUrlForPort, wsUrlForPort } from '../process/args';
import { NodeProcessManager, readLogTail } from '../process/manager';
import { PortAllocator } from '../process/ports';
import { readSnapshot } from '../rpc/client';
import type { StateStore } from '../state/store';
import type {
  CustomTopologyInput,
  NetworkInspection,
  NetworkPreset,
  NetworkRecord,
  NodeConfig,
  NodeInspection,
  NodePorts,
  NodeRecord,
  OperationResult,
  WellKnownKey,
} from '../types';
import type { BinaryManager } from '../binary/manager';
import { ChainSpecService } from './chainspec';
import { NETWORK_PRESETS, NAME_PATTERN, resolveTopology, type TopologyPlan } from './topologies';

const DEFAULT_HEALTH_TIMEOUT_MS = 90_000;

export interface NetworkServiceOptions {
  store: StateStore;
  binaries: BinaryManager;
  processes: NodeProcessManager;
  events: EventBus;
  ports: PortAllocator;
  /** Root dir for all network state (networks live in <dataDir>/networks/<id>). */
  dataDir: string;
  healthTimeoutMs?: number;
  spawnImpl?: typeof spawn;
  chainSpecs?: ChainSpecService;
}

export interface CreateNetworkInput {
  name: string;
  preset: NetworkPreset;
  /** Required when preset === 'custom'. */
  custom?: CustomTopologyInput;
}

export class NetworkService {
  private readonly store: StateStore;
  private readonly binaries: BinaryManager;
  private readonly processes: NodeProcessManager;
  private readonly events: EventBus;
  private readonly ports: PortAllocator;
  private readonly dataDir: string;
  private readonly healthTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly chainSpecs: ChainSpecService;

  constructor(options: NetworkServiceOptions) {
    this.store = options.store;
    this.binaries = options.binaries;
    this.processes = options.processes;
    this.events = options.events;
    this.ports = options.ports;
    this.dataDir = options.dataDir;
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.chainSpecs =
      options.chainSpecs ?? new ChainSpecService({ binaries: options.binaries, spawnImpl: this.spawnImpl });
  }

  private get networksDir(): string {
    return path.join(this.dataDir, 'networks');
  }

  // -------------------------------------------------------------------------
  // CREATE

  async create(input: CreateNetworkInput): Promise<NetworkRecord> {
    const opId = this.store.startOperation('network.create');
    const startedAt = new Date().toISOString();
    const allocations: NodePorts[] = [];
    let baseDir: string | null = null;
    try {
      if (!NAME_PATTERN.test(input.name)) {
        throw new KaizenError(
          'INVALID_INPUT',
          `Invalid network name "${input.name}" — must match ${NAME_PATTERN}`,
          { name: input.name },
        );
      }
      if (!NETWORK_PRESETS.includes(input.preset)) {
        throw new KaizenError(
          'INVALID_INPUT',
          `Unknown preset "${input.preset}" — supported: ${NETWORK_PRESETS.join(', ')}`,
          { preset: input.preset },
        );
      }
      // Pure topology validation — runs before any fs/process/port side effect.
      const plan = resolveTopology(input.preset, input.custom);

      if (this.store.tryGetNetwork(input.name)) {
        throw new KaizenError(
          'NETWORK_ALREADY_EXISTS',
          `A network named "${input.name}" already exists`,
          { name: input.name },
        );
      }
      // Binary availability is checked, never downloaded here (explicit-setup policy).
      const binStatus = await this.binaries.status();
      if (!binStatus.available) {
        throw new KaizenError(
          'BINARY_NOT_AVAILABLE',
          `Portaldot node binary is not available: ${binStatus.problems.join('; ')}`,
          { problems: binStatus.problems },
        );
      }

      const networkId = `net_${randomBytes(4).toString('hex')}`;
      baseDir = path.join(this.networksDir, networkId);
      if (fs.existsSync(baseDir)) {
        // Never reuse an existing directory as chain data (stale-data guard).
        throw new KaizenError('INTERNAL', `Network base dir already exists: ${baseDir}`);
      }
      fs.mkdirSync(baseDir, { recursive: true });
      const createdAt = new Date().toISOString();

      const { nodes, chainSpecPath } = await this.buildNodes(networkId, input.name, plan, baseDir, allocations);

      const network = this.store.insertNetwork({
        id: networkId,
        name: input.name,
        preset: input.preset,
        status: 'created',
        designatedTest: true, // local/development chains only (DEC-008)
        chain: plan.chain,
        chainSpecPath,
        baseDir,
        createdAt,
      });
      // The create op started before the id existed; link it now so per-network
      // history is complete.
      this.store.attachOperationToNetwork(opId, networkId);

      for (const node of nodes) {
        this.store.insertNode({ config: node, status: 'created', createdAt });
      }

      this.store.finishOperation(opId, { status: 'ok' });
      this.events.emit('network.created', {
        networkId,
        name: input.name,
        preset: input.preset,
        nodeCount: nodes.length,
        at: createdAt,
      });
      this.events.emit('network.status', {
        networkId,
        name: input.name,
        status: 'created',
        at: createdAt,
      });
      this.events.emit(
        'operation.completed',
        operationEventFrom(this.finalizeResult(opId, 'network.create', startedAt, true, networkId)),
      );
      return network;
    } catch (e) {
      // Partial-creation cleanup: remove the half-built network dir and give
      // back any ports we allocated. Never leave debris behind a failed create.
      if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
      try {
        // Drop the now-empty parent too (fails harmlessly if others exist).
        fs.rmdirSync(this.networksDir);
      } catch {
        /* not empty / missing — ignore */
      }
      allocations.forEach((p) => this.ports.release(p));
      this.failOperation(opId, 'network.create', startedAt, e);
      throw e;
    }
  }

  /**
   * Build node configurations from a topology plan: chain spec (patched when
   * the authority set requires it), one node key + peer id per node, unique
   * ports and data dirs, seed-first bootnode wiring, full-mesh peer
   * expectations.
   */
  private async buildNodes(
    networkId: string,
    networkName: string,
    plan: TopologyPlan,
    baseDir: string,
    allocations: NodePorts[],
  ): Promise<{ nodes: NodeConfig[]; chainSpecPath?: string }> {
    const spec = await this.chainSpecs.generate(baseDir, plan);
    const expectedPeers = Math.max(0, plan.nodes.length - 1);
    const nodes: NodeConfig[] = [];
    let seedBootnode: string | undefined;

    for (const [i, template] of plan.nodes.entries()) {
      const ports = await this.ports.allocate();
      allocations.push(ports);
      const nodeKeyFile = path.join(baseDir, `node-${template.suffix}.nodekey`);
      const peerId = await this.generateNodeKey(nodeKeyFile);
      if (i === 0) {
        seedBootnode = `/ip4/127.0.0.1/tcp/${ports.p2p}/p2p/${peerId}`;
      }
      nodes.push({
        id: `${networkId}-${template.suffix}`,
        networkId,
        name: `${networkName}-${template.nameSuffix}`,
        role: template.role,
        chain: plan.chain,
        chainSpecPath: spec.specPath ?? undefined,
        wellKnownKey: template.wellKnownKey,
        bootnodes: i === 0 ? [] : [seedBootnode as string],
        baseDir: path.join(baseDir, `node-${template.suffix}`),
        nodeKeyFile,
        logFile: path.join(baseDir, 'logs', `node-${template.suffix}.log`),
        ports,
        expectedPeers,
      });
    }
    return { nodes, chainSpecPath: spec.specPath ?? undefined };
  }

  /** `key generate-node-key --file <path>` → returns the libp2p peer id. */
  private async generateNodeKey(file: string): Promise<string> {
    // The peer id is printed to STDERR by this binary (verified live); the
    // secret key goes to the file and is never logged.
    const { stdout, stderr } = await this.runBinaryCapture([
      'key',
      'generate-node-key',
      '--file',
      file,
    ]);
    if (!fs.existsSync(file)) {
      throw new KaizenError('INTERNAL', `Node key file was not created at ${file}`);
    }
    const match = `${stdout}\n${stderr}`.match(/1[2-9][A-Za-z0-9]{45,}/);
    if (!match) {
      throw new KaizenError(
        'INTERNAL',
        `Could not parse peer id from key generation output: ${(stdout + stderr).slice(0, 200)}`,
      );
    }
    return match[0];
  }

  /** Run the node binary with argv, optionally writing stdout to a file. */
  private async runBinaryCapture(
    args: string[],
    outFile?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child: ChildProcess = this.spawnImpl(this.binaries.nodePath(), args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      // 'close' (not 'exit'): the peer id line can arrive on stderr after the
      // process exits — 'close' fires once all stdio streams are drained.
      // Caught live: concurrent key generations lost the id line (empty parse).
      child.on('close', (code, signal) => {
        if (code !== 0) {
          reject(
            new KaizenError(
              'INTERNAL',
              `portaldot_dev ${args.join(' ')} failed (code ${code ?? `signal ${signal}`}): ${stderr.slice(0, 500)}`,
            ),
          );
          return;
        }
        if (outFile) fs.writeFileSync(outFile, stdout);
        resolve({ stdout, stderr });
      });
    });
  }

  // -------------------------------------------------------------------------
  // START

  async start(networkIdOrName: string): Promise<OperationResult> {
    const network = this.requireNetwork(networkIdOrName);
    const opId = this.store.startOperation('network.start', network.id);
    const startedAt = new Date().toISOString();

    if (network.status === 'running') {
      const result = this.finalizeResult(opId, 'network.start', startedAt, false, network.id, {
        code: 'NETWORK_ALREADY_RUNNING',
        message: `Network ${network.name} is already running`,
      });
      this.store.finishOperation(opId, {
        status: 'error',
        errorCode: 'NETWORK_ALREADY_RUNNING',
        errorMessage: `Network ${network.name} is already running`,
      });
      this.events.emit('operation.completed', operationEventFrom(result));
      return result;
    }

    const started: NodeRecord[] = [];
    try {
      this.setStatus(network.id, 'starting');
      const nodes = this.store.listNodes(network.id);

      for (const node of nodes) {
        const args = this.argsFor(node);
        const status = await this.processes.start({
          nodeId: node.id,
          binaryPath: this.binaries.nodePath(),
          args,
          logFile: node.logFile,
          baseDir: node.baseDir,
        });
        this.store.updateNodeStatus(node.id, 'running', status.pid ?? null, new Date().toISOString());
        started.push(node);
        this.events.emit('node.status', {
          networkId: network.id,
          nodeId: node.id,
          name: node.name,
          status: 'running',
          pid: status.pid,
          at: new Date().toISOString(),
        });

        // Health gate: the node must answer RPC; dependent nodes must see peers.
        const minPeers = node.bootnodes.length > 0 ? 1 : 0;
        await this.waitUntilHealthy(node, minPeers);
      }

      this.setStatus(network.id, 'running');
      const result = this.finalizeResult(opId, 'network.start', startedAt, true, network.id);
      this.store.finishOperation(opId, { status: 'ok' });
      this.events.emit('operation.completed', operationEventFrom(result));
      return result;
    } catch (e) {
      // Rollback: stop anything we started so we never leave half-networks.
      for (const node of [...started].reverse()) {
        try {
          await this.processes.stop(node.id);
          this.store.updateNodeStatus(node.id, 'stopped', null);
        } catch (stopErr) {
          console.error(`[networks] rollback: failed to stop ${node.id}:`, stopErr);
        }
      }
      this.setStatus(network.id, 'error');
      const err = toErrorJson(e);
      this.store.finishOperation(opId, {
        status: 'error',
        errorCode: err.code,
        errorMessage: err.message,
      });
      const result = this.finalizeResult(opId, 'network.start', startedAt, false, network.id, err);
      this.events.emit('operation.completed', operationEventFrom(result));
      return result;
    }
  }

  /** Poll the node's HTTP RPC until it answers with the required peer count. */
  private async waitUntilHealthy(node: NodeRecord, minPeers: number): Promise<void> {
    const deadline = Date.now() + this.healthTimeoutMs;
    let lastProblem = 'no response yet';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(httpUrlForPort(node.ports.rpc), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] }),
          signal: AbortSignal.timeout(3_000),
        });
        const body = (await res.json()) as { result?: { peers?: number; isSyncing?: boolean } };
        if (body.result && typeof body.result.peers === 'number') {
          if (body.result.peers >= minPeers) return;
          lastProblem = `peers=${body.result.peers}, need >= ${minPeers}`;
        } else {
          lastProblem = `unexpected RPC response: ${JSON.stringify(body).slice(0, 200)}`;
        }
      } catch (e) {
        lastProblem = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    const tail = readLogTail(node.logFile, 2_000).join('\n');
    throw new KaizenError(
      'OPERATION_TIMEOUT',
      `Node ${node.name} did not become healthy within ${this.healthTimeoutMs}ms (${lastProblem}). Log tail:\n${tail}`,
      { nodeId: node.id, logFile: node.logFile },
    );
  }

  private argsFor(node: NodeRecord): string[] {
    return buildNodeArgs({
      name: node.name,
      baseDir: node.baseDir,
      ports: node.ports,
      chain: node.chain === 'dev' ? 'dev' : { specPath: node.chainSpecPath ?? '' },
      wellKnownKey: node.wellKnownKey as WellKnownKey | undefined,
      bootnodes: node.bootnodes,
      nodeKeyFile: node.nodeKeyFile,
    });
  }

  // -------------------------------------------------------------------------
  // STOP

  async stop(networkIdOrName: string): Promise<OperationResult> {
    const network = this.requireNetwork(networkIdOrName);
    const opId = this.store.startOperation('network.stop', network.id);
    const startedAt = new Date().toISOString();
    this.setStatus(network.id, 'stopping');

    const errors: Array<{ nodeId: string; error: string }> = [];
    const nodes = this.store.listNodes(network.id).reverse(); // seed stops last
    for (const node of nodes) {
      try {
        // pid + baseDir enable cross-process ("adopted") stops: CLI processes
        // are short-lived, nodes are daemons (DEC-004).
        await this.processes.stop(node.id, { pid: node.pid, baseDir: node.baseDir });
        this.store.updateNodeStatus(node.id, 'stopped', null);
        this.events.emit('node.status', {
          networkId: network.id,
          nodeId: node.id,
          name: node.name,
          status: 'stopped',
          at: new Date().toISOString(),
        });
      } catch (e) {
        errors.push({ nodeId: node.id, error: e instanceof Error ? e.message : String(e) });
        // Do NOT clear pid/status here: we could not confirm death, so the
        // record must keep pointing at the live process (retry/adopt possible,
        // and remove()'s running-guard stays effective).
      }
    }

    const ok = errors.length === 0;
    this.setStatus(network.id, ok ? 'stopped' : 'error');
    const result = this.finalizeResult(
      opId,
      'network.stop',
      startedAt,
      ok,
      network.id,
      ok ? undefined : { code: 'STOP_TIMEOUT', message: 'Some nodes failed to stop', details: { errors } },
    );
    this.store.finishOperation(opId, ok ? { status: 'ok' } : {
      status: 'error',
      errorCode: 'STOP_TIMEOUT',
      errorMessage: `Failed to stop: ${errors.map((x) => x.nodeId).join(', ')}`,
    });
    this.events.emit('operation.completed', operationEventFrom(result));
    return result;
  }

  // -------------------------------------------------------------------------
  // PER-NODE LIFECYCLE

  /** Start a single node of an existing network (with RPC health gating). */
  async startNode(nodeId: string): Promise<OperationResult> {
    const node = this.requireNode(nodeId);
    const network = this.store.getNetwork(node.networkId);
    if (this.processes.isRunning(node.id) || NodeProcessManager.isExternalPidAlive(node.pid)) {
      throw new KaizenError('NODE_ALREADY_RUNNING', `Node ${node.name} is already running`, {
        nodeId: node.id,
      });
    }
    const opId = this.store.startOperation('node.start', network.id, node.id);
    const startedAt = new Date().toISOString();
    try {
      const status = await this.processes.start({
        nodeId: node.id,
        binaryPath: this.binaries.nodePath(),
        args: this.argsFor(node),
        logFile: node.logFile,
        baseDir: node.baseDir,
      });
      this.store.updateNodeStatus(node.id, 'running', status.pid ?? null, new Date().toISOString());
      this.events.emit('node.status', {
        networkId: network.id,
        nodeId: node.id,
        name: node.name,
        status: 'running',
        pid: status.pid,
        at: new Date().toISOString(),
      });
      const minPeers = node.bootnodes.length > 0 ? 1 : 0;
      await this.waitUntilHealthy(node, minPeers);

      // The network becomes 'running' again when any node runs.
      if (network.status !== 'running') this.setStatus(network.id, 'running');

      const result = this.finalizeResult(opId, 'node.start', startedAt, true, network.id);
      this.store.finishOperation(opId, { status: 'ok' });
      this.events.emit('operation.completed', { ...operationEventFrom(result), nodeId: node.id });
      return result;
    } catch (e) {
      try {
        await this.processes.stop(node.id);
        this.store.updateNodeStatus(node.id, 'stopped', null);
      } catch (stopErr) {
        console.error(`[networks] rollback: failed to stop ${node.id}:`, stopErr);
      }
      this.refreshNetworkStatus(network.id);
      this.failOperation(opId, 'node.start', startedAt, e, network.id, node.id);
      throw e;
    }
  }

  /** Stop a single node (SIGTERM → SIGKILL). Keeps its chain data. */
  async stopNode(nodeId: string): Promise<OperationResult> {
    const node = this.requireNode(nodeId);
    const network = this.store.getNetwork(node.networkId);
    if (!this.processes.isRunning(node.id) && !NodeProcessManager.isExternalPidAlive(node.pid)) {
      throw new KaizenError('NODE_NOT_RUNNING', `Node ${node.name} is not running`, {
        nodeId: node.id,
      });
    }
    const opId = this.store.startOperation('node.stop', network.id, node.id);
    const startedAt = new Date().toISOString();
    try {
      await this.processes.stop(node.id, { pid: node.pid, baseDir: node.baseDir });
      this.store.updateNodeStatus(node.id, 'stopped', null);
      this.events.emit('node.status', {
        networkId: network.id,
        nodeId: node.id,
        name: node.name,
        status: 'stopped',
        at: new Date().toISOString(),
      });
      this.refreshNetworkStatus(network.id);
      const result = this.finalizeResult(opId, 'node.stop', startedAt, true, network.id);
      this.store.finishOperation(opId, { status: 'ok' });
      this.events.emit('operation.completed', { ...operationEventFrom(result), nodeId: node.id });
      return result;
    } catch (e) {
      this.failOperation(opId, 'node.stop', startedAt, e, network.id, node.id);
      throw e;
    }
  }

  /**
   * Tail a node's captured stdout/stderr log (real bytes on disk).
   * Read-only diagnostics for API/UI (T-2.7); returns an empty list when no
   * log has been written yet (e.g. the node never started).
   */
  nodeLogTail(nodeId: string, maxBytes = 16_384): { nodeId: string; lines: string[] } {
    const node = this.requireNode(nodeId);
    const clamped = Math.min(Math.max(Math.trunc(maxBytes), 1_024), 65_536);
    return { nodeId: node.id, lines: readLogTail(node.logFile, clamped) };
  }

  /**
   * Delete all node chain databases while keeping the network definition,
   * node identities (peer ids), ports, and chain spec. The next start begins
   * from a fresh genesis. Refuses while any node is alive.
   */
  async purgeChain(networkIdOrName: string): Promise<OperationResult> {
    const network = this.requireNetwork(networkIdOrName);
    const opId = this.store.startOperation('network.purge', network.id);
    const startedAt = new Date().toISOString();
    try {
      const nodes = this.store.listNodes(network.id);
      for (const node of nodes) {
        if (this.processes.isRunning(node.id) || NodeProcessManager.isExternalPidAlive(node.pid)) {
          throw new KaizenError(
            'NODE_ALREADY_RUNNING',
            `Node ${node.name} is still running — stop the network before purging chain data`,
            { nodeId: node.id },
          );
        }
      }
      for (const node of nodes) {
        fs.rmSync(node.baseDir, { recursive: true, force: true });
        // Clear crashed/stale bookkeeping too: after purge every node is a
        // clean slate that will boot from genesis on next start.
        this.store.updateNodeStatus(node.id, 'stopped', null);
      }
      if (network.status === 'error') this.setStatus(network.id, 'stopped');
      const result = this.finalizeResult(opId, 'network.purge', startedAt, true, network.id);
      this.store.finishOperation(opId, { status: 'ok' });
      this.events.emit('operation.completed', operationEventFrom(result));
      return result;
    } catch (e) {
      this.failOperation(opId, 'network.purge', startedAt, e, network.id);
      throw e;
    }
  }

  /** Recompute network status from real node liveness (any node running). */
  private refreshNetworkStatus(networkId: string): void {
    const nodes = this.store.listNodes(networkId);
    const anyRunning = nodes.some(
      (n) => this.processes.isRunning(n.id) || NodeProcessManager.isExternalPidAlive(n.pid),
    );
    const status = this.store.getNetwork(networkId).status;
    if (anyRunning && status !== 'running' && status !== 'starting') {
      this.setStatus(networkId, 'running');
    } else if (!anyRunning && (status === 'running' || status === 'degraded')) {
      this.setStatus(networkId, 'stopped');
    }
  }

  // -------------------------------------------------------------------------
  // INSPECT

  async inspect(networkIdOrName: string): Promise<NetworkInspection> {
    const network = this.requireNetwork(networkIdOrName);
    const nodes = this.store.listNodes(network.id);
    const inspections: NodeInspection[] = [];

    for (const node of nodes) {
      const managed = this.processes.getStatus(node.id);
      const pidAlive = NodeProcessManager.isExternalPidAlive(node.pid);
      // Cross-process view: CLI processes are short-lived while nodes are
      // daemons, so a live persisted pid is a healthy 'running' node (just not
      // attached to THIS process); only a dead pid with a 'running' record is
      // stale/crashed evidence.
      const processStatus = managed ?? {
        nodeId: node.id,
        state: pidAlive
          ? ('running' as const)
          : node.status === 'running'
            ? ('stale' as const)
            : node.status,
        pid: node.pid,
      };

      const rpcUrl = wsUrlForPort(node.ports.ws);
      let snapshot = null;
      let rpcError: string | undefined;
      try {
        snapshot = await readSnapshot(rpcUrl, { connectTimeoutMs: 5_000, requestTimeoutMs: 5_000 });
      } catch (e) {
        rpcError = e instanceof Error ? e.message : String(e);
      }

      inspections.push({
        nodeId: node.id,
        name: node.name,
        process: processStatus,
        rpcUrl,
        snapshot,
        rpcError,
      });
    }

    return {
      networkId: network.id,
      name: network.name,
      status: this.store.getNetwork(network.id).status,
      nodes: inspections,
      inspectedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // REMOVE

  /** Remove a stopped network and its on-disk state. Refuses if nodes run. */
  async remove(networkIdOrName: string): Promise<void> {
    const network = this.requireNetwork(networkIdOrName);
    const nodes = this.store.listNodes(network.id);
    for (const node of nodes) {
      if (this.processes.isRunning(node.id) || NodeProcessManager.isExternalPidAlive(node.pid)) {
        throw new KaizenError(
          'NODE_ALREADY_RUNNING',
          `Node ${node.name} is still running — stop the network before removing it`,
          { nodeId: node.id },
        );
      }
    }
    this.store.deleteNodes(network.id);
    this.store.deleteNetwork(network.id);
    this.portsUsedBy(nodes).forEach((p) => this.ports.release(p));
    fs.rmSync(network.baseDir, { recursive: true, force: true });
  }

  private portsUsedBy(nodes: NodeRecord[]): Array<NodeRecord['ports']> {
    return nodes.map((n) => n.ports);
  }

  // -------------------------------------------------------------------------
  // Queries

  getNetwork(idOrName: string): { network: NetworkRecord; nodes: NodeRecord[] } {
    const network = this.requireNetwork(idOrName);
    return { network, nodes: this.store.listNodes(network.id) };
  }

  list(): Array<NetworkRecord & { nodeCount: number }> {
    return this.store.listNetworks().map((n) => ({
      ...n,
      nodeCount: this.store.listNodes(n.id).length,
    }));
  }

  // -------------------------------------------------------------------------
  // Helpers

  private requireNetwork(idOrName: string): NetworkRecord {
    const network = this.store.tryGetNetwork(idOrName);
    if (!network) {
      throw new KaizenError('NETWORK_NOT_FOUND', `No network with id or name "${idOrName}"`, {
        idOrName,
      });
    }
    return network;
  }

  private requireNode(nodeId: string): NodeRecord {
    const node = this.store.tryGetNode(nodeId);
    if (!node) {
      throw new KaizenError('NODE_NOT_FOUND', `No node with id "${nodeId}"`, { nodeId });
    }
    return node;
  }

  private setStatus(networkId: string, status: NetworkRecord['status']): void {
    this.store.updateNetworkStatus(networkId, status);
    const network = this.store.getNetwork(networkId);
    this.events.emit('network.status', {
      networkId,
      name: network.name,
      status,
      at: new Date().toISOString(),
    });
  }

  private finalizeResult(
    opId: number,
    kind: string,
    startedAt: string,
    ok: boolean,
    networkId?: string,
    error?: OperationResult['error'],
  ): OperationResult {
    const finishedAt = new Date().toISOString();
    return {
      ok,
      operationId: opId,
      kind,
      networkId,
      startedAt,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      error,
    };
  }

  private failOperation(
    opId: number,
    kind: string,
    startedAt: string,
    e: unknown,
    networkId?: string,
    nodeId?: string,
  ): void {
    const err = toErrorJson(e);
    this.store.finishOperation(opId, { status: 'error', errorCode: err.code, errorMessage: err.message });
    this.events.emit(
      'operation.completed',
      operationEventFrom({
        ...this.finalizeResult(opId, kind, startedAt, false, networkId, err),
        nodeId,
      }),
    );
  }
}
