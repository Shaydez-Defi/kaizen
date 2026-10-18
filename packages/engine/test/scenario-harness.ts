/**
 * Shared unit-test harness for the ScenarioEngine suites (T-3.4/T-3.5).
 *
 * REAL stand-in node processes (tiny local HTTP RPC servers, the same R-22 A
 * pattern as fault.test.ts) so process identity, pause semantics, and RPC
 * reachability are genuinely exercised; the mechanism itself runs through
 * scripted FaultAdapter doubles for deterministic failure paths. Monitoring
 * is deliberately inert (health-state conditions must evaluate INCONCLUSIVE).
 *
 * Used by scenario-run.test.ts (execution engine, T-3.4) and
 * scenario-replay.test.ts (replay, T-3.5). Not a vitest suite itself.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, vi } from 'vitest';
import {
  EventBus,
  FailureInjector,
  MonitoringService,
  NodeProcessManager,
  ScenarioEngine,
  ScenarioService,
  StateStore,
  createRpcObserver,
  isPidAlive,
  pidFileFor,
  type FaultAdapter,
  type FaultObserver,
  type KaizenError,
  type KaizenEventName,
  type NetworkRecord,
  type NodeConfig,
  type ScenarioInput,
  type ScenarioRunRecord,
} from '@kaizen/engine';

// ---------------------------------------------------------------------------
// Real stand-in node processes (same R-22 A behaviour as fault.test.ts)

export function fakeNodeScript(port: number): string {
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

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitUntil(
  fn: () => boolean,
  timeoutMs: number,
  stepMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return fn();
}

export async function rpcReachable(port: number, timeoutMs = 500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, {
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

export async function freePort(): Promise<number> {
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
// Scripted adapter (deterministic mechanism double, overrides 'pause')

export function scriptedAdapter(overrides: Partial<FaultAdapter> = {}): FaultAdapter {
  const now = () => new Date().toISOString();
  return {
    type: 'pause',
    mechanism: 'scripted test double',
    support: { status: 'supported' },
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

// ---------------------------------------------------------------------------
// Harness

export interface RunHarness {
  dir: string;
  store: StateStore;
  events: EventBus;
  injector: FailureInjector;
  scenarios: ScenarioService;
  runs: ScenarioEngine;
  eventLog: Array<{ name: KaizenEventName; payload: unknown }>;
  networkId: string;
  nodeIds: { alice: string; bob: string };
  ports: { alice: number; bob: number };
  /** 'down' forces the observer to report RPC unreachable. */
  observerMode: { value: 'real' | 'down' };
  childPid(node: 'alice' | 'bob'): number | null;
  dispose(): Promise<void>;
}

const harnesses: RunHarness[] = [];

/** Dispose every harness created since the last call (per-suite afterEach). */
export async function disposeHarnesses(): Promise<void> {
  for (const h of harnesses.splice(0)) await h.dispose();
}

