/**
 * LIVE test — T-3.6A CLI scenario/run commands against a REAL portaldot network.
 *
 * Drives the SAME program the `kaizen` bin runs (buildProgram from
 * packages/cli/src) with a fresh engine per command over the shared dataDir —
 * exactly the production pathway (DEC-002: in-process engine, one executor,
 * no second execution path in the CLI). Uses only disposable, Kaizen-created
 * networks (designatedTest — DEC-008).
 *
 * Evidence discipline: every execution claim is backed by an INDEPENDENT
 * observation from the test itself (own RPC polling + process identity),
 * not just the CLI's printed run record:
 *
 *  - execute:  a real pause run completes through the CLI; the victim is
 *              reachable again with the SAME pid and a moving chain head
 *              afterwards (independently observed around the run)
 *  - replay:   a NEW run replays the recorded actions via the CLI, carries
 *              provenance (replayOfRunId + honesty note), created a DISTINCT
 *              fault, and the node is healthy again afterwards
 *  - cancel:   the in-flight execute runs in a REAL child process; `run
 *              cancel` (a separate process over the same dataDir) interrupts
 *              the hold; the child honestly reports the cancelled outcome and
 *              the node returns with the SAME pid
 *  - gates:    invalid targets are refused, rejected runs are persisted and
 *              surfaced by id, ineligible replay sources are refused
 *
 * Offline coverage (parsing/help/JSON/exit codes/timeout honesty) lives in
 * packages/cli/test/scenario-commands.test.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import {
  createEngine,
  isPidAlive,
  scenarioRunReplayNote,
  type KaizenEngine,
  type ScenarioRunRecord,
} from '@kaizen/engine';
import { buildProgram } from '../../packages/cli/src/program';
import { LIVE, SHARED_BIN_CACHE, ensureSharedBinary, httpRpc, testRoot, waitFor } from './testkit';

const SUCCESS = ['completed', 'completed-with-warnings'];

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let dir: string;

/** Fresh engine per command — mirrors the real `kaizen` bin over one dataDir. */
function engineFactory(): KaizenEngine {
  return createEngine({ dataDir: dir });
}

function enableExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) enableExitOverride(sub);
}

async function runCli(argv: string[]): Promise<CliResult> {
  const program = buildProgram({ engineFactory });
  let out = '';
  let err = '';
  enableExitOverride(program);
  program.configureOutput({
    writeOut: (str) => {
      out += str;
    },
    writeErr: (str) => {
      err += str;
    },
  });
  // Capture at all three levels: commander help/errors (configureOutput —
  // subcommands do not inherit it after buildProgram), human-mode
  // console.log/error, and printJson's direct process.stdout.write.
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out += `${args.join(' ')}\n`;
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err += `${args.join(' ')}\n`;
  });
  const outWriteSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
  const errWriteSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      err += String(chunk);
      return true;
    });
  const savedExit = process.exitCode;
  process.exitCode = undefined;
  let code = 0;
  try {
    await program.parseAsync(['node', 'kaizen', ...argv]);
    code = process.exitCode ?? 0;
  } catch (e) {
    const exitCode = (e as { exitCode?: number }).exitCode;
    code = typeof exitCode === 'number' ? exitCode : 1;
  } finally {
    process.exitCode = savedExit;
    logSpy.mockRestore();
    errSpy.mockRestore();
    outWriteSpy.mockRestore();
    errWriteSpy.mockRestore();
  }
  return { code, stdout: out, stderr: err };
}

function json<T = Record<string, unknown>>(result: CliResult): T {
  return JSON.parse(result.stdout) as T;
}

