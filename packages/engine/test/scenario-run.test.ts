/**
 * ScenarioEngine unit tests (T-3.4, Phase 3D).
 *
 * These use REAL stand-in node processes (the same tiny local HTTP RPC
 * server pattern as fault.test.ts) so process identity, pause semantics, and
 * RPC reachability are genuinely exercised; the mechanism itself runs
 * through scripted FaultAdapter doubles for deterministic failure paths.
 * The portaldot_dev end-to-end coverage lives in
 * test/integration/scenario-runs.int.test.ts.
 *
 * Covered: run/step state machines; ordered execution through the injector
 * (no bypass); fresh run-time validation (RSK-28 gate); every pre-execution
 * gate (mode marker, target, DEC-008, labels, capabilities, minNodes,
 * unsupported ops, quarantine, duplicate/concurrent runs, active faults);
 * precondition/postcondition policies incl. inconclusive handling;
 * step/run timeouts; cancellation (before side effects, between steps,
 * during the operation); cleanup-failed quarantine + reconcile;
 * redaction of tampered secrets; persistence across reopen; startup
 * reconciliation (terminalize, never resume); shutdown.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EventBus,
  FailureInjector,
  MonitoringService,
  NodeProcessManager,
  ScenarioEngine,
  ScenarioService,
  StateStore,
  canTransitionRun,
  canTransitionStep,
  createRpcObserver,
  isPidAlive,
  isTerminalScenarioRunState,
  isTerminalScenarioStepState,
  pidFileFor,
  SCENARIO_RUN_STATES,
  SCENARIO_STEP_STATES,
  toRunSummary,
  type FaultAdapter,
  type FaultObserver,
  type FaultRecord,
  type KaizenError,
  type KaizenEventMap,
  type KaizenEventName,
  type NetworkRecord,
  type NodeConfig,
  type ScenarioInput,
  type ScenarioRunRecord,
} from '@kaizen/engine';

// ---------------------------------------------------------------------------
// Real stand-in node processes (same R-22 A behaviour as fault.test.ts)

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

async function rpcReachable(port: number, timeoutMs = 500): Promise<boolean> {
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
// Scripted adapter (deterministic mechanism double, overrides 'pause')

function scriptedAdapter(overrides: Partial<FaultAdapter> = {}): FaultAdapter {
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

interface RunHarness {
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

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function makeHarness(
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

async function waitUntilSyncRpc(port: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (await rpcReachable(port, 300)) return true;
    await sleep(100);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scenario helpers

/** The baseline every fault step must carry (authoring rule). */
function faultBaseline(node: string): unknown[] {
  return [reachable(node), processRunning(node)];
}