export async function makeHarness(
  options: { designatedTest?: boolean; adapters?: FaultAdapter[] } = {},
): Promise<RunHarness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-scrun-'));
  const store = new StateStore(path.join(dir, 'kaizen.db'));
  const events = new EventBus();
  const eventLog: Array<{ name: KaizenEventName; payload: unknown }> = [];
  events.subscribe((name, payload) => {
    eventLog.push({ name, payload });
  });

  const networkId = 'run_net';
  const network: Omit<NetworkRecord, 'updatedAt'> = {
    id: networkId,
    name: 'run-net',
    preset: 'two-node',
    status: 'running',
    designatedTest: options.designatedTest ?? true,
    chain: 'local-spec',
    baseDir: path.join(dir, 'net'),
    createdAt: new Date().toISOString(),
  };
  store.insertNetwork({ ...network, status: 'created' });
  store.updateNetworkStatus(networkId, 'running');

  const portA = await freePort();
  const portB = portA + 4;
  const nodeIds = { alice: `${networkId}-alice`, bob: `${networkId}-bob` };
  const ports = { alice: portA, bob: portB };
  const tracked: ChildProcess[] = [];

  const insertNode = (
    id: string,
    label: string,
    key: 'alice' | 'bob',
    port: number,
  ): void => {
    const baseDir = path.join(dir, label);
    fs.mkdirSync(baseDir, { recursive: true });
    const config: NodeConfig = {
      id,
      networkId,
      name: `run-net-${label}`,
      role: 'validator',
      chain: 'local-spec',
      wellKnownKey: key,
      bootnodes: [],
      baseDir,
      nodeKeyFile: path.join(dir, `${label}.key`),
      logFile: path.join(dir, `${label}.log`),
      ports: { p2p: port + 1, rpc: port, ws: port + 2, prometheus: port + 3 },
      expectedPeers: 1,
    };
    store.insertNode({ config, status: 'running', createdAt: new Date().toISOString() });
  };
  insertNode(nodeIds.alice, 'alice', 'alice', portA);
  insertNode(nodeIds.bob, 'bob', 'bob', portB);

  const spawnFakeNode = async (port: number): Promise<ChildProcess> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const child = spawn(process.execPath, ['-e', fakeNodeScript(port)], { stdio: 'ignore' });
      tracked.push(child);
      if (await waitUntilSyncRpc(port)) return child;
      try {
        if (child.pid) process.kill(child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      await sleep(150);
    }
    throw new Error(`stand-in node could not listen on ${port}`);
  };

  const childA = await spawnFakeNode(portA);
  const childB = await spawnFakeNode(portB);
  store.updateNodeStatus(nodeIds.alice, 'running', childA.pid!, new Date().toISOString());
  store.updateNodeStatus(nodeIds.bob, 'running', childB.pid!, new Date().toISOString());
  fs.writeFileSync(
    pidFileFor(path.join(dir, 'alice')),
    String(childA.pid),
  );
  fs.writeFileSync(
    pidFileFor(path.join(dir, 'bob')),
    String(childB.pid),
  );

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
    }
    store.updateNodeStatus(id, 'stopped', null);
    return { ok: true };
  });
  const startNode = vi.fn(async () => ({ ok: true }));

  const observerMode = { value: 'real' as 'real' | 'down' };
  const realObserver = createRpcObserver({ rpcTimeoutMs: 1_000 });
  const observer: FaultObserver = {
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
  };

  const injector = new FailureInjector({
    store,
    events,
    processes,
    networks: { stopNode, startNode },
    observer,
    adapters: options.adapters ?? [scriptedAdapter()],
    defaultHoldMs: 1_500,
  });
  const scenarios = new ScenarioService({
    store,
    events,
    mechanisms: injector.describeMechanisms(),
  });
  // Monitoring is deliberately inert in unit tests: health-state conditions
  // must then evaluate INCONCLUSIVE (fail-closed), never guessed.
  const monitoring = {
    getLatest: () => undefined,
    snapshotNow: async () => {
      throw new Error('monitoring disabled in the unit harness');
    },
  } as unknown as MonitoringService;
  const runs = new ScenarioEngine({
    store,
    events,
    scenarios,
    faults: injector,
    monitoring,
    observer,
  });

  const h: RunHarness = {
    dir,
    store,
    events,
    injector,
    scenarios,
    runs,
    eventLog,
    networkId,
    nodeIds,
    ports,
    observerMode,
    childPid: (which) => store.tryGetNode(nodeIds[which])?.pid ?? null,
    async dispose() {
      await runs.close();
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
  harnesses.push(h);
  return h;
}

export async function waitUntilSyncRpc(port: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (await rpcReachable(port, 300)) return true;
    await sleep(100);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scenario helpers

/** The baseline every fault step must carry (authoring rule). */
export function faultBaseline(node: string): unknown[] {
  return [reachable(node), processRunning(node)];
}

export function pauseStep(
  id: string,
  opts: {
    node?: string;
    durationMs?: number;
    delayBeforeMs?: number;
    delayAfterMs?: number;
    timeoutMs?: number;
    /** EXTRA preconditions appended after the required baseline. */
    preconditions?: unknown[];
    postconditions?: unknown[];
  } = {},
): Record<string, unknown> {
  const node = opts.node ?? 'alice';
  return {
    id,
    operation: {
      type: 'pause',
      config: {
        node,
        ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
      },
    },
    ...(opts.delayBeforeMs !== undefined ? { delayBeforeMs: opts.delayBeforeMs } : {}),
    ...(opts.delayAfterMs !== undefined ? { delayAfterMs: opts.delayAfterMs } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    preconditions: [...faultBaseline(node), ...(opts.preconditions ?? [])],
    ...(opts.postconditions !== undefined ? { postconditions: opts.postconditions } : {}),
  };
}

export const reachable = (node: string = 'alice', timeoutMs = 2_000) => ({
  kind: 'rpc-reachable',
  node,
  expect: true,
  timeoutMs,
});
export const unreachable = (node: string = 'alice', timeoutMs = 2_000) => ({
  kind: 'rpc-reachable',
  node,
  expect: false,
  timeoutMs,
});
export const processRunning = (node: string = 'alice') => ({
  kind: 'process-state',
  node,
  expect: ['running'],
  timeoutMs: 2_000,
});
export const peersGte = (value: number, timeoutMs = 300) => ({
  kind: 'peers',
  node: 'alice',
  op: 'gte',
  value,
  timeoutMs,
});
export const recoveryVerified = (node: string = 'alice') => ({
  kind: 'recovery-verified',
  node,
  timeoutMs: 2_000,
});

export function scenarioInput(
  name: string,
  steps: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): ScenarioInput {
  return {
    name,
    description: 'scenario engine run test',
    requires: { designatedTest: true, preset: 'two-node' },
    steps,
    ...overrides,
  } as unknown as ScenarioInput;
}

export function defaultRun(
  h: RunHarness,
  scenarioId: string,
  overrides: Record<string, unknown> = {},
): ScenarioRunRecord {
  return h.runs.execute({
    scenarioId,
    networkIdOrName: h.networkId,
    mode: 'execute',
    requestedBy: 'test',
    ...overrides,
  });
}

export function createScenario(
  h: RunHarness,
  name: string,
  steps: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): string {
  return h.scenarios.create(scenarioInput(name, steps, overrides), 'test').id;
}

export function expectThrownCode(fn: () => unknown, code: string): KaizenError {
  try {
    fn();
  } catch (e) {
    expect((e as KaizenError).code).toBe(code);
    return e as KaizenError;
  }
  throw new Error(`expected ${code} to be thrown`);
}

export function runIds(h: RunHarness): Set<string> {
  return new Set(h.runs.list({ limit: 200 }).runs.map((r) => r.id));
}

/**
 * Assert a gate refusal: the call throws `code`, EXACTLY ONE new run record
 * was persisted (the rejected run), and its persisted error optionally
 * matches the fragment. Returns the rejected run for further assertions.
 */
export function expectRunRefusal(
  h: RunHarness,
  fn: () => unknown,
  code: string,
  messageFragment?: string,
): ScenarioRunRecord {
  const before = runIds(h);
  expectThrownCode(fn, code);
  const fresh = h.runs.list({ limit: 200 }).runs.filter((r) => !before.has(r.id));
  expect(fresh).toHaveLength(1);
  const run = h.runs.get(fresh[0]!.id);
  expect(run.state).toBe('rejected');
  if (messageFragment !== undefined) expect(run.error?.message).toContain(messageFragment);
  return run;
}
