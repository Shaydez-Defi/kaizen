/**
 * NodeProcessManager — real process orchestration for portaldot_dev nodes.
 *
 * Safety/design rules (DEC-004):
 *  - spawn with argv arrays only (never shell strings); argv is re-checked
 *    with assertSafeArgs() immediately before every spawn
 *  - stdout/stderr are written straight to a per-node log FILE DESCRIPTOR so
 *    nodes survive the exit of the CLI/API process that started them
 *    (no broken-pipe crashes, no orphaned pipe buffers)
 *  - stop(): SIGTERM → grace period → SIGKILL escalation, always confirmed
 *  - duplicate management of the same node is refused
 *  - stale pid files (crashed/external processes) are detected, never
 *    silently adopted
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { KaizenError } from '../errors';
import type { NodeRuntimeStatus, NodeStatus } from '../types';
import { assertSafeArgs } from './args';

export interface ManagedNodeSpec {
  nodeId: string;
  binaryPath: string;
  /** Full argv (without the binary path). Re-validated before spawn. */
  args: string[];
  logFile: string;
  baseDir: string;
}

export interface StartOptions {
  /** How long the process must survive to count as started. Default 750ms. */
  settleMs?: number;
}

export interface StopOptions {
  /** SIGTERM grace period before SIGKILL. Default 15s. */
  graceMs?: number;
  /**
   * Adopted-stop inputs for nodes started by ANOTHER process (CLI runs are
   * short-lived while nodes are daemons): the persisted pid and/or base dir
   * (for the kaizen-node.pid file). Ignored when the node is managed here.
   */
  pid?: number;
  baseDir?: string;
}

interface Managed {
  spec: ManagedNodeSpec;
  child: ChildProcess;
  pid: number;
  state: NodeStatus;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  lastError?: string;
}

export interface NodeProcessManagerOptions {
  /** Called on unexpected exits (crash detection); wired to the event bus. */
  onExit?: (nodeId: string, info: { code: number | null; signal: string | null }) => void;
  spawnImpl?: typeof spawn;
}

export function pidFileFor(baseDir: string): string {
  return path.join(baseDir, 'kaizen-node.pid');
}