function pauseStep(
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

const reachable = (node: string = 'alice', timeoutMs = 2_000) => ({
  kind: 'rpc-reachable',
  node,
  expect: true,
  timeoutMs,
});
const unreachable = (node: string = 'alice', timeoutMs = 2_000) => ({
  kind: 'rpc-reachable',
  node,
  expect: false,
  timeoutMs,
});
const processRunning = (node: string = 'alice') => ({
  kind: 'process-state',
  node,
  expect: ['running'],
  timeoutMs: 2_000,
});
const peersGte = (value: number, timeoutMs = 300) => ({
  kind: 'peers',
  node: 'alice',
  op: 'gte',
  value,
  timeoutMs,
});
const recoveryVerified = (node: string = 'alice') => ({
  kind: 'recovery-verified',
  node,
  timeoutMs: 2_000,
});

function scenarioInput(
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

function defaultRun(
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

function createScenario(
  h: RunHarness,
  name: string,
  steps: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): string {
  return h.scenarios.create(scenarioInput(name, steps, overrides), 'test').id;
}

function expectThrownCode(fn: () => unknown, code: string): KaizenError {
  try {
    fn();
  } catch (e) {
    expect((e as KaizenError).code).toBe(code);
    return e as KaizenError;
  }
  throw new Error(`expected ${code} to be thrown`);
}

function runIds(h: RunHarness): Set<string> {
  return new Set(h.runs.list({ limit: 200 }).runs.map((r) => r.id));
}

/**
 * Assert a gate refusal: the call throws `code`, EXACTLY ONE new run record
 * was persisted (the rejected run), and its persisted error optionally
 * matches the fragment. Returns the rejected run for further assertions.
 */
function expectRunRefusal(
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

function stateEvents(h: RunHarness): Array<{ from: string; to: string }> {
  return h.eventLog
    .filter((e) => e.name === 'scenario-run.state')
    .map((e) => e.payload as KaizenEventMap['scenario-run.state']);
}

// ---------------------------------------------------------------------------
// State machines

describe('ScenarioEngine run/step state machines', () => {
  it('enforces legal run transitions and terminal classification', () => {
    expect(canTransitionRun('queued', 'validating')).toBe(true);
    expect(canTransitionRun('queued', 'rejected')).toBe(true);
    expect(canTransitionRun('validating', 'rejected')).toBe(true);
    expect(canTransitionRun('validating', 'running')).toBe(true);
    expect(canTransitionRun('running', 'waiting')).toBe(true);
    expect(canTransitionRun('running', 'verifying')).toBe(true);
    expect(canTransitionRun('running', 'cancel-requested')).toBe(true);
    expect(canTransitionRun('running', 'cleanup-failed')).toBe(true);
    expect(canTransitionRun('cancel-requested', 'cleaning-up')).toBe(true);
    expect(canTransitionRun('cancel-requested', 'cancelled')).toBe(true);
    expect(canTransitionRun('cleaning-up', 'cleanup-failed')).toBe(true);
    expect(canTransitionRun('cleaning-up', 'completed-with-warnings')).toBe(true);
    expect(canTransitionRun('verifying', 'completed')).toBe(true);

    // illegal: skipping phases, resurrecting terminals
    expect(canTransitionRun('queued', 'running')).toBe(false);
    expect(canTransitionRun('validating', 'completed')).toBe(false);
    expect(canTransitionRun('queued', 'completed')).toBe(false);
    expect(canTransitionRun('rejected', 'running')).toBe(false);
    expect(canTransitionRun('completed', 'running')).toBe(false);
    expect(canTransitionRun('cleanup-failed', 'cancelled')).toBe(false);
    expect(canTransitionRun('cancelled', 'failed')).toBe(false);

    expect(isTerminalScenarioRunState('completed')).toBe(true);
    expect(isTerminalScenarioRunState('completed-with-warnings')).toBe(true);
    expect(isTerminalScenarioRunState('rejected')).toBe(true);
    expect(isTerminalScenarioRunState('cleanup-failed')).toBe(true);
    expect(isTerminalScenarioRunState('running')).toBe(false);
    expect(isTerminalScenarioRunState('cleaning-up')).toBe(false);
    expect([...SCENARIO_RUN_STATES]).toHaveLength(13);
  });

  it('enforces legal step transitions and terminal classification', () => {
    expect(canTransitionStep('pending', 'waiting')).toBe(true);
    expect(canTransitionStep('pending', 'running')).toBe(true);
    expect(canTransitionStep('waiting', 'running')).toBe(true);
    expect(canTransitionStep('running', 'verifying')).toBe(true);
    expect(canTransitionStep('running', 'failed')).toBe(true);
    expect(canTransitionStep('running', 'skipped')).toBe(true);
    expect(canTransitionStep('verifying', 'completed')).toBe(true);
    expect(canTransitionStep('verifying', 'completed-with-warnings')).toBe(true);
    expect(canTransitionStep('running', 'cleaning-up')).toBe(true);
    expect(canTransitionStep('cleaning-up', 'cleanup-failed')).toBe(true);

    expect(canTransitionStep('pending', 'completed')).toBe(false);
    expect(canTransitionStep('waiting', 'verifying')).toBe(false);
    expect(canTransitionStep('verifying', 'running')).toBe(false);
    expect(canTransitionStep('completed', 'failed')).toBe(false);
    expect(canTransitionStep('skipped', 'running')).toBe(false);
    expect(canTransitionStep('cleanup-failed', 'completed')).toBe(false);

    expect(isTerminalScenarioStepState('skipped')).toBe(true);
    expect(isTerminalScenarioStepState('cancelled')).toBe(true);
    expect(isTerminalScenarioStepState('pending')).toBe(false);
    expect([...SCENARIO_STEP_STATES]).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------------
// Execution core

describe('ScenarioEngine execution', () => {
  it('executes steps in declared order through the injector and persists full evidence', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'ordered run', [
      pauseStep('s1', {
        node: 'alice',
        postconditions: [reachable('alice'), recoveryVerified('alice')],
      }),
      pauseStep('s2', {
        node: 'bob',
        postconditions: [reachable('bob'), recoveryVerified('bob')],
      }),
    ]);

    h.eventLog.length = 0; // observe only run-time events
    const started = defaultRun(h, id);
    expect(started.id).toMatch(/^run-/);
    expect(['running', 'waiting']).toContain(started.state);
    // The synchronous part already persisted everything before any side effect.
    expect(started.snapshot.name).toBe('ordered run');
    expect(started.validation?.valid).toBe(true);
    expect(started.targetNodes.map((t) => t.label).sort()).toEqual(['alice', 'bob']);

    const run = await h.runs.wait(started.id, 60_000);
    expect(run.state).toBe('completed');
    expect(run.steps.map((s) => s.state)).toEqual(['completed', 'completed']);
    expect(run.steps.map((s) => s.stepId)).toEqual(['s1', 's2']);
    expect(run.steps[0]!.faultId).toBeTruthy();
    expect(run.steps[1]!.faultId).toBeTruthy();
    expect(run.steps[0]!.faultId).not.toBe(run.steps[1]!.faultId);
    expect(run.steps[0]!.claims).toMatchObject({
      applied: true,
      effectObserved: true,
      faultRemoved: true,
      recovered: true,
      recoveryVerified: true,
    });
    expect(run.steps[0]!.verification).toBe('satisfied');
    expect(run.steps[0]!.preconditions.every((p) => p.verdict === 'satisfied')).toBe(true);
    expect(run.steps[0]!.outcome).toBe('verified');
    expect(run.cleanup).toMatchObject({ verified: true, quarantined: false, activeFaultsFound: 0 });
    expect(run.finishedAt).toBeTruthy();

    // No injector bypass: exactly one executed fault record per fault step.
    const faultRecords = h.store
      .listFaults({ limit: 50 })
      .filter((f) => f.mode === 'execute');
    expect(faultRecords.map((f) => f.id).sort()).toEqual(
      [run.steps[0]!.faultId, run.steps[1]!.faultId].sort(),
    );
    expect(faultRecords.every((f) => f.state === 'cancelled' || f.state === 'completed')).toBe(true);

    // Event ordering: created first, finished last, legal state chain in between.
    const names = h.eventLog.map((e) => e.name);
    expect(names[0]).toBe('scenario-run.created');
    expect(names.at(-1)).toBe('scenario-run.finished');
    expect(names).toContain('scenario-run.verification');
    expect(names).toContain('scenario-run.step');
    const seq = stateEvents(h).map((e) => `${e.from}→${e.to}`);
    expect(seq).toEqual([
      'queued→validating',
      'validating→running',
      'running→verifying',
      'verifying→running',
      'running→verifying',
      'verifying→completed',
    ]);
  }, 60_000);

  it('keeps the run snapshot immutable when the scenario is later edited', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'snapshotted', [
      pauseStep('s1', { postconditions: [recoveryVerified('alice')] }),
    ]);
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(run.state).toBe('completed');

    const record = h.scenarios.get(id);
    h.scenarios.update(id, { description: 'edited after the run' }, 'test');
    expect(h.scenarios.get(id).description).toBe('edited after the run');
    expect(h.runs.get(run.id).snapshot.description).toBe('scenario engine run test');
    expect(h.runs.get(run.id).snapshot.updatedAt).toBe(record.updatedAt);
  }, 60_000);

  it('survives store reopen: runs are durable history', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'durable run', [
      pauseStep('s1', { postconditions: [recoveryVerified('alice')] }),
    ]);
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);

    const reopened = new StateStore(path.join(h.dir, 'kaizen.db'));
    try {
      const loaded = reopened.getScenarioRun(run.id);
      expect(loaded.state).toBe('completed');
      expect(loaded.steps[0]?.claims?.recoveryVerified).toBe(true);
      const page = reopened.listScenarioRuns({ limit: 10 });
      expect(page.runs.map((r) => r.id)).toContain(run.id);
      expect(toRunSummary(loaded).completedSteps).toBe(1);
    } finally {
      reopened.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Pre-execution gates (persisted rejections, nothing executed)

describe('ScenarioEngine pre-execution gates', () => {
  it('requires the explicit mode marker and a known scenario', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'gated', [pauseStep('s1')]);
    expectThrownCode(
      () => h.runs.execute({ scenarioId: id, networkIdOrName: h.networkId }),
      'INVALID_INPUT',
    );
    expectThrownCode(
      () => h.runs.execute({ scenarioId: id, networkIdOrName: h.networkId, mode: 'preview' }),
      'INVALID_INPUT',
    );
    expectThrownCode(
      () => h.runs.execute({ scenarioId: 'ghost', networkIdOrName: h.networkId, mode: 'execute' }),
      'SCENARIO_NOT_FOUND',
    );
    expect(h.runs.list().total).toBe(0);
    expect(h.store.listFaults({ limit: 10 })).toEqual([]);
  });

  it('refuses an unregistered target and persists the rejection', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'unknown target', [pauseStep('s1')]);
    const run = expectRunRefusal(
      h,
      () => h.runs.execute({ scenarioId: id, networkIdOrName: 'ghost-net', mode: 'execute' }),
      'NETWORK_NOT_FOUND',
      'is not registered',
    );
    expect(run.error?.code).toBe('TARGET_UNRESOLVED');
    expect(run.validation?.valid).toBe(true);
  });

  it('refuses blocked/planned operations even when authoring accepted them as warnings', async () => {
    const h = await makeHarness();
    const input = scenarioInput('planned op', [
      {
        id: 's1',
        operation: { type: 'node-restart', config: { node: 'alice' } },
        preconditions: [processRunning('alice')],
      },
    ]);
    const record = h.scenarios.create(input, 'test');
    expect(record.validationStatus).toBe('warning'); // representable, honestly non-executable

    const run = expectRunRefusal(
      h,
      () => defaultRun(h, record.id),
      'SCENARIO_EXEC_NOT_ALLOWED',
      'node-restart',
    );
    expect(run.error?.code).toBe('UNSUPPORTED_OPERATION');
    expect(h.store.listFaults({ limit: 10 })).toEqual([]);
  });

  it('refuses unresolved topology labels, unverifiable capabilities, and unmet minNodes', async () => {
    const h = await makeHarness();
    const ghostId = h.scenarios.create(
      {
        name: 'ghost label',
        requires: { designatedTest: true },
        steps: [pauseStep('s1', { node: 'ghost' as 'alice' })],
      } as unknown as ScenarioInput,
      'test',
    ).id;
    expectRunRefusal(h, () => defaultRun(h, ghostId), 'SCENARIO_EXEC_NOT_ALLOWED', 'do not resolve');

    const capId = h.scenarios.create(
      scenarioInput('needs reserved-only', [pauseStep('s1')], {
        requires: {
          designatedTest: true,
          preset: 'two-node',
          capabilities: ['reserved-only-topology'],
        },
      }),
      'test',
    ).id;
    expectRunRefusal(h, () => defaultRun(h, capId), 'SCENARIO_EXEC_NOT_ALLOWED', 'cannot be verified');

    const minId = h.scenarios.create(
      scenarioInput('needs four nodes', [pauseStep('s1')], {
        requires: { designatedTest: true, preset: 'two-node', minNodes: 4 },
      }),
      'test',
    ).id;
    expectRunRefusal(h, () => defaultRun(h, minId), 'SCENARIO_EXEC_NOT_ALLOWED', 'requires at least 4');

    expect(h.runs.list().total).toBe(3);
    expect(h.runs.list().runs.every((r) => r.state === 'rejected')).toBe(true);
  });

  it('refuses preset mismatches with the resolved target', async () => {
    const h = await makeHarness();
    const id = h.scenarios.create(
      scenarioInput('wrong preset', [pauseStep('s1')], {
        requires: { designatedTest: true, preset: 'single-node' },
      }),
      'test',
    ).id;
    expectRunRefusal(h, () => defaultRun(h, id), 'SCENARIO_EXEC_NOT_ALLOWED', 'requires preset');
  });

  it('revalidates the STORED definition with fresh reads (RSK-28)', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'drifted definition', [pauseStep('s1')]);
    // Simulate registry/definition drift: tamper the persisted row directly
    // (below the authoring API) with an out-of-bounds step timeout.
    const record = h.scenarios.get(id);
    const tampered = structuredClone(record);
    tampered.steps[0]!.timeoutMs = 1_000; // < the 5s minimum
    h.store.updateScenario(tampered);

    const run = expectRunRefusal(h, () => defaultRun(h, id), 'SCENARIO_INVALID');
    expect(run.error?.code).toBe('VALIDATION_FAILED');
    expect(run.validation?.valid).toBe(false);
    expect(run.validation?.issues.some((i) => i.code === 'TIMEOUT_OUT_OF_BOUNDS')).toBe(true);
    expect(h.store.listFaults({ limit: 10 })).toEqual([]);
  });

  it('rejects tampered secret-shaped content AND redacts it from the persisted run', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'secret tamper', [pauseStep('s1')]);
    const record = h.scenarios.get(id);
    const tampered = structuredClone(record);
    tampered.description = 'exfiltrated password=hunter2 in description';
    h.store.updateScenario(tampered);

    const run = expectRunRefusal(h, () => defaultRun(h, id), 'SCENARIO_INVALID');
    expect(run.error?.code).toBe('VALIDATION_FAILED');
    // The persisted audit record never stores the secret itself.
    expect(JSON.stringify(run)).not.toContain('hunter2');
    expect(run.snapshot.description).toContain('[redacted]');
    // Event payloads are scalar and secret-free too.
    for (const e of h.eventLog) {
      expect(JSON.stringify(e.payload)).not.toContain('hunter2');
    }
  });

  it('refuses duplicate and concurrent runs against the same target or scenario', async () => {
    const h = await makeHarness();
    const idA = createScenario(h, 'long wait a', [
      pauseStep('s1', { delayBeforeMs: 10_000, preconditions: [processRunning('alice')] }),
    ]);
    const idB = createScenario(h, 'long wait b', [
      pauseStep('s1', { delayBeforeMs: 10_000, preconditions: [processRunning('alice')] }),
    ]);
    const first = defaultRun(h, idA);

    // same scenario AND same target concurrently
    expectRunRefusal(h, () => defaultRun(h, idA), 'SCENARIO_RUN_CONFLICT', 'already active');
    // different scenario, same target
    const conflict = expectRunRefusal(
      h,
      () => defaultRun(h, idB),
      'SCENARIO_RUN_CONFLICT',
      'already active',
    );
    expect(conflict.error?.code).toBe('CONFLICT');

    await h.runs.cancel(first.id, 'test');
    const cancelled = await h.runs.wait(first.id, 15_000);
    expect(cancelled.state).toBe('cancelled');

    // after the first run is terminal the target is free again (the second
    // run starts and sits in its pre-step delay)
    const second = defaultRun(h, idB);
    expect(second.state).toBe('waiting');
    await h.runs.cancel(second.id, 'test');
    await h.runs.wait(second.id, 15_000);
  }, 60_000);

  it('refuses while an injector fault is already active on a target node', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'conflicted with fault', [
      pauseStep('s1', { postconditions: [recoveryVerified('alice')] }),
    ]);
    const faultPromise = h.injector.execute({
      networkIdOrName: h.networkId,
      nodeId: h.nodeIds.alice,
      type: 'pause',
      options: { durationMs: 10_000 },
      requestedBy: 'direct',
    });
    await waitUntil(() => h.injector.activeFaults().length === 1, 5_000, 50);

    expectRunRefusal(
      h,
      () => defaultRun(h, id),
      'SCENARIO_RUN_CONFLICT',
      'is active on target node',
    );

    const active = h.injector.activeFaults()[0]!;
    await h.injector.cancel(active.faultId);
    await faultPromise;
    // and the target is usable again once the fault is rolled back
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(run.state).toBe('completed');
  }, 60_000);

  it('refuses targets with an unreconciled cleanup failure (quarantine)', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'quarantined target', [pauseStep('s1')]);
    const stuck: FaultRecord = {
      id: 'flt_stuck',
      networkId: h.networkId,
      nodeId: h.nodeIds.alice,
      nodeName: 'run-net-alice',
      type: 'pause',
      mode: 'execute',
      state: 'cleanup-failed',
      requestedBy: 'test',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      reconciled: false,
    };
    h.store.insertFault(stuck);
    expectRunRefusal(h, () => defaultRun(h, id), 'SCENARIO_EXEC_NOT_ALLOWED', 'quarantined');
  });
});

