/**
 * FailureInjector unit tests (T-3.2).
 *
 * These use a REAL stand-in node process (a tiny local HTTP RPC server run by
 * `node -e`) so SIGSTOP/SIGCONT, process identity, RPC reachability, and
 * restart semantics are genuinely exercised — not mocked. The portaldot_dev
 * end-to-end coverage lives in test/integration/faults.int.test.ts.
 *
 * Covered: lifecycle machine, safety-gate rejection (unregistered/non-
 * designated/production-like/ambiguous targets), dry-run default, identity
 * changes between preflight and execution, conflicts, cancellation, timeouts,
 * adapter failures, verification failures, cleanup success/failure, quarantine
 * + reconcile, redaction, event ordering and payload safety, idempotent
 * queries, shutdown rollback.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FAULT_STATES,
  FAULT_TYPES,
  EventBus,
  FailureInjector,
  NodeProcessManager,
  StateStore,
  canTransition,
  createRpcObserver,
  isPidAlive,
  isTerminalFaultState,
  pidFileFor,
  redactFaultDeep,
  redactFaultSecrets,
  type FaultAdapter,
  type FaultObserver,
  type FaultRecord,
  type FaultType,
  type KaizenEventMap,
  type KaizenEventName,
  type NetworkRecord,
  type NodeConfig,
} from '@kaizen/engine';

// ---------------------------------------------------------------------------
// Real stand-in node process (local HTTP RPC answering system_health /
// chain_getHeader). A SIGSTOP'd instance stops answering at the TCP layer —
// exactly the R-22 A behaviour the pause adapter must verify.

function fakeNodeScript(port: number): string {
  return `
const http = require('http');
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let method = '';
    try { method = JSON.parse(body).method; } catch {}
    let result = null;
    if (method === 'system_health') result = { isSyncing: false, peers: 1, shouldHavePeers: true };
    if (method === 'chain_getHeader') result = { number: '0x2a', hash: '0xaaa' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  });
});
srv.listen(${port}, '127.0.0.1');
setInterval(() => {}, 1000);
`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

async function rpcReachable(port: number, timeoutMs = 800): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { result?: unknown };
    return body.result !== undefined;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Harness

interface Harness {
  store: StateStore;
  events: EventBus;
  injector: FailureInjector;
  eventLog: Array<{ name: KaizenEventName; payload: unknown }>;
  networkId: string;
  nodeId: string;
  port: number;
  baseDir: string;
  stopNode: ReturnType<typeof vi.fn>;
  startNode: ReturnType<typeof vi.fn>;
  /** 'down' forces the observer to report RPC unreachable (lying observer). */
  observerMode: { value: 'real' | 'down' };
  childPid(): number | null;
  dispose(): Promise<void>;
}

interface HarnessOptions {
  designatedTest?: boolean;
  chain?: string;
  observer?: FaultObserver;
  adapters?: FaultAdapter[];
}