// ---------------------------------------------------------------------------
// Real cross-process CLI invocation.
//
// The bg `run execute` in the cancel test runs as a REAL child process (the
// built bin over the same dataDir): that is genuine cross-process cancellation
// (owner process ≠ cancelling process) AND it avoids sharing the harness's
// global spies (console.*/process.stdout.write/process.exitCode) with a
// concurrent in-process invocation — in-process runCli calls are strictly
// sequential by design.
const CLI_ENTRY = fileURLToPath(new URL('../../packages/cli/dist/index.js', import.meta.url));
let cliChild: ChildProcess | undefined;

function runCliChild(argv: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...argv], {
      env: { ...process.env, KAIZEN_DATA_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cliChild = child;
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      cliChild = undefined;
      resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}

function pauseScenario(name: string, durationMs: number): Record<string, unknown> {
  return {
    name,
    description: 'Pause alice briefly and verify recovery (CLI live drill)',
    tags: ['recovery-drill', 'cli'],
    requires: { designatedTest: true, preset: 'two-node' },
    steps: [
      {
        id: 'pause-alice',
        operation: { type: 'pause', config: { node: 'alice', durationMs } },
        timeoutMs: 120_000,
        preconditions: [
          { kind: 'rpc-reachable', node: 'alice', expect: true },
          { kind: 'process-state', node: 'alice', expect: ['running'] },
        ],
        postconditions: [
          { kind: 'recovery-verified', node: 'alice' },
          { kind: 'rpc-reachable', node: 'alice', expect: true },
        ],
      },
    ],
  };
}

function writeScenario(name: string, durationMs: number): string {
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(pauseScenario(name, durationMs), null, 2));
  return file;
}

async function headNumber(port: number): Promise<number> {
  const header = await httpRpc<{ number: string }>(port, 'chain_getHeader');
  return Number.parseInt(header.number, 16);
}

