/**
 * NetworkService — the first real network lifecycle service (T-1.6).
 *
 * Owns: network creation (topology → node configs, chain spec, keys, ports),
 * start (ordered spawn + RPC health gating, with rollback), stop (ordered,
 * SIGTERM→SIGKILL via NodeProcessManager), inspect (real RPC snapshots), and
 * removal. All state and operation history is persisted.
 *
 * Presets (Phase 1):
 *  - single-node: `--dev --alice` development chain, one validator node.
 *  - two-node: generated Local Testnet raw chain spec; `--alice` seed node +
 *    `--bob` node wired to the seed via a static bootnode multiaddr derived
 *    from a pre-generated node key (peer connectivity proven in Phase 0 R-04).
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
  NetworkInspection,
  NetworkPreset,
  NetworkRecord,
  NodeConfig,
  NodeInspection,
  NodeRecord,
  OperationResult,
  WellKnownKey,
} from '../types';
import type { BinaryManager } from '../binary/manager';

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PRESETS: NetworkPreset[] = ['single-node', 'two-node'];
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
}

export interface CreateNetworkInput {
  name: string;
  preset: NetworkPreset;
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

  constructor(options: NetworkServiceOptions) {
    this.store = options.store;
    this.binaries = options.binaries;
    this.processes = options.processes;
    this.events = options.events;
    this.ports = options.ports;
    this.dataDir = options.dataDir;
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  private get networksDir(): string {
    return path.join(this.dataDir, 'networks');
  }

  // -------------------------------------------------------------------------
  // CREATE

  async create(input: CreateNetworkInput): Promise<NetworkRecord> {
    const opId = this.store.startOperation('network.create');
    const startedAt = new Date().toISOString();
    try {
      if (!NAME_PATTERN.test(input.name)) {
        throw new KaizenError(
          'INVALID_INPUT',
          `Invalid network name "${input.name}" — must match ${NAME_PATTERN}`,
          { name: input.name },
        );
      }
      if (!PRESETS.includes(input.preset)) {
        throw new KaizenError(
          'INVALID_INPUT',
          `Unknown preset "${input.preset}" — supported: ${PRESETS.join(', ')}`,
          { preset: input.preset },
        );
      }
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
      const baseDir = path.join(this.networksDir, networkId);
      fs.mkdirSync(baseDir, { recursive: true });
      const createdAt = new Date().toISOString();

      const nodeSpecs = await this.buildNodeSpecs(networkId, input, baseDir);

      const network = this.store.insertNetwork({
        id: networkId,
        name: input.name,
        preset: input.preset,
        status: 'created',
        designatedTest: true, // local/development chains only (DEC-008)
        chain: input.preset === 'single-node' ? 'dev' : 'local-spec',
        chainSpecPath: nodeSpecs.chainSpecPath,
        baseDir,
        createdAt,
      });
      // The create op started before the id existed; link it now so per-network
      // history is complete.
      this.store.attachOperationToNetwork(opId, networkId);

      for (const node of nodeSpecs.nodes) {
        this.store.insertNode({ config: node, status: 'created', createdAt });
      }

      this.store.finishOperation(opId, { status: 'ok' });
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
      this.failOperation(opId, 'network.create', startedAt, e);
      throw e;
    }
  }

  /** Build per-node configurations (ports, keys, chain spec) for a preset. */
  private async buildNodeSpecs(
    networkId: string,
    input: CreateNetworkInput,
    baseDir: string,
  ): Promise<{ nodes: NodeConfig[]; chainSpecPath?: string }> {
    const nodes: NodeConfig[] = [];

    if (input.preset === 'single-node') {
      const ports = await this.ports.allocate();
      const nodeKeyFile = path.join(baseDir, 'node-a.nodekey');
      await this.generateNodeKey(nodeKeyFile);
      nodes.push({
        id: `${networkId}-a`,
        networkId,
        name: `${input.name}-alice`,
        role: 'validator',
        chain: 'dev',
        wellKnownKey: 'alice',
        bootnodes: [],
        baseDir: path.join(baseDir, 'node-a'),
        nodeKeyFile,
        logFile: path.join(baseDir, 'logs', 'node-a.log'),
        ports,
      });
      return { nodes };
    }

    // two-node: generate the shared raw chain spec from the embedded Local Testnet.
    const chainSpecPath = path.join(baseDir, 'chain-spec.json');
    await this.runBinaryCapture(
      ['build-spec', '--chain', 'local', '--raw', '--disable-default-bootnode'],
      chainSpecPath,
    );

    const aliceKeyFile = path.join(baseDir, 'node-a.nodekey');
    const bobKeyFile = path.join(baseDir, 'node-b.nodekey');
    const alicePeerId = await this.generateNodeKey(aliceKeyFile);
    await this.generateNodeKey(bobKeyFile);

    const alicePorts = await this.ports.allocate();
    const bobPorts = await this.ports.allocate();
    const aliceBootnode = `/ip4/127.0.0.1/tcp/${alicePorts.p2p}/p2p/${alicePeerId}`;

    nodes.push({
      id: `${networkId}-a`,
      networkId,
      name: `${input.name}-alice`,
      role: 'validator',
      chain: 'local-spec',
      chainSpecPath,
      wellKnownKey: 'alice',
      bootnodes: [],
      baseDir: path.join(baseDir, 'node-a'),
      nodeKeyFile: aliceKeyFile,
      logFile: path.join(baseDir, 'logs', 'node-a.log'),
      ports: alicePorts,
    });
    nodes.push({
      id: `${networkId}-b`,
      networkId,
      name: `${input.name}-bob`,
      role: 'validator',
      chain: 'local-spec',
      chainSpecPath,
      wellKnownKey: 'bob',
      bootnodes: [aliceBootnode],
      baseDir: path.join(baseDir, 'node-b'),
      nodeKeyFile: bobKeyFile,
      logFile: path.join(baseDir, 'logs', 'node-b.log'),
      ports: bobPorts,
    });
    return { nodes, chainSpecPath };
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
      child.on('exit', (code) => {
        if (code !== 0) {
          reject(
            new KaizenError('INTERNAL', `portaldot_dev ${args.join(' ')} failed (code ${code}): ${stderr.slice(0, 500)}`),
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
        this.store.updateNodeStatus(node.id, 'running', status.pid ?? null);
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
  ): void {
    const err = toErrorJson(e);
    this.store.finishOperation(opId, { status: 'error', errorCode: err.code, errorMessage: err.message });
    this.events.emit(
      'operation.completed',
      operationEventFrom(this.finalizeResult(opId, kind, startedAt, false, undefined, err)),
    );
  }
}