/** True if a process with this pid is currently alive (and we may signal it). */
export function isPidAlive(pid: number): boolean {
  // pid <= 0 is invalid for our purposes: 0/-1 signal the whole process
  // GROUP in kill(2) semantics — never treat them as a live node.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class NodeProcessManager {
  private readonly nodes = new Map<string, Managed>();
  private readonly onExit?: NodeProcessManagerOptions['onExit'];
  private readonly spawnImpl: typeof spawn;

  constructor(options: NodeProcessManagerOptions = {}) {
    this.onExit = options.onExit;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  /** Node ids currently managed by this manager instance. */
  get managedNodeIds(): string[] {
    return [...this.nodes.keys()];
  }

  isRunning(nodeId: string): boolean {
    const m = this.nodes.get(nodeId);
    if (!m) return false;
    if (m.state === 'running' || m.state === 'starting') {
      return isPidAlive(m.pid);
    }
    return false;
  }

  getStatus(nodeId: string): NodeRuntimeStatus | undefined {
    const m = this.nodes.get(nodeId);
    if (!m) return undefined;
    return {
      nodeId,
      state: isPidAlive(m.pid) ? m.state : m.state === 'starting' || m.state === 'running' ? 'crashed' : m.state,
      pid: m.pid,
      startedAt: m.startedAt,
      exitedAt: m.exitedAt,
      exitCode: m.exitCode,
      exitSignal: m.exitSignal,
      lastError: m.lastError,
    };
  }

  async start(spec: ManagedNodeSpec, options: StartOptions = {}): Promise<NodeRuntimeStatus> {
    const settleMs = options.settleMs ?? 750;

    // 1. refuse duplicate management
    const existing = this.nodes.get(spec.nodeId);
    if (existing && isPidAlive(existing.pid)) {
      throw new KaizenError(
        'NODE_ALREADY_RUNNING',
        `Node ${spec.nodeId} is already running (pid ${existing.pid})`,
        { nodeId: spec.nodeId, pid: existing.pid },
      );
    }

    // 2. stale pid-file detection (another manager/instance owns it)
    const pidFile = pidFileFor(spec.baseDir);
    if (fs.existsSync(pidFile)) {
      const stalePid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (Number.isFinite(stalePid) && stalePid > 0 && isPidAlive(stalePid)) {
        throw new KaizenError(
          'STALE_PROCESS',
          `A live process (pid ${stalePid}) already owns ${spec.baseDir}; stop it before starting ${spec.nodeId}`,
          { nodeId: spec.nodeId, pid: stalePid, pidFile },
        );
      }
      fs.rmSync(pidFile, { force: true });
    }

    // 3. prepare isolated dirs + log file descriptor
    fs.mkdirSync(spec.baseDir, { recursive: true });
    fs.mkdirSync(path.dirname(spec.logFile), { recursive: true });
    const logFd = fs.openSync(spec.logFile, 'a');

    assertSafeArgs(spec.args);

    let child: ChildProcess;
    try {
      child = this.spawnImpl(spec.binaryPath, spec.args, {
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env },
      });
    } catch (e) {
      fs.closeSync(logFd);
      throw new KaizenError(
        'STARTUP_FAILED',
        `Failed to spawn ${spec.nodeId}: ${e instanceof Error ? e.message : String(e)}`,
        { nodeId: spec.nodeId },
      );
    } finally {
      // The child owns a dup of the fd; close our copy in all cases.
      try { fs.closeSync(logFd); } catch { /* already closed */ }
    }

    const pid = child.pid;
    if (!pid) {
      throw new KaizenError('STARTUP_FAILED', `Spawn produced no pid for ${spec.nodeId}`, {
        nodeId: spec.nodeId,
      });
    }

    const managed: Managed = {
      spec,
      child,
      pid,
      state: 'starting',
      startedAt: new Date().toISOString(),
    };
    this.nodes.set(spec.nodeId, managed);

    child.on('exit', (code, signal) => {
      managed.exitedAt = new Date().toISOString();
      managed.exitCode = code;
      managed.exitSignal = signal;
      const wasManagedStop = managed.state === 'stopping';
      // Crash detection is intrinsic: an unexpected exit is 'crashed' whether
      // or not an onExit notification hook was wired (DEC-009: report reality).
      managed.state = wasManagedStop ? 'stopped' : 'crashed';
      try { fs.rmSync(pidFileFor(managed.spec.baseDir), { force: true }); } catch { /* ignore */ }
      if (!wasManagedStop) {
        managed.lastError = `process exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
        this.onExit?.(managed.spec.nodeId, { code, signal });
      }
    });

    // 4. settle check: catch immediate startup failures (bad flags, etc.)
    await new Promise((r) => setTimeout(r, settleMs));
    if (child.exitCode !== null || child.signalCode !== null) {
      this.nodes.delete(spec.nodeId);
      const tail = readLogTail(spec.logFile, 4000);
      throw new KaizenError(
        'STARTUP_FAILED',
        `Node ${spec.nodeId} exited during startup (code=${child.exitCode}, signal=${child.signalCode}). Log tail:\n${tail}`,
        { nodeId: spec.nodeId, exitCode: child.exitCode, logFile: spec.logFile },
      );
    }

    managed.state = 'running';
    fs.writeFileSync(pidFile, String(pid));
    // Daemon-style: the node must survive the exit of this CLI/API process
    // (stdio goes to the log file, so no broken-pipe risk). unref() keeps the
    // parent event loop from being held open by the child handle.
    child.unref();

    return {
      nodeId: spec.nodeId,
      state: 'running',
      pid,
      startedAt: managed.startedAt,
    };
  }

  async stop(nodeId: string, options: StopOptions = {}): Promise<NodeRuntimeStatus> {
    const graceMs = options.graceMs ?? 15_000;
    const m = this.nodes.get(nodeId);

    if (!m) {
      // Not managed by THIS process — nodes are daemons and CLI processes are
      // short-lived, so stop must work cross-process via the persisted pid
      // (store) or the kaizen-node.pid file under the node's base dir.
      let pid = options.pid;
      if (!pid && options.baseDir) {
        const pidFile = pidFileFor(options.baseDir);
        if (fs.existsSync(pidFile)) {
          const filePid = Number(fs.readFileSync(pidFile, 'utf8').trim());
          if (Number.isFinite(filePid) && filePid > 0) pid = filePid;
        }
      }
      if (!pid || !isPidAlive(pid)) {
        if (options.baseDir) fs.rmSync(pidFileFor(options.baseDir), { force: true });
        return { nodeId, state: 'stopped', pid };
      }
      return this.adoptedStop(nodeId, pid, graceMs, options.baseDir);
    }

    if (!isPidAlive(m.pid)) {
      this.nodes.delete(nodeId);
      const status: NodeRuntimeStatus = {
        nodeId,
        state: m.state === 'crashed' ? 'crashed' : 'stopped',
        pid: m.pid,
        startedAt: m.startedAt,
        exitedAt: m.exitedAt,
        exitCode: m.exitCode,
        exitSignal: m.exitSignal,
      };
      return status;
    }

    m.state = 'stopping';
    const exited = new Promise<void>((resolve) => {
      if (m.child.exitCode !== null || m.child.signalCode !== null) {
        resolve();
        return;
      }
      m.child.once('exit', () => resolve());
    });

    m.child.kill('SIGTERM');
    const graceful = await withTimeout(exited, graceMs)
      .then(() => true)
      .catch(() => false);

    if (!graceful) {
      m.child.kill('SIGKILL');
      const killed = await withTimeout(exited, 5_000)
        .then(() => true)
        .catch(() => false);
      if (!killed) {
        throw new KaizenError(
          'STOP_TIMEOUT',
          `Node ${nodeId} (pid ${m.pid}) survived SIGKILL; manual intervention required`,
          { nodeId, pid: m.pid },
        );
      }
    }

    m.state = 'stopped';
    this.nodes.delete(nodeId);
    return {
      nodeId,
      state: 'stopped',
      pid: m.pid,
      startedAt: m.startedAt,
      exitedAt: m.exitedAt,
      exitCode: m.exitCode,
      exitSignal: m.exitSignal,
    };
  }

  /** SIGTERM→SIGKILL stop of a node owned by another process (by pid). */
  private async adoptedStop(
    nodeId: string,
    pid: number,
    graceMs: number,
    baseDir?: string,
  ): Promise<NodeRuntimeStatus> {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    let dead = await waitForDeath(pid, graceMs);
    if (!dead) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      dead = await waitForDeath(pid, 5_000);
      if (!dead) {
        throw new KaizenError(
          'STOP_TIMEOUT',
          `Node ${nodeId} (pid ${pid}) survived SIGKILL; manual intervention required`,
          { nodeId, pid },
        );
      }
    }
    if (baseDir) fs.rmSync(pidFileFor(baseDir), { force: true });
    return { nodeId, state: 'stopped', pid };
  }

  async restart(spec: ManagedNodeSpec, options: StartOptions & StopOptions = {}): Promise<NodeRuntimeStatus> {
    if (this.nodes.has(spec.nodeId)) {
      await this.stop(spec.nodeId, options);
    }
    return this.start(spec, options);
  }

  /** Stop every managed node (reverse start order). Used by tests/cleanup. */
  async killAll(options: StopOptions = {}): Promise<void> {
    const ids = [...this.nodes.keys()].reverse();
    for (const id of ids) {
      try {
        await this.stop(id, options);
      } catch (e) {
        console.error(`[processes] killAll: failed to stop ${id}:`, e);
      }
    }
  }

  /**
   * Check a stored pid (from a previous run) for aliveness — used to mark
   * nodes 'stale'/'crashed' after engine restarts.
   */
  static isExternalPidAlive(pid: number | undefined | null): boolean {
    return typeof pid === 'number' && pid > 0 && isPidAlive(pid);
  }
}

/** Read the last `maxBytes` of a log file, split into lines. */
export function readLogTail(logFile: string, maxBytes = 16_384): string[] {
  try {
    const stat = fs.statSync(logFile);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(logFile, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8').split('\n').filter((l) => l.length > 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Poll until the pid is no longer alive (or timeout). */
async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return !isPidAlive(pid);
}