async function rpcReachable(port: number): Promise<boolean> {
  try {
    await httpRpc(port, 'system_health', [], 1_500);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(LIVE)('kaizen CLI — scenario/run commands (live, real network)', () => {
  let engine: KaizenEngine;
  let netId: string;
  let netName: string;
  let aliceId: string;
  let alicePort: number;
  let alicePid: number | null;
  let drillFile: string;
  let cancelFile: string;
  let drillScenarioId: string;
  let sourceRunId: string;

  /** Fresh pid read from the store — the authoritative process identity. */
  function currentAlicePid(): number | null {
    return engine.store.getNode(aliceId).pid ?? null;
  }

  beforeAll(async () => {
    await ensureSharedBinary();
    dir = testRoot('cli-scenario');
    engine = createEngine({
      dataDir: dir,
      binaryCacheDir: SHARED_BIN_CACHE,
      healthTimeoutMs: 120_000,
    });

    const net = await engine.networks.create({ name: 'scen-cli', preset: 'two-node' });
    expect(net.designatedTest).toBe(true); // the DEC-008 gate basis
    netId = net.id;
    netName = net.name;
    const { nodes } = engine.networks.getNetwork(netId);
    alicePort = nodes[0]!.ports.rpc;
    aliceId = nodes[0]!.id;

    const start = await engine.networks.start(netId);
    expect(start.ok).toBe(true);

    alicePid = currentAlicePid();
    expect(alicePid).toBeTruthy();
    await waitFor(async () => (await rpcReachable(alicePort)) || null, {
      timeoutMs: 90_000,
      label: 'alice RPC reachable',
    });

    drillFile = writeScenario('cli-drill', 6_000);
    cancelFile = writeScenario('cli-cancel-drill', 60_000);
  }, 300_000);

  afterAll(async () => {
    try {
      // Never leave a CLI child (and its in-flight run) behind on failure.
      if (cliChild && cliChild.exitCode === null) cliChild.kill('SIGKILL');
      const net = engine.networks.list().find((n) => n.id === netId);
      if (net && (net.status === 'running' || net.status === 'starting')) {
        await engine.networks.stop(netId);
      }
    } finally {
      await engine.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('authoring via CLI: validate (no save), create, get, list, operations', async () => {
    // validate never saves anything
    const validate = await runCli(['--json', 'scenario', 'validate', drillFile]);
    expect(validate.code).toBe(0);
    expect(json<{ result: { valid: boolean } }>(validate).result.valid).toBe(true);
    const before = json<{ total: number }>(await runCli(['--json', 'scenario', 'list'])).total;

    const created = json<{ ok: boolean; scenario: { id: string; name: string; validationStatus: string } }>(
      await runCli(['--json', 'scenario', 'create', drillFile]),
    );
    expect(created.ok).toBe(true);
    expect(created.scenario.name).toBe('cli-drill');
    expect(created.scenario.validationStatus).toBe('valid');
    drillScenarioId = created.scenario.id;

    const after = json<{ total: number }>(await runCli(['--json', 'scenario', 'list'])).total;
    expect(after).toBe(before + 1);

    const fetched = json<{ scenario: { id: string; steps: unknown[] } }>(
      await runCli(['--json', 'scenario', 'get', drillScenarioId]),
    );
    expect(fetched.scenario.id).toBe(drillScenarioId);
    expect(fetched.scenario.steps).toHaveLength(1);

    const ops = json<{ operations: Array<{ type: string; status: string }> }>(
      await runCli(['--json', 'scenario', 'operations']),
    );
    expect(ops.operations.find((op) => op.type === 'pause')?.status).toBe('supported');
  });

  it('executes a real run through the CLI; node healthy again with the SAME pid', async () => {
    const headBefore = await headNumber(alicePort);

    const r = await runCli([
      '--json',
      'run',
      'execute',
      drillScenarioId,
      '--network',
      netName,
      '--timeout',
      '180000',
    ]);
    expect(r.code, `execute stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0);
    const body = json<{ ok: boolean; run: ScenarioRunRecord; replayNote: string | null }>(r);
    expect(body.ok).toBe(true);
    expect(SUCCESS).toContain(body.run.state);
    expect(body.run.scenarioId).toBe(drillScenarioId);
    expect(body.run.replayOfRunId).toBeNull();
    expect(body.replayNote).toBeNull();
    expect(body.run.steps).toHaveLength(1);
    const step = body.run.steps[0]!;
    expect(step.state).toBe('completed');
    expect(step.faultType).toBe('pause');
    expect(step.faultId).toBeTruthy();
    sourceRunId = body.run.id;

    // INDEPENDENT observations around the run: same pid (the CLI/engine never
    // restarted the node), RPC reachable again, chain head moved (it really
    // paused and recovered — not just a record that says so).
    expect(currentAlicePid()).toBe(alicePid);
    expect(isPidAlive(alicePid!)).toBe(true);
    await waitFor(async () => (await rpcReachable(alicePort)) || null, {
      timeoutMs: 30_000,
      label: 'alice RPC back after the run',
    });
    await waitFor(
      async () => ((await headNumber(alicePort)) > headBefore ? true : null),
      { timeoutMs: 30_000, label: 'chain head moved after the run' },
    );

    // Inspection through the CLI: the run is in the history with evidence.
    const listed = json<{ runs: Array<{ id: string; state: string }> }>(
      await runCli(['--json', 'run', 'list', '--scenario', body.run.scenarioId]),
    );
    expect(listed.runs.some((run) => run.id === sourceRunId && SUCCESS.includes(run.state))).toBe(true);

    const fetched = json<{ run: ScenarioRunRecord; replayNote: string | null; replays: unknown[] }>(
      await runCli(['--json', 'run', 'get', sourceRunId]),
    );
    expect(fetched.run.state).toBe(body.run.state);
    expect(fetched.replayNote).toBeNull();
    expect(fetched.replays).toEqual([]);
    expect(fetched.run.steps[0]!.faultId).toBe(step.faultId);
  });

  it('replays a finished run through the CLI with provenance, honesty note, and a DISTINCT fault', async () => {
    const r = await runCli([
      '--json',
      'run',
      'replay',
      sourceRunId,
      '--network',
      netName,
      '--timeout',
      '180000',
    ]);
    expect(r.code, `replay stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0);
    const body = json<{ ok: boolean; run: ScenarioRunRecord; replayNote: string | null }>(r);
    expect(body.ok).toBe(true);
    expect(SUCCESS).toContain(body.run.state);
    expect(body.run.replayOfRunId).toBe(sourceRunId);
    // The existing honesty note rides along on every replayed run.
    expect(scenarioRunReplayNote(body.run)).toContain('NOT guaranteed');
    expect(body.replayNote).toContain('NOT guaranteed');
    // The replay executed REAL recorded actions: a new fault, distinct from
    // the source run's fault id.
    const sourceRun = json<{ run: ScenarioRunRecord }>(
      await runCli(['--json', 'run', 'get', sourceRunId]),
    );
    expect(body.run.steps[0]!.faultId).toBeTruthy();
    expect(body.run.steps[0]!.faultId).not.toBe(sourceRun.run.steps[0]!.faultId);

    // Provenance query through the CLI: exactly the replay of this source.
    const replaysOf = json<{ runs: Array<{ id: string; replayOfRunId: string | null }> }>(
      await runCli(['--json', 'run', 'list', '--replay-of', sourceRunId]),
    );
    expect(replaysOf.runs).toHaveLength(1);
    expect(replaysOf.runs[0]!.id).toBe(body.run.id);
    expect(replaysOf.runs[0]!.replayOfRunId).toBe(sourceRunId);

    // Source-run immutability: the source still reports no replay provenance.
    const sourceAfter = json<{ run: ScenarioRunRecord; replays: Array<{ id: string }> }>(
      await runCli(['--json', 'run', 'get', sourceRunId]),
    );
    expect(sourceAfter.run.replayOfRunId).toBeNull();
    expect(sourceAfter.replays.map((run) => run.id)).toContain(body.run.id);

    // INDEPENDENT: node healthy again with the SAME pid after the replay.
    expect(currentAlicePid()).toBe(alicePid);
    await waitFor(async () => (await rpcReachable(alicePort)) || null, {
      timeoutMs: 30_000,
      label: 'alice RPC back after the replay',
    });
  });

  it('cancels a real in-flight CLI run; the hold is interrupted and the node returns', async () => {
    const created = json<{ scenario: { id: string } }>(
      await runCli(['--json', 'scenario', 'create', cancelFile]),
    );

    // Start the long drill in a REAL child process (the CLI waits for
    // terminal state; we cancel while it is executing). A separate process
    // makes this genuine cross-process cancellation: the run's owner and the
    // cancelling engine are different processes over the same dataDir.
    const executing = runCliChild([
      '--json',
      'run',
      'execute',
      created.scenario.id,
      '--network',
      netName,
      '--timeout',
      '180000',
    ]);

    // Poll the run history until the run is active, then cancel THROUGH the CLI.
    const active = await waitFor(
      async () => {
        const page = json<{ runs: Array<{ id: string; state: string }> }>(
          await runCli([
            '--json',
            'run',
            'list',
            '--scenario',
            created.scenario.id,
            '--state',
            'running',
          ]),
        );
        return page.runs[0] ?? null;
      },
      { timeoutMs: 60_000, intervalMs: 1_000, label: 'CLI run reaches running state' },
    );

    const cancelled = await runCli(['--json', 'run', 'cancel', active.id]);
    expect(cancelled.code, `cancel stdout: ${cancelled.stdout}\nstderr: ${cancelled.stderr}`).toBe(0);
    const cancelBody = json<{ run: ScenarioRunRecord }>(cancelled);
    expect(cancelBody.run.id).toBe(active.id);
    expect(cancelBody.run.cancellation?.requestedBy).toBe('cli');

    // The background execute command honestly reports the cancelled outcome
    // (exit 1: a cancelled run is NOT a success).
    const execResult = await executing;
    expect(execResult.code, `exec stdout: ${execResult.stdout}\nstderr: ${execResult.stderr}`).toBe(1);
    const execBody = json<{ ok: boolean; run: ScenarioRunRecord }>(execResult);
    expect(execBody.ok).toBe(false);
    expect(execBody.run.state).toBe('cancelled');
    expect(execBody.run.cancellation?.requestedBy).toBe('cli');

    // INDEPENDENT rollback observation: same pid, RPC reachable again.
    expect(currentAlicePid()).toBe(alicePid);
    expect(isPidAlive(alicePid!)).toBe(true);
    await waitFor(async () => (await rpcReachable(alicePort)) || null, {
      timeoutMs: 60_000,
      label: 'alice RPC back after cancellation',
    });

    // Terminal-run refusals: cancelling an already-finished run is a conflict.
    const again = await runCli(['--json', 'run', 'cancel', active.id]);
    expect(again.code).toBe(1);
    expect(json<{ error: { code: string } }>(again).error.code).toBe('SCENARIO_RUN_CONFLICT');
  });

  it('gate refusals through the CLI: rejected runs are persisted, surfaced, and inspectable', async () => {
    // Unknown target network → refused; a rejected run persists; its id is surfaced.
    const refused = await runCli([
      '--json',
      'run',
      'execute',
      drillScenarioId,
      '--network',
      'ghost-net',
    ]);
    expect(refused.code).toBe(1);
    const refusedBody = json<{ ok: boolean; rejectedRunId?: string }>(refused);
    expect(refusedBody.ok).toBe(false);
    expect(refusedBody.rejectedRunId).toBeTruthy();

    const rejected = json<{ run: ScenarioRunRecord }>(
      await runCli(['--json', 'run', 'get', refusedBody.rejectedRunId!]),
    );
    expect(rejected.run.state).toBe('rejected');
    expect(rejected.run.error).not.toBeNull();

    // Replays of the rejected source: none (it never executed anything).
    const replaysOf = json<{ runs: unknown[] }>(
      await runCli(['--json', 'run', 'list', '--replay-of', refusedBody.rejectedRunId!]),
    );
    expect(replaysOf.runs).toEqual([]);

    // Replaying a rejected source is refused (provenance is not authorization)
    // and creates NO new run.
    const beforeCount = json<{ total: number }>(await runCli(['--json', 'run', 'list'])).total;
    const replayRejected = await runCli([
      '--json',
      'run',
      'replay',
      refusedBody.rejectedRunId!,
      '--network',
      netName,
    ]);
    expect(replayRejected.code).toBe(1);
    const replayBody = json<{ error: { code: string }; rejectedRunId?: string }>(replayRejected);
    expect(replayBody.error.code).toBe('SCENARIO_RUN_NOT_REPLAYABLE');
    expect(replayBody.rejectedRunId).toBeUndefined();
    const afterCount = json<{ total: number }>(await runCli(['--json', 'run', 'list'])).total;
    expect(afterCount).toBe(beforeCount);

    // Missing explicit target → usage error before anything is executed.
    const missingTarget = await runCli(['--json', 'run', 'execute', drillScenarioId]);
    expect(missingTarget.code).toBe(1);

    // Unknown run ids → structured NOT_FOUND.
    const unknownRun = await runCli(['--json', 'run', 'get', 'ghost-run']);
    expect(unknownRun.code).toBe(1);
    expect(json<{ error: { code: string } }>(unknownRun).error.code).toBe('SCENARIO_RUN_NOT_FOUND');

    // Human-mode gate refusal names the persisted rejected run.
    const human = await runCli(['run', 'execute', drillScenarioId, '--network', 'ghost-net']);
    expect(human.code).toBe(1);
    expect(human.stderr).toMatch(/ERROR \[[A-Z_]+\]/);
    expect(human.stderr).toContain('a rejected run was persisted');
  });
});