const harnesses: Harness[] = [];

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-fault-'));
  const store = new StateStore(path.join(dir, 'kaizen.db'));
  const events = new EventBus();
  const eventLog: Array<{ name: KaizenEventName; payload: unknown }> = [];
  events.subscribe((name, payload) => {
    eventLog.push({ name, payload });
  });

  const networkId = 'flt_net';
  const network: Omit<NetworkRecord, 'updatedAt'> = {
    id: networkId,
    name: 'fault-net',
    preset: 'two-node',
    status: 'running',
    designatedTest: options.designatedTest ?? true,
    chain: options.chain ?? 'local-spec',
    baseDir: path.join(dir, 'net'),
    createdAt: new Date().toISOString(),
  };
  store.insertNetwork({ ...network, status: 'created' });
  store.updateNetworkStatus(networkId, 'running');

  const port = await freePort();
  const baseDir = path.join(dir, 'node');
  fs.mkdirSync(baseDir, { recursive: true });
  const nodeId = 'flt_net-a';
  const config: NodeConfig = {
    id: nodeId,
    networkId,
    name: 'fault-alpha',
    role: 'validator',
    chain: 'local-spec',
    wellKnownKey: 'alice',
    bootnodes: [],
    baseDir,
    nodeKeyFile: path.join(dir, 'a.key'),
    logFile: path.join(dir, 'a.log'),
    ports: { p2p: port + 1, rpc: port, ws: port + 2, prometheus: port + 3 },
    expectedPeers: 1,
  };
  store.insertNode({ config, status: 'running', createdAt: new Date().toISOString() });

  const tracked: ChildProcess[] = [];
  const spawnFakeNode = async (): Promise<ChildProcess> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const child = spawn(process.execPath, ['-e', fakeNodeScript(port)], { stdio: 'ignore' });
      tracked.push(child);
      const ready = await waitUntil(() => rpcReachable(port, 500), 4_000, 100);
      if (ready) return child;
      try {
        if (child.pid) process.kill(child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      await sleep(150);
    }
    throw new Error(`stand-in node could not listen on ${port}`);
  };

  let child = await spawnFakeNode();
  store.updateNodeStatus(nodeId, 'running', child.pid!, new Date().toISOString());
  fs.writeFileSync(pidFileFor(baseDir), String(child.pid));

  // Truthful liveness: reads the real store pid against the process table.
  const processes = {
    isRunning: (id: string): boolean => {
      const n = store.tryGetNode(id);
      return !!n?.pid && isPidAlive(n.pid);
    },
  } as unknown as NodeProcessManager;

  const stopNode = vi.fn(async (id: string) => {
    const n = store.tryGetNode(id);
    if (n?.pid) {
      try {
        process.kill(n.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
      await waitUntil(() => !isPidAlive(n.pid!), 3_000, 20);
      try {
        if (n.pid && isPidAlive(n.pid)) process.kill(n.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    store.updateNodeStatus(id, 'stopped', null);
    return { ok: true };
  });

  const startNode = vi.fn(async (id: string) => {
    child = await spawnFakeNode();
    store.updateNodeStatus(id, 'running', child.pid!, new Date().toISOString());
    fs.writeFileSync(pidFileFor(baseDir), String(child.pid));
    return { ok: true };
  });

  const observerMode = { value: 'real' as 'real' | 'down' };
  const realObserver = createRpcObserver({ rpcTimeoutMs: 1_500 });
  const observer: FaultObserver =
    options.observer ??
    ({
      async observe(node) {
        if (observerMode.value === 'down') {
          return {
            at: new Date().toISOString(),
            rpcReachable: false,
            rpcError: 'forced-down (test double)',
          };
        }
        return realObserver.observe(node);
      },
    } satisfies FaultObserver);

  const injector = new FailureInjector({
    store,
    events,
    processes,
    networks: { stopNode, startNode },
    observer,
    adapters: options.adapters,
    defaultHoldMs: 1_500,
  });

  return {
    store,
    events,
    injector,
    eventLog,
    networkId,
    nodeId,
    port,
    baseDir,
    stopNode,
    startNode,
    observerMode,
    childPid: () => store.tryGetNode(nodeId)?.pid ?? null,
    async dispose() {
      await injector.shutdown();
      for (const c of tracked) {
        try {
          if (c.pid) process.kill(c.pid, 'SIGCONT');
        } catch {
          /* ignore */
        }
        try {
          if (c.pid && isPidAlive(c.pid)) process.kill(c.pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const h = await makeHarness(options);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

function faultStateSequence(eventLog: Harness['eventLog']): string[] {
  return eventLog
    .filter((e) => e.name === 'fault.state')
    .map((e) => (e.payload as KaizenEventMap['fault.state']).to);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

// ---------------------------------------------------------------------------
// Lifecycle machine

describe('fault lifecycle machine', () => {
  it('allows exactly the auditable edges and refuses illegal transitions', () => {
    expect(canTransition('requested', 'validating')).toBe(true);
    expect(canTransition('validating', 'ready')).toBe(true);
    expect(canTransition('validating', 'rejected')).toBe(true);
    expect(canTransition('ready', 'executing')).toBe(true);
    expect(canTransition('ready', 'cancelled')).toBe(true);
    expect(canTransition('executing', 'verifying')).toBe(true);
    expect(canTransition('executing', 'cleaning-up')).toBe(true);
    expect(canTransition('verifying', 'cleaning-up')).toBe(true);
    expect(canTransition('cleaning-up', 'completed')).toBe(true);
    expect(canTransition('cleaning-up', 'failed')).toBe(true);
    expect(canTransition('cleaning-up', 'cancelled')).toBe(true);
    expect(canTransition('cleaning-up', 'cleanup-failed')).toBe(true);

    // illegal: skipping phases, resurrecting terminal states, replaying
    expect(canTransition('requested', 'executing')).toBe(false);
    expect(canTransition('requested', 'completed')).toBe(false);
    expect(canTransition('ready', 'completed')).toBe(false);
    expect(canTransition('executing', 'completed')).toBe(false);
    expect(canTransition('validating', 'verifying')).toBe(false);
    expect(canTransition('completed', 'executing')).toBe(false);
    expect(canTransition('completed', 'cleaning-up')).toBe(false);
    expect(canTransition('rejected', 'ready')).toBe(false);
    expect(canTransition('cleanup-failed', 'completed')).toBe(false);
    expect(canTransition('cancelled', 'cancelled')).toBe(false);
  });

  it('exposes all states and correct terminal classification', () => {
    expect([...FAULT_STATES].sort()).toEqual(
      [
        'cancelled',
        'cleanup-failed',
        'cleaning-up',
        'completed',
        'executing',
        'failed',
        'ready',
        'rejected',
        'requested',
        'validating',
        'verifying',
      ].sort(),
    );
    for (const s of ['rejected', 'completed', 'failed', 'cancelled', 'cleanup-failed'] as const) {
      expect(isTerminalFaultState(s)).toBe(true);
    }
    for (const s of ['requested', 'validating', 'ready', 'executing', 'verifying', 'cleaning-up'] as const) {
      expect(isTerminalFaultState(s)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Safety gate

describe('FailureInjector safety gate', () => {
  it('rejects unknown networks and nodes with typed not-found errors (and still audits the rejection)', async () => {
    const h = await harness();
    await expectCode(h.injector.preflight({ networkIdOrName: 'nope', nodeId: h.nodeId, type: 'pause' }), 'NETWORK_NOT_FOUND');
    await expectCode(
      h.injector.dryRun({ networkIdOrName: 'nope', nodeId: h.nodeId, type: 'pause' }),
      'NETWORK_NOT_FOUND',
    );
    const audited = h.store.listFaults({ limit: 10 });
    expect(audited).toHaveLength(1);
    expect(audited[0]!.state).toBe('rejected');
    expect(audited[0]!.error?.code).toBe('NETWORK_NOT_FOUND');

    await expectCode(
      h.injector.execute({ networkIdOrName: h.networkId, nodeId: 'ghost', type: 'pause' }),
      'NODE_NOT_FOUND',
    );
    await expectCode(
      h.injector.execute({
        networkIdOrName: h.networkId,
        nodeId: h.nodeId,
        type: 'explode' as FaultType,
      }),
      'FAULT_NOT_SUPPORTED',
    );
    await expectCode(
      h.injector.dryRun({
        networkIdOrName: h.networkId,
        nodeId: h.nodeId,
        type: 'pause',
        options: { durationMs: 999_999 },
      }),
      'INVALID_INPUT',
    );
  });

  it('refuses non-designated (DEC-008) and non-local-chain targets, fail-closed', async () => {
    const h = await harness({ designatedTest: false, chain: 'mainnet-like' });
    const preview = await h.injector.dryRun({
      networkIdOrName: h.networkId,
      nodeId: h.nodeId,
      type: 'pause',
    });
    expect(preview.state).toBe('rejected');
    expect(preview.preflight.supported).toBe(true); // mechanism fine, TARGET refused
    expect(preview.preflight.checks.find((c) => c.id === 'gate.designated-test')!.ok).toBe(false);
    expect(preview.preflight.checks.find((c) => c.id === 'gate.chain-local')!.ok).toBe(false);
    expect(preview.preflight.blockingReasons.join(' ')).toContain('DEC-008');
    await expectCode(
      h.injector.execute({ networkIdOrName: h.networkId, nodeId: h.nodeId, type: 'pause' }),
      'FAULT_NOT_ALLOWED',
    );
    // Nothing was signalled: the child is still reachable.
    expect(await rpcReachable(h.port)).toBe(true);
  });

  it('refuses targets that are not running engine-managed processes', async () => {
    const h = await harness();
    h.store.updateNodeStatus(h.nodeId, 'stopped', null);
    const preview = await h.injector.dryRun({
      networkIdOrName: h.networkId,
      nodeId: h.nodeId,
      type: 'pause',
    });
    expect(preview.state).toBe('rejected');
    expect(preview.preflight.checks.find((c) => c.id === 'target.engine-managed-running')!.ok).toBe(false);
    await expectCode(
      h.injector.execute({ networkIdOrName: h.networkId, nodeId: h.nodeId, type: 'pause' }),
      'FAULT_NOT_ALLOWED',
    );
  });

  it('refuses ambiguous process identity (pid file disagreeing with the record)', async () => {
    const h = await harness();
    fs.writeFileSync(pidFileFor(h.baseDir), '999999');
    const preview = await h.injector.dryRun({
      networkIdOrName: h.networkId,
      nodeId: h.nodeId,
      type: 'pause',
    });
    expect(preview.state).toBe('rejected');
    const check = preview.preflight.checks.find((c) => c.id === 'target.identity-stable')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('ambiguous ownership');
  });

  it('detects identity drift between preflight and execution and refuses to execute', async () => {
    const h = await harness();
    const pre = await h.injector.preflight({
      networkIdOrName: h.networkId,
      nodeId: h.nodeId,
      type: 'pause',
    });
    expect(pre.ok).toBe(true);
    // Ownership changes after preflight: pid file now names another process.
    fs.writeFileSync(pidFileFor(h.baseDir), '999999');
    await expectCode(
      h.injector.execute({ networkIdOrName: h.networkId, nodeId: h.nodeId, type: 'pause' }),
      'FAULT_NOT_ALLOWED',
    );
    const record = h.store.listFaults({ nodeId: h.nodeId })[0]!;
    expect(record.state).toBe('rejected');
    expect(record.error?.message).toContain('identity-stable');
    expect(await rpcReachable(h.port)).toBe(true); // never signalled
  });

  it('registers exactly the four Phase-3A-backed mechanisms', async () => {
    const h = await harness();
    expect(h.injector.supportedTypes).toEqual([...FAULT_TYPES]);
  });
});

// ---------------------------------------------------------------------------
// Dry-run default

describe('FailureInjector dry-run (default surface)', () => {
  it('produces a ready preview with a full plan and applies nothing', async () => {
    const h = await harness();
    const pidBefore = h.childPid();
    const preview = await h.injector.dryRun({
      networkIdOrName: h.networkId,
      nodeId: h.nodeId,
      type: 'pause',
      requestedBy: 'test',
    });
    expect(preview.state).toBe('ready');
    expect(preview.holdDurationMs).toBe(1_500);
    expect(preview.plan.map((s) => s.phase)).toEqual([
      'apply',
      'verify-effect',
      'hold',
      'remove',
      'verify-recovery',
    ]);
    expect(preview.expectedEffect).toContain('process stays alive');
    expect(preview.cleanup).toContain('SIGCONT');

    const record = h.injector.get(preview.faultId);
    expect(record.mode).toBe('dry-run');
    expect(record.state).toBe('ready');
    expect(record.requestedBy).toBe('test');
    expect(h.childPid()).toBe(pidBefore);
    expect(await rpcReachable(h.port)).toBe(true); // no effect applied

    const states = faultStateSequence(h.eventLog);
    expect(states).toEqual(['validating', 'ready']);
    // Event payloads carry only the audited fields — no options, no secrets.
    for (const e of h.eventLog.filter((x) => x.name === 'fault.state')) {
      expect(Object.keys(e.payload as object).sort()).toEqual([
        'at',
        'faultId',
        'from',
        'networkId',
        'nodeId',
        'nodeName',
        'to',
        'type',
      ]);
    }
  });

  it('records rejected dry-runs too (auditable trail)', async () => {
    const h = await harness({ designatedTest: false });
    const preview = await h.injector.dryRun({
      networkIdOrName: h.networkId,
      nodeId: h.nodeId,
      type: 'terminate',
    });
    expect(preview.state).toBe('rejected');
    const records = h.injector.list({ networkId: h.networkId });
    expect(records).toHaveLength(1);
    expect(records[0]!.state).toBe('rejected');
    expect(faultStateSequence(h.eventLog)).toEqual(['validating', 'rejected']);
  });
});

// ---------------------------------------------------------------------------
// Pause — real signals, real RPC

describe('FailureInjector pause (real SIGSTOP/SIGCONT + real RPC)', () => {
  it(
    'verifies effect and recovery independently with distinct claims and audited events',
    async () => {
      const h = await harness();
      const pidBefore = h.childPid();
      const result = await h.injector.execute({
        networkIdOrName: h.networkId,
        nodeId: h.nodeId,
        type: 'pause',
        options: { durationMs: 1_500 },
        requestedBy: 'test',
      });

      expect(result.outcome).toBe('verified');
      expect(result.ok).toBe(true);
      expect(result.state).toBe('completed');
      // Distinct claims — never one collapsed success flag.
      expect(result.claims).toEqual({
        applied: true,
        effectObserved: true,
        faultRemoved: true,
        recovered: true,
        recoveryVerified: true,
      });

      // Evidence: before/apply/effect/remove/recovery are separate observations.
      expect(result.evidence.before?.rpcReachable).toBe(true);
      expect(result.evidence.applied?.how).toContain('SIGSTOP');
      expect(result.evidence.effect?.observed).toBe(true);
      expect(result.evidence.effect?.observation.rpcReachable).toBe(false);
      expect(result.evidence.removed?.how).toContain('SIGCONT');
      expect(result.evidence.recovery?.verified).toBe(true);
      expect(result.evidence.recovery?.observation.rpcReachable).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(1_500);

      // Independent post-conditions from the test itself.
      expect(h.childPid()).toBe(pidBefore); // no restart
      expect(await rpcReachable(h.port)).toBe(true);

      // Lifecycle events in strict order, then record inspection is idempotent.
      expect(faultStateSequence(h.eventLog)).toEqual([
        'validating',
        'ready',
        'executing',
        'verifying',
        'cleaning-up',
        'completed',
      ]);
      const again = h.injector.get(result.faultId);
      expect(again).toEqual(h.injector.get(result.faultId));
      expect(again.result?.faultId).toBe(result.faultId);
      expect(h.injector.list({ nodeId: h.nodeId })).toHaveLength(1);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Terminate — real process lifecycle

describe('FailureInjector terminate (real process exit + restore)', () => {
  it(
    'proves exit, restore with a NEW pid, and recovery as separate verified claims',
    async () => {
      const h = await harness();
      const oldPid = h.childPid();
      const result = await h.injector.execute({
        networkIdOrName: h.networkId,
        nodeId: h.nodeId,
        type: 'terminate',
        requestedBy: 'test',
      });

      expect(result.outcome).toBe('verified');
      expect(result.ok).toBe(true);
      expect(result.state).toBe('completed');
      expect(result.claims).toEqual({
        applied: true,
        effectObserved: true,
        faultRemoved: true,
        recovered: true,
        recoveryVerified: true,
      });
      expect(result.evidence.applied?.how).toContain('engine stopNode');
      expect(result.evidence.effect?.observation.rpcReachable).toBe(false);
      expect(result.evidence.removed?.how).toContain('engine startNode');
      expect(result.evidence.recovery?.verified).toBe(true);

      const newPid = h.childPid();
      expect(newPid).not.toBe(oldPid); // restart, not resurrection
      expect(result.evidence.recovery?.newPid).toBe(newPid);
      expect(isPidAlive(oldPid!)).toBe(false); // old process is really gone
      expect(await rpcReachable(h.port)).toBe(true); // independent recovery proof
      expect(h.stopNode).toHaveBeenCalledWith(h.nodeId);
      expect(h.startNode).toHaveBeenCalledWith(h.nodeId);
      expect(faultStateSequence(h.eventLog)).toEqual([
        'validating',
        'ready',
        'executing',
        'verifying',
        'cleaning-up',
        'completed',
      ]);
    },
    45_000,
  );
});

// ---------------------------------------------------------------------------
// Conflicts, cancellation, shutdown

describe('FailureInjector conflicts, cancellation, shutdown', () => {
  it(
    'refuses a concurrent fault on a target with an active fault, then cancels cleanly',
    async () => {
      const h = await harness();
      const run = h.injector.execute({
        networkIdOrName: h.networkId,
        nodeId: h.nodeId,
        type: 'pause',
        options: { durationMs: 20_000 },
      });
      expect(await waitUntil(() => h.injector.activeFaults().length === 1, 10_000)).toBe(true);
      const active = h.injector.activeFaults()[0]!;
      expect(active.type).toBe('pause');

      await expectCode(
        h.injector.execute({
          networkIdOrName: h.networkId,
          nodeId: h.nodeId,
          type: 'pause',
          options: { durationMs: 500 },
        }),
        'FAULT_CONFLICT',
      );

      const cancelled = await h.injector.cancel(active.faultId);
      const result = await run;
      expect(cancelled.state).toBe('cancelled');
      expect(result.state).toBe('cancelled');
      expect(result.outcome).toBe('inconclusive'); // aborted early — not a full run
      expect(result.claims.recoveryVerified).toBe(true); // never "success" with a fault active
      expect(await rpcReachable(h.port)).toBe(true); // resumed
      expect(h.injector.activeFaults()).toHaveLength(0);

      // Terminal records refuse further actions.
      await expectCode(h.injector.cancel(result.faultId), 'FAULT_CONFLICT');
      await expectCode(h.injector.reconcile(result.faultId), 'FAULT_CONFLICT');
    },
    45_000,
  );

  it(
    'shutdown rolls back an in-flight pause instead of leaking a stopped process',
    async () => {
      const h = await harness();
      const run = h.injector.execute({
        networkIdOrName: h.networkId,
        nodeId: h.nodeId,
        type: 'pause',
        options: { durationMs: 30_000 },
      });
      expect(await waitUntil(() => h.injector.activeFaults().length === 1, 10_000)).toBe(true);
      await h.injector.shutdown();
      const result = await run;
      expect(result.state).toBe('cancelled');
      expect(result.claims.recoveryVerified).toBe(true);
      expect(await rpcReachable(h.port)).toBe(true); // process resumed, not leaked
    },
    45_000,
  );
});

// ---------------------------------------------------------------------------
// Cleanup failure → quarantine → reconcile

describe('FailureInjector cleanup failure, quarantine, reconcile', () => {
  it(
    'marks cleanup-failed honestly, emits a high-severity event, blocks the target, and only reconciles on proof',
    async () => {
      const h = await harness();
      // Baseline + effect verification are REAL (SIGSTOP genuinely stops RPC).
      // From the cleanup phase on, the observer lies: recovery cannot be
      // proven even though SIGCONT actually resumed the process.
      const sub = h.events.subscribe((name, payload) => {
        if (name === 'fault.state' && (payload as KaizenEventMap['fault.state']).to === 'cleaning-up') {
          h.observerMode.value = 'down';
        }
      });
      const result = await h.injector.execute({
        networkIdOrName: h.networkId,
        nodeId: h.nodeId,
        type: 'pause',
        options: { durationMs: 300 },
      });
      sub();

      expect(result.ok).toBe(false);
      expect(result.outcome).toBe('inconclusive'); // never "verified"
      expect(result.state).toBe('cleanup-failed');
      expect(result.claims.recoveryVerified).toBe(false);
      expect(result.evidence.notes.join(' ')).toContain('recovery NOT verified');

      const severityEvent = h.eventLog.find((e) => e.name === 'fault.cleanup-failed');
      expect(severityEvent).toBeDefined();
      expect((severityEvent!.payload as KaizenEventMap['fault.cleanup-failed']).severity).toBe('high');
      expect(faultStateSequence(h.eventLog).at(-1)).toBe('cleanup-failed');

      // Quarantined: further faults on the target are refused...
      await expectCode(
        h.injector.execute({ networkIdOrName: h.networkId, nodeId: h.nodeId, type: 'pause' }),
        'FAULT_NOT_ALLOWED',
      );
      // ...and reconcile refuses to release while the effect still looks active.
      h.observerMode.value = 'down';
      const stillBlocked = await h.injector.reconcile(result.faultId);
      expect(stillBlocked.reconciled).toBe(false);
      expect(stillBlocked.evidence?.notes.join(' ')).toContain('quarantine kept');

      // Once reality shows the effect is gone, reconcile releases the target.
      h.observerMode.value = 'real';
      expect(await rpcReachable(h.port)).toBe(true); // SIGCONT did resume it
      const released = await h.injector.reconcile(result.faultId);
      expect(released.reconciled).toBe(true);
      expect(released.evidence?.notes.join(' ')).toContain('quarantine released');
      const pre = await h.injector.preflight({
        networkIdOrName: h.networkId,
        nodeId: h.nodeId,
        type: 'pause',
      });
      expect(pre.checks.find((c) => c.id === 'target.not-quarantined')!.ok).toBe(true);
    },
    45_000,
  );
});

// ---------------------------------------------------------------------------
// Blocked mechanisms

describe('blocked mechanisms fail explicitly (no silent substitution)', () => {
  it('peer-disconnect: typed unsupported result with precise unblock path', async () => {
    const h = await harness();
    const preview = await h.injector.dryRun({
      networkIdOrName: h.networkId,
      nodeId: h.nodeId,
      type: 'peer-disconnect',
    });
    expect(preview.state).toBe('rejected');
    expect(preview.preflight.supported).toBe(false);
    expect(preview.preflight.unblock).toContain('reserved-only');
    expect(preview.preflight.unblock).toContain('t31-b3.log');
    expect(preview.plan).toEqual([]); // no plan is promised for a blocked mechanism
    await expectCode(
      h.injector.execute({ networkIdOrName: h.networkId, nodeId: h.nodeId, type: 'peer-disconnect' }),
      'FAULT_NOT_SUPPORTED',
    );
    // No effect could have occurred.
    expect(await rpcReachable(h.port)).toBe(true);
  });

  it('partition: typed unsupported result citing both evidence-backed routes', async () => {
    const h = await harness();
    const pre = await h.injector.preflight({
      networkIdOrName: h.networkId,
      nodeId: h.nodeId,
      type: 'partition',
    });
    expect(pre.ok).toBe(false);
    expect(pre.supported).toBe(false);
    expect(pre.unblock).toContain('DEC-018');
    expect(pre.blockingReasons.join(' ')).toContain('R-22');
    expect(pre.blockingReasons.join(' ')).toContain('never severs an established connection');
  });
});

// ---------------------------------------------------------------------------
// Scripted adapter paths (orchestrator behaviour under adapter outcomes)

function scriptedAdapter(overrides: Partial<FaultAdapter> = {}): FaultAdapter {
  const now = () => new Date().toISOString();
  return {
    type: 'pause',
    mechanism: 'scripted test double',
    privileges: 'none',
    reversible: true,
    expectedEffect: 'scripted',
    cleanupDescription: 'scripted',
    timeoutBehavior: 'scripted',
    failureBehavior: 'scripted',
    timeouts: { applyMs: 5_000, verifyEffectMs: 5_000, removeMs: 5_000, verifyRecoveryMs: 5_000 },
    async preflight() {
      return { supported: true, checks: [{ id: 'scripted', ok: true, detail: 'ok' }] };
    },
    plan() {
      return [{ phase: 'apply', description: 'scripted', timeoutMs: 100 }];
    },
    async apply() {
      return { at: now(), how: 'scripted apply' };
    },
    async verifyEffect() {
      return {
        observed: true,
        attempts: 1,
        detail: 'scripted',
        observation: { at: now(), rpcReachable: false },
        at: now(),
      };
    },
    async remove() {
      return { at: now(), how: 'scripted remove' };
    },
    async verifyRecovery() {
      return {
        verified: true,
        attempts: 1,
        detail: 'scripted',
        observation: { at: now(), rpcReachable: true },
        at: now(),
      };
    },
    ...overrides,
  };
}

describe('FailureInjector scripted adapter paths', () => {
  it('times out a hung apply and reports failure (not success)', async () => {
    const h = await harness({
      adapters: [
        scriptedAdapter({
          timeouts: { applyMs: 50, verifyEffectMs: 5_000, removeMs: 5_000, verifyRecoveryMs: 5_000 },
          async apply() {
            await sleep(10_000); // exceeds the 50ms bound + 3s backstop
            return { at: new Date().toISOString(), how: 'too late' };
          },
        }),
      ],
    });
    const result = await h.injector.execute({
      networkIdOrName: h.networkId,
      nodeId: h.nodeId,
      type: 'pause',
      options: { durationMs: 300 },
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('failed');
    expect(result.state).toBe('failed');
    expect(result.error?.code).toBe('OPERATION_TIMEOUT');
    expect(result.claims.applied).toBe(false);
    expect(result.claims.recoveryVerified).toBe(false);
  }, 15_000);

  it('reports an unobserved effect as failed with recovery still verified', async () => {
    const h = await harness({
      adapters: [
        scriptedAdapter({
          async verifyEffect() {
            return {
              observed: false,
              attempts: 3,
              detail: 'no effect',
              observation: { at: new Date().toISOString(), rpcReachable: true },
              at: new Date().toISOString(),
            };
          },
        }),
      ],
    });
    const result = await h.injector.execute({
      networkIdOrName: h.networkId,
      nodeId: h.nodeId,
      type: 'pause',
      options: { durationMs: 300 },
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('failed');
    expect(result.state).toBe('failed');
    expect(result.claims).toMatchObject({
      applied: true,
      effectObserved: false,
      faultRemoved: true,
      recoveryVerified: true,
    });
    expect(result.evidence.notes.join(' ')).toContain('expected effect was never observed');
  }, 15_000);

  it('runs cleanup when the adapter throws mid-flight, and marks cleanup-failed when cleanup also fails', async () => {
    const h = await harness({
      adapters: [
        scriptedAdapter({
          async verifyEffect() {
            throw new Error('observer exploded');
          },
          async remove() {
            throw new Error('rollback unavailable');
          },
        }),
      ],
    });
    const result = await h.injector.execute({
      networkIdOrName: h.networkId,
      nodeId: h.nodeId,
      type: 'pause',
      options: { durationMs: 300 },
    });
    expect(result.state).toBe('cleanup-failed');
    expect(result.outcome).toBe('inconclusive');
    expect(result.claims.applied).toBe(true);
    expect(result.claims.faultRemoved).toBe(false); // cleanup could not be confirmed
    expect(result.evidence.notes.join(' ')).toContain('cleanup attempt failed');
    expect(h.eventLog.some((e) => e.name === 'fault.cleanup-failed')).toBe(true);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Redaction

describe('secret redaction', () => {
  it('strips key material and secret assignments from strings', () => {
    expect(redactFaultSecrets('node key 0xabc password=hunter2')).not.toContain('hunter2');
    expect(redactFaultSecrets('password: hunter2')).not.toContain('hunter2');
    expect(redactFaultSecrets('--password-filename /run/secrets/p')).not.toContain('/run/secrets/p');
    const pem = '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----';
    expect(redactFaultSecrets(pem)).toBe('[redacted]');
    expect(redactFaultSecrets('head #1024 peers=3')).toBe('head #1024 peers=3'); // evidence survives
  });

  it('deep-redacts nested structures without mutating the input', () => {
    const input = { a: 'password=hunter2', b: [{ mnemonic: 'alpha beta' }], c: 7 };
    const out = redactFaultDeep(input);
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('alpha beta');
    expect(out.c).toBe(7);
    expect(input.a).toBe('password=hunter2'); // original untouched
  });

  it('fault records returned to callers are redacted', async () => {
    const h = await harness();
    const preview = await h.injector.dryRun({
      networkIdOrName: h.networkId,
      nodeId: h.nodeId,
      type: 'pause',
    });
    const record: FaultRecord = h.injector.get(preview.faultId);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toMatch(/BEGIN.*PRIVATE KEY/);
  });
});