// ---------------------------------------------------------------------------
// Preconditions, postconditions, failure policies

describe('ScenarioEngine condition evaluation and failure policies', () => {
  it('skip-step: records the reason, warns, and continues to the next step', async () => {
    const h = await makeHarness();
    const id = createScenario(
      h,
      'skip on precondition',
      [
        pauseStep('s1', { preconditions: [peersGte(999)] }),
        pauseStep('s2', {
          node: 'bob',
          preconditions: [processRunning('bob')],
          postconditions: [recoveryVerified('bob')],
        }),
      ],
      { execution: { onPreconditionFailed: 'skip-step' } },
    );
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(run.state).toBe('completed-with-warnings');
    expect(run.steps[0]!.state).toBe('skipped');
    expect(run.steps[0]!.policyApplied).toBe('onPreconditionFailed=skip-step');
    expect(
      run.steps[0]!.preconditions.find((p) => p.kind === 'peers')!.verdict,
    ).toBe('not-satisfied');
    expect(run.steps[1]!.state).toBe('completed');
    expect(run.warnings.some((w) => w.includes('skipped'))).toBe(true);
    // only step 2 produced a fault
    expect(h.store.listFaults({ limit: 20 }).filter((f) => f.mode === 'execute')).toHaveLength(1);
  }, 60_000);

  it('abort-run: the failing step fails and no later step starts', async () => {
    const h = await makeHarness();
    const id = createScenario(
      h,
      'abort on precondition',
      [
        pauseStep('s1', { preconditions: [peersGte(999)] }),
        pauseStep('s2', { node: 'bob', preconditions: [processRunning('bob')] }),
      ],
      { execution: { onPreconditionFailed: 'abort-run' } },
    );
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(run.state).toBe('failed');
    expect(run.error?.code).toBe('PRECONDITION_FAILED');
    expect(run.steps[0]!.state).toBe('failed');
    expect(run.steps[1]!.state).toBe('pending');
    expect(h.store.listFaults({ limit: 20 }).filter((f) => f.mode === 'execute')).toEqual([]);
  }, 60_000);

  it('cancel-run: the failing precondition cancels the run with cleanup confirmed', async () => {
    const h = await makeHarness();
    const id = createScenario(
      h,
      'cancel on precondition',
      [pauseStep('s1', { preconditions: [peersGte(999)] })],
      { execution: { onPreconditionFailed: 'cancel-run' } },
    );
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(run.state).toBe('cancelled');
    expect(run.cancellation?.requestedBy).toContain('onPreconditionFailed=cancel-run');
    expect(run.cleanup).toMatchObject({ verified: true });
    expect(run.steps[0]!.state).toBe('failed');
  }, 60_000);

  it('treats an inconclusive precondition as a failure (fail-closed), with evidence', async () => {
    const h = await makeHarness();
    const id = createScenario(
      h,
      'inconclusive precondition',
      [
        pauseStep('s1', {
          preconditions: [{ kind: 'health-state', node: 'alice', expect: ['healthy'], timeoutMs: 300 }],
        }),
      ],
      { execution: { onPreconditionFailed: 'abort-run' } },
    );
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(run.state).toBe('failed');
    const health = run.steps[0]!.preconditions.find((p) => p.kind === 'health-state')!;
    expect(health.verdict).toBe('inconclusive');
    expect(health.detail).toContain('monitoring');
  }, 60_000);

  it('postcondition false + continue: run finishes-with-warnings, step failed with evidence', async () => {
    const h = await makeHarness();
    const id = createScenario(
      h,
      'false postcondition continue',
      [pauseStep('s1', { preconditions: [processRunning('alice')], postconditions: [unreachable('alice')] })],
      { execution: { onStepFailed: 'continue' } },
    );
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(run.state).toBe('completed-with-warnings');
    expect(run.steps[0]!.state).toBe('failed');
    expect(run.steps[0]!.verification).toBe('failed');
    expect(run.error).toBeNull();
    expect(run.steps[0]!.error?.code).toBe('VERIFICATION_FAILED');
    expect(run.warnings.some((w) => w.includes('policy continue'))).toBe(true);
  }, 60_000);

  it('postcondition false + abort-run: the run fails', async () => {
    const h = await makeHarness();
    const id = createScenario(
      h,
      'false postcondition abort',
      [pauseStep('s1', { preconditions: [processRunning('alice')], postconditions: [unreachable('alice')] })],
      { execution: { onStepFailed: 'abort-run' } },
    );
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(run.state).toBe('failed');
    expect(run.error?.code).toBe('VERIFICATION_FAILED');
    expect(run.cleanup).toMatchObject({ verified: true });
  }, 60_000);

  it('inconclusive postcondition: warn-and-continue records the gap, never a plain success', async () => {
    const h = await makeHarness();
    const id = createScenario(
      h,
      'inconclusive warn',
      [
        pauseStep('s1', {
          postconditions: [{ kind: 'health-state', node: 'alice', expect: ['healthy'], timeoutMs: 500 }],
        }),
      ],
      { execution: { onVerificationInconclusive: 'warn-and-continue', onStepFailed: 'abort-run' } },
    );
    // monitoring is inert in the unit harness → the health-state postcondition
    // can only ever be INCONCLUSIVE (never guessed)
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(run.state).toBe('completed-with-warnings');
    expect(run.steps[0]!.state).toBe('completed-with-warnings');
    expect(run.steps[0]!.verification).toBe('inconclusive');
    expect(run.steps[0]!.postconditions[0]!.verdict).toBe('inconclusive');
  }, 60_000);

  it('inconclusive postcondition + fail-step: the run fails through the step policy', async () => {
    const h = await makeHarness();
    const id = createScenario(
      h,
      'inconclusive fail-step',
      [
        pauseStep('s1', {
          postconditions: [{ kind: 'health-state', node: 'alice', expect: ['healthy'], timeoutMs: 500 }],
        }),
      ],
      { execution: { onVerificationInconclusive: 'fail-step', onStepFailed: 'abort-run' } },
    );
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(run.state).toBe('failed');
    expect(run.steps[0]!.verification).toBe('inconclusive');
    expect(run.error?.code).toBe('VERIFICATION_FAILED');
  }, 60_000);

  it('no authored postconditions: outcome is completed-with-warnings, never plain completed', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'no postconditions', [
      pauseStep('s1', { preconditions: [processRunning('alice')] }),
    ]);
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(run.state).toBe('completed-with-warnings');
    expect(run.steps[0]!.state).toBe('completed-with-warnings');
    expect(run.steps[0]!.verification).toBe('not-required');
    expect(run.steps[0]!.claims?.recoveryVerified).toBe(true); // injector's independent claim
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Timeouts

describe('ScenarioEngine timeouts', () => {
  it('step budget exhaustion fails the step and the run (onStepTimeout=fail-step)', async () => {
    const h = await makeHarness({
      adapters: [
        scriptedAdapter({
          timeouts: { applyMs: 30_000, verifyEffectMs: 5_000, removeMs: 5_000, verifyRecoveryMs: 5_000 },
          async apply() {
            await sleep(9_000); // longer than the 5s step budget, below the adapter backstop
            return { at: new Date().toISOString(), how: 'slow scripted apply' };
          },
        }),
      ],
    });
    const id = createScenario(
      h,
      'slow step',
      [pauseStep('s1', { timeoutMs: 5_000, preconditions: [processRunning('alice')] })],
      { execution: { onStepTimeout: 'fail-step' } },
    );
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(run.state).toBe('failed');
    expect(run.error?.code).toBe('STEP_TIMEOUT');
    expect(run.steps[0]!.state).toBe('failed');
    expect(run.steps[0]!.policyApplied).toBe('onStepTimeout=fail-step');
    // The fault in flight was interrupted through the supported mechanism.
    const faults = h.store.listFaults({ limit: 10 }).filter((f) => f.mode === 'execute');
    expect(faults.length).toBe(1);
    expect(['cancelled', 'cleanup-failed', 'failed']).toContain(faults[0]!.state);
    // target process untouched
    expect(isPidAlive(h.childPid('alice')!)).toBe(true);
  }, 60_000);

  it('onStepTimeout=cancel-run rolls back and ends the run cancelled', async () => {
    const h = await makeHarness({
      adapters: [
        scriptedAdapter({
          timeouts: { applyMs: 30_000, verifyEffectMs: 5_000, removeMs: 5_000, verifyRecoveryMs: 5_000 },
          async apply() {
            await sleep(9_000);
            return { at: new Date().toISOString(), how: 'slow scripted apply' };
          },
        }),
      ],
    });
    const id = createScenario(
      h,
      'slow step cancel',
      [pauseStep('s1', { timeoutMs: 5_000, preconditions: [processRunning('alice')] })],
      { execution: { onStepTimeout: 'cancel-run' } },
    );
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(run.state).toBe('cancelled');
    expect(run.steps[0]!.error?.code).toBe('STEP_TIMEOUT');
    expect(run.cleanup).toMatchObject({ verified: true });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Cancellation

describe('ScenarioEngine cancellation', () => {
  it('cancels before any side effect: no fault is ever created', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'cancel before side effect', [
      pauseStep('s1', { delayBeforeMs: 30_000, preconditions: [processRunning('alice')] }),
    ]);
    const started = defaultRun(h, id);
    expect(started.state).toBe('waiting');
    const cancelled = await h.runs.cancel(started.id, 'operator');
    expect(cancelled.state).toBe('cancel-requested');
    expect(cancelled.cancellation?.requestedBy).toBe('operator');

    const run = await h.runs.wait(started.id, 15_000);
    expect(run.state).toBe('cancelled');
    expect(run.steps[0]!.state).toBe('cancelled');
    expect(run.steps[0]!.faultId).toBeNull();
    expect(run.cleanup).toMatchObject({ verified: true, activeFaultsFound: 0 });
    expect(h.store.listFaults({ limit: 10 }).filter((f) => f.mode === 'execute')).toEqual([]);
  }, 60_000);

  it('cancels during the operation through injector.cancel: rollback verified, no leak', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'cancel during operation', [
      pauseStep('s1', {
        durationMs: 60_000,
        timeoutMs: 120_000,
        preconditions: [processRunning('alice')],
        postconditions: [recoveryVerified('alice')],
      }),
    ]);
    const started = defaultRun(h, id);
    const hasFault = await waitUntil(() => h.injector.activeFaults().length === 1, 10_000, 50);
    expect(hasFault).toBe(true);
    const pidBefore = h.childPid('alice');

    await h.runs.cancel(started.id, 'operator');
    const run = await h.runs.wait(started.id, 30_000);
    expect(run.state).toBe('cancelled');
    expect(run.steps[0]!.state).toBe('cancelled');
    expect(run.steps[0]!.claims?.recoveryVerified).toBe(true);
    expect(run.cleanup).toMatchObject({ verified: true, quarantined: false });
    expect(h.injector.activeFaults()).toEqual([]);
    // same process, resumed, still alive — a cancelled pause never leaks a
    // stopped process
    expect(h.childPid('alice')).toBe(pidBefore);
    expect(isPidAlive(pidBefore!)).toBe(true);
    expect(await rpcReachable(h.ports.alice, 1_500)).toBe(true);
  }, 60_000);

  it('cancels between steps: later steps never start', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'cancel between steps', [
      pauseStep('s1', {
        node: 'bob',
        delayAfterMs: 30_000,
        preconditions: [processRunning('bob')],
        postconditions: [recoveryVerified('bob')],
      }),
      pauseStep('s2', { node: 'alice', preconditions: [processRunning('alice')] }),
    ]);
    const started = defaultRun(h, id);
    const stepDone = await waitUntil(
      () => h.runs.get(started.id).steps[0]?.state === 'completed',
      20_000,
      100,
    );
    expect(stepDone).toBe(true);

    await h.runs.cancel(started.id, 'operator');
    const run = await h.runs.wait(started.id, 15_000);
    expect(run.state).toBe('cancelled');
    expect(run.steps[0]!.state).toBe('completed');
    expect(run.steps[1]!.state).toBe('pending');
    expect(run.steps[1]!.faultId).toBeNull();
  }, 60_000);

  it('refuses to cancel a finished run', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'finished run', [
      pauseStep('s1', { preconditions: [processRunning('alice')], postconditions: [recoveryVerified('alice')] }),
    ]);
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(run.state).toBe('completed');
    await expect(h.runs.cancel(run.id, 'operator')).rejects.toMatchObject({
      code: 'SCENARIO_RUN_CONFLICT',
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Cleanup failure / quarantine

describe('ScenarioEngine cleanup failure', () => {
  it('quarantines an unconfirmed cleanup, emits a high-severity event, blocks the target, and reconciles only on proof', async () => {
    const h = await makeHarness({
      adapters: [
        scriptedAdapter({
          async verifyRecovery() {
            return {
              verified: false,
              attempts: 3,
              detail: 'scripted: recovery never observed',
              observation: null,
              at: new Date().toISOString(),
            };
          },
        }),
      ],
    });
    const idA = createScenario(h, 'doomed run', [
      pauseStep('s1', { preconditions: [processRunning('alice')] }),
    ]);
    const run = await h.runs.wait(defaultRun(h, idA).id, 60_000);
    expect(run.state).toBe('cleanup-failed');
    expect(run.steps[0]!.state).toBe('cleanup-failed');
    expect(run.steps[0]!.error?.code).toBe('CLEANUP_UNVERIFIED');
    expect(run.cleanup).toMatchObject({ verified: false, quarantined: true });
    // never claims recovery
    expect(run.steps[0]!.claims?.recoveryVerified).toBe(false);

    const severity = h.eventLog.filter((e) => e.name === 'scenario-run.cleanup-failed');
    expect(severity).toHaveLength(1);
    expect(severity[0]!.payload).toMatchObject({ severity: 'high' });

    // The target is quarantined: new runs are refused until reconciled.
    const idB = createScenario(h, 'blocked run', [pauseStep('s1')]);
    expectRunRefusal(h, () => defaultRun(h, idB), 'SCENARIO_EXEC_NOT_ALLOWED', 'quarantined');

    // Reconcile only on fresh proof: the observer sees the node reachable.
    const fault = h.store.listFaults({ limit: 10 }).find((f) => f.mode === 'execute')!;
    expect(fault.state).toBe('cleanup-failed');
    const released = await h.injector.reconcile(fault.id);
    expect(released.reconciled).toBe(true);
    expect(released.state).toBe('cleanup-failed'); // state stays, quarantine released

    // The second run was ALLOWED to execute (quarantine released by proof).
    // With this harness's failing-recovery adapter it also ends cleanup-failed.
    const after = await h.runs.wait(defaultRun(h, idB).id, 60_000);
    expect(after.state).toBe('cleanup-failed');
    expect(
      h.store.listFaults({ limit: 20 }).filter((f) => f.mode === 'execute'),
    ).toHaveLength(2);
  }, 90_000);

  it('keeps the quarantine when reconcile cannot prove the effect is gone', async () => {
    const h = await makeHarness({
      adapters: [
        scriptedAdapter({
          async verifyRecovery() {
            return {
              verified: false,
              attempts: 2,
              detail: 'scripted: recovery never observed',
              observation: null,
              at: new Date().toISOString(),
            };
          },
        }),
      ],
    });
    const id = createScenario(h, 'doomed run 2', [pauseStep('s1')]);
    const run = await h.runs.wait(defaultRun(h, id).id, 60_000);
    expect(run.state).toBe('cleanup-failed');

    const fault = h.store.listFaults({ limit: 10 }).find((f) => f.mode === 'execute')!;
    h.observerMode.value = 'down'; // fresh evidence cannot show the node back
    const still = await h.injector.reconcile(fault.id);
    expect(still.reconciled).toBe(false); // not provably gone → quarantine kept
    expect(h.injector.activeFaults()).toEqual([]);
    expectThrownCode(() => defaultRun(h, id), 'SCENARIO_EXEC_NOT_ALLOWED');
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Startup reconciliation (crash recovery — never resumes)

describe('ScenarioEngine startup reconciliation', () => {
  function craftRunAndFault(
    h: RunHarness,
    opts: {
      runState?: ScenarioRunRecord['state'];
      faultState?: FaultRecord['state'];
      seq?: number;
    },
  ): { runId: string; faultId: string } {
    const now = new Date().toISOString();
    const seq = opts.seq ?? 1;
    const scenario = h.scenarios.create(
      scenarioInput(`crafted ${seq}`, [pauseStep('s1', { preconditions: [processRunning('alice')] })]),
      'test',
    );
    const runId = `run_crafted_${seq}`;
    const faultId = `flt_crafted_${seq}`;
    const run: ScenarioRunRecord = {
      id: runId,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      scenarioSchemaVersion: scenario.schemaVersion,
      snapshot: structuredClone(scenario),
      networkId: h.networkId,
      networkName: 'run-net',
      targetNodes: [{ label: 'alice', nodeId: h.nodeIds.alice, nodeName: 'run-net-alice' }],
      requestedBy: 'test',
      state: opts.runState ?? 'running',
      currentStepId: 's1',
      currentStepOrder: 0,
      steps: [
        {
          stepId: 's1',
          order: 0,
          operationType: 'pause',
          faultType: 'pause',
          nodeLabel: 'alice',
          nodeId: h.nodeIds.alice,
          nodeName: 'run-net-alice',
          state: 'running',
          startedAt: now,
          finishedAt: null,
          preconditions: [],
          postconditions: [],
          verification: 'pending',
          faultId,
          outcome: null,
          claims: null,
          durationMs: null,
          policyApplied: null,
          warnings: [],
          error: null,
        },
      ],
      validation: scenario.validation,
      warnings: [],
      error: null,
      cleanup: null,
      cancellation: null,
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    h.store.insertScenarioRun(run);
    h.store.insertFault({
      id: faultId,
      networkId: h.networkId,
      nodeId: h.nodeIds.alice,
      nodeName: 'run-net-alice',
      type: 'pause',
      mode: 'execute',
      state: opts.faultState ?? 'executing',
      requestedBy: 'test',
      requestedAt: now,
      updatedAt: now,
      reconciled: false,
    });
    return { runId, faultId };
  }

  it('terminalizes interrupted runs and reconciles their stuck faults (never resumes)', async () => {
    const h = await makeHarness();
    const { runId, faultId } = craftRunAndFault(h, {});
    const faultsBefore = h.store.listFaults({ limit: 20 }).length;
    h.eventLog.length = 0;

    const report = await h.runs.reconcileOnStartup();
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]!.runId).toBe(runId);
    expect(report.quarantined).toBe(false);
    const outcome = report.runs[0]!.faults[0]!;
    expect(outcome.faultId).toBe(faultId);
    expect(outcome.released).toBe(true); // observer sees the (still alive) node

    const run = h.store.getScenarioRun(runId);
    expect(run.state).toBe('failed');
    expect(run.error?.code).toBe('INTERRUPTED');
    expect(run.error?.message).toContain('NEVER resumed');
    expect(run.finishedAt).toBeTruthy();

    const fault = h.store.getFault(faultId);
    expect(fault.state).toBe('cleanup-failed');
    expect(fault.reconciled).toBe(true);

    // No resume: no new runs/faults, no created events, steps untouched.
    expect(h.store.listFaults({ limit: 20 }).length).toBe(faultsBefore);
    expect(h.eventLog.filter((e) => e.name === 'scenario-run.created')).toEqual([]);
    expect(h.eventLog.some((e) => e.name === 'fault.state' && (e.payload as { to: string }).to === 'executing')).toBe(false);
    expect(run.steps[0]!.state).toBe('running');

    // Idempotent: reconcileOnStartup caches its promise; a second call over
    // the now-terminal run is the same no-op report.
    expect(await h.runs.reconcileOnStartup()).toBe(report);
    expect(h.store.getScenarioRun(runId).state).toBe('failed');
  }, 60_000);

  it('quarantines when the interrupted fault cannot be proven gone (run → cleanup-failed)', async () => {
    const h = await makeHarness();
    const { runId } = craftRunAndFault(h, {});
    h.observerMode.value = 'down'; // fresh evidence cannot show recovery

    const report = await h.runs.reconcileOnStartup();
    expect(report.quarantined).toBe(true);
    expect(report.runs[0]!.finalState).toBe('cleanup-failed');
    expect(h.store.getScenarioRun(runId).state).toBe('cleanup-failed');

    // The target stays blocked for NEW runs until explicitly reconciled.
    const id = createScenario(h, 'after crash', [pauseStep('s1')]);
    expectThrownCode(() => defaultRun(h, id), 'SCENARIO_EXEC_NOT_ALLOWED');
  }, 60_000);

  it('terminalizes pre-execution interruptions without side effects', async () => {
    const h = await makeHarness();
    const { runId, faultId } = craftRunAndFault(h, { faultState: 'ready' });

    const report = await h.runs.reconcileOnStartup();
    expect(report.quarantined).toBe(false);
    const fault = h.store.getFault(faultId);
    // state=ready proves the mechanism was never applied → cancelled, audited
    expect(fault.state).toBe('cancelled');
    expect(fault.error?.code).toBe('FAULT_INTERRUPTED');
    expect(h.store.getScenarioRun(runId).state).toBe('failed');
  }, 60_000);

  it('terminalizes runs without stuck faults from every unfinished state', async () => {
    const h = await makeHarness();
    const states = ['queued', 'validating', 'waiting', 'verifying', 'cancel-requested'] as const;
    const runIds: string[] = [];
    for (const [i, state] of states.entries()) {
      // fault already terminal → no stuck mechanism, only the run needs a
      // terminal state
      const { runId } = craftRunAndFault(h, {
        runState: state,
        faultState: 'completed',
        seq: i + 1,
      });
      runIds.push(runId);
    }
    const report = await h.runs.reconcileOnStartup();
    expect(report.runs).toHaveLength(states.length);
    expect(report.quarantined).toBe(false);
    for (const [i, outcome] of report.runs.entries()) {
      // legal transition from any unfinished state, never resumed
      expect(outcome.runId).toBe(runIds[i]);
      expect(['failed', 'cleanup-failed']).toContain(outcome.finalState);
      const run = h.store.getScenarioRun(outcome.runId);
      expect(run.error?.code).toBe('INTERRUPTED');
      expect(run.state).toBe(outcome.finalState);
      expect(run.steps[0]!.state).toBe('running'); // untouched, not advanced
    }
    // idempotent across calls
    expect(await h.runs.reconcileOnStartup()).toBe(report);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Shutdown

describe('ScenarioEngine shutdown', () => {
  it('close() cancels active runs through the cleanup path and stops the engine', async () => {
    const h = await makeHarness();
    const id = createScenario(h, 'closing run', [
      pauseStep('s1', { delayBeforeMs: 60_000, preconditions: [processRunning('alice')] }),
    ]);
    const started = defaultRun(h, id);
    expect(started.state).toBe('waiting');

    await h.runs.close();
    const run = h.store.getScenarioRun(started.id);
    expect(run.state).toBe('cancelled');
    expect(run.finishedAt).toBeTruthy();
    expect(h.runs.activeRuns()).toEqual([]);
    expectThrownCode(() => defaultRun(h, id), 'SCENARIO_EXEC_NOT_ALLOWED');
  }, 60_000);
});
