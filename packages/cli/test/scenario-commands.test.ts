/**
 * CLI scenario/run command tests (T-3.6A).
 *
 * Harness: buildProgram() with a REAL engine over a temp dataDir — the same
 * code path the `kaizen` bin runs (index.ts only wires argv; every command's
 * logic lives in ../src/program.ts). No portaldot binary, no network started,
 * no node process touched: every execute/replay attempt offline is refused by
 * the engine gates, which is exactly the offline assertion that the CLI holds
 * NO second executor and the DEC-008 target gate stays effective.
 *
 * Covered: help surface; scenario file read/parse/validation errors;
 * create/validate/get/list/operations; execute with missing/invalid/ambiguous
 * targets; rejected-run persistence + id surfacing; run list/get incl. failed
 * and rejected runs; --state/limit validation; replay eligibility refusal
 * (provenance is not authorization); cancel of unknown/finished runs; wait
 * timeout honesty (stubbed engine); --json envelopes; exit codes 0/1.
 *
 * Live evidence for execution/replay against a REAL portaldot network lives
 * in test/integration/cli-scenario.int.test.ts (KAIZEN_TEST_LIVE=1).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { KaizenError, createEngine, type KaizenEngine } from '@kaizen/engine';
import { buildProgram } from '../src/program';

let dir: string;
let scenarioFile: string;
let invalidScenarioFile: string;
let notJsonFile: string;

/** Fresh engine per invocation — mirrors the real bin (open → act → close). */
function engineFactory(): KaizenEngine {
  return createEngine({ dataDir: dir });
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** exitOverride must cover subcommands (they are created inside buildProgram,
 *  before a root-level exitOverride() call could propagate). */
function enableExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) enableExitOverride(sub);
}

async function runCli(
  argv: string[],
  factory: () => KaizenEngine = engineFactory,
): Promise<CliResult> {
  const program = buildProgram({ engineFactory: factory });
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
  // Capture at ALL three levels: commander help/errors (configureOutput —
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

function validScenario(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    description: 'Pause alice briefly and verify recovery',
    tags: ['recovery-drill'],
    requires: { designatedTest: true, preset: 'two-node' },
    steps: [
      {
        id: 'pause-alice',
        operation: { type: 'pause', config: { node: 'alice', durationMs: 10_000 } },
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
    ...overrides,
  };
}

function writeJson(file: string, value: unknown): string {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-cli-'));
  scenarioFile = path.join(dir, 'scenario-valid.json');
  invalidScenarioFile = path.join(dir, 'scenario-invalid.json');
  notJsonFile = path.join(dir, 'scenario-not-json.json');
  writeJson(scenarioFile, validScenario('cli-drill'));
  // designatedTest:false violates the DEC-008 authoring rule → SCENARIO_INVALID
  writeJson(invalidScenarioFile, validScenario('bad-drill', { requires: { designatedTest: false } }));
  fs.writeFileSync(notJsonFile, '{ this is not json');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('kaizen CLI — help & global contract', () => {
  it('root --help lists the scenario and run groups (exit 0)', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('scenario');
    expect(r.stdout).toContain('run');
  });

  it('scenario --help lists authoring subcommands (exit 0)', async () => {
    const r = await runCli(['scenario', '--help']);
    expect(r.code).toBe(0);
    for (const sub of ['list', 'get <id>', 'create <file>', 'validate <file>', 'operations']) {
      expect(r.stdout).toContain(sub);
    }
  });

  it('run --help lists execution/inspection subcommands (exit 0)', async () => {
    const r = await runCli(['run', '--help']);
    expect(r.code).toBe(0);
    // commander renders "[options]" between the name and args in listings.
    for (const sub of ['execute [options] <scenarioId>', 'replay [options] <runId>', 'list [options]', 'get <runId>', 'cancel [options] <runId>']) {
      expect(r.stdout).toContain(sub);
    }
  });

  it('run execute --help declares the REQUIRED explicit --network', async () => {
    const r = await runCli(['run', 'execute', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--network');
    expect(r.stdout).toContain('required');
  });
});

// ---------------------------------------------------------------------------

describe('kaizen CLI — scenario authoring', () => {
  it('creates a valid scenario from a JSON file and reports it in JSON mode', async () => {
    const r = await runCli(['--json', 'scenario', 'create', scenarioFile]);
    expect(r.code).toBe(0);
    const body = json<{ ok: boolean; scenario: { id: string; name: string; validationStatus: string } }>(r);
    expect(body.ok).toBe(true);
    expect(body.scenario.name).toBe('cli-drill');
    expect(body.scenario.validationStatus).toBe('valid');
  });

  it('gets the created scenario by id', async () => {
    const list = json<{ scenarios: Array<{ id: string; name: string }> }>(
      await runCli(['--json', 'scenario', 'list']),
    );
    const created = list.scenarios.find((s) => s.name === 'cli-drill');
    expect(created).toBeDefined();
    const r = await runCli(['--json', 'scenario', 'get', created!.id]);
    expect(r.code).toBe(0);
    const body = json<{ ok: boolean; scenario: { name: string; steps: unknown[] } }>(r);
    expect(body.ok).toBe(true);
    expect(body.scenario.steps).toHaveLength(1);
  });

  it('lists scenarios with a stable envelope (scenarios/malformed/total/limit/offset)', async () => {
    const r = await runCli(['--json', 'scenario', 'list']);
    expect(r.code).toBe(0);
    const body = json<{ ok: boolean; scenarios: unknown[]; malformed: unknown[]; total: number; limit: number; offset: number }>(r);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.scenarios)).toBe(true);
    expect(Array.isArray(body.malformed)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it('filters by tag', async () => {
    const body = json<{ scenarios: Array<{ name: string }> }>(
      await runCli(['--json', 'scenario', 'list', '--tag', 'recovery-drill']),
    );
    expect(body.scenarios.map((s) => s.name)).toContain('cli-drill');
  });

  it('validates WITHOUT saving: valid file → exit 0, ok:true', async () => {
    const r = await runCli(['--json', 'scenario', 'validate', scenarioFile]);
    expect(r.code).toBe(0);
    const body = json<{ ok: boolean; result: { valid: boolean; errorCount: number; stepCount: number } }>(r);
    expect(body.ok).toBe(true);
    expect(body.result.valid).toBe(true);
    expect(body.result.errorCount).toBe(0);
    expect(body.result.stepCount).toBe(1);
  });

  it('validates WITHOUT saving: invalid file → exit 1, ok:false, issues reported', async () => {
    const r = await runCli(['--json', 'scenario', 'validate', invalidScenarioFile]);
    expect(r.code).toBe(1);
    const body = json<{ ok: boolean; result: { valid: boolean; errorCount: number } }>(r);
    expect(body.ok).toBe(false);
    expect(body.result.valid).toBe(false);
    expect(body.result.errorCount).toBeGreaterThan(0);
  });

  it('create of an invalid scenario → exit 1 SCENARIO_INVALID (rules stay effective)', async () => {
    const r = await runCli(['--json', 'scenario', 'create', invalidScenarioFile]);
    expect(r.code).toBe(1);
    const body = json<{ ok: false; error: { code: string } }>(r);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('SCENARIO_INVALID');
  });

  it('create of a malformed JSON file → exit 1 INVALID_INPUT', async () => {
    const r = await runCli(['--json', 'scenario', 'create', notJsonFile]);
    expect(r.code).toBe(1);
    const body = json<{ ok: false; error: { code: string; message: string } }>(r);
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(body.error.message).toContain('not valid JSON');
  });

  it('create of a missing file → exit 1 INVALID_INPUT', async () => {
    const r = await runCli(['--json', 'scenario', 'create', path.join(dir, 'nope.json')]);
    expect(r.code).toBe(1);
    expect(json<{ error: { code: string } }>(r).error.code).toBe('INVALID_INPUT');
  });

  it('duplicate name → exit 1 SCENARIO_ALREADY_EXISTS', async () => {
    const r = await runCli(['--json', 'scenario', 'create', scenarioFile]);
    expect(r.code).toBe(1);
    expect(json<{ error: { code: string } }>(r).error.code).toBe('SCENARIO_ALREADY_EXISTS');
  });

  it('get of an unknown id → exit 1 SCENARIO_NOT_FOUND', async () => {
    const r = await runCli(['--json', 'scenario', 'get', 'ghost']);
    expect(r.code).toBe(1);
    expect(json<{ error: { code: string } }>(r).error.code).toBe('SCENARIO_NOT_FOUND');
  });

  it('rejects an unknown --status value with INVALID_INPUT', async () => {
    const r = await runCli(['--json', 'scenario', 'list', '--status', 'bogus']);
    expect(r.code).toBe(1);
    expect(json<{ error: { code: string } }>(r).error.code).toBe('INVALID_INPUT');
  });

  it('rejects a non-numeric --limit with INVALID_INPUT', async () => {
    const r = await runCli(['--json', 'scenario', 'list', '--limit', 'abc']);
    expect(r.code).toBe(1);
    expect(json<{ error: { code: string } }>(r).error.code).toBe('INVALID_INPUT');
  });

  it('operations lists the registry with support status', async () => {
    const r = await runCli(['--json', 'scenario', 'operations']);
    expect(r.code).toBe(0);
    const body = json<{ ok: boolean; operations: Array<{ type: string; status: string; configFields: string[] }> }>(r);
    expect(body.ok).toBe(true);
    const pause = body.operations.find((op) => op.type === 'pause');
    expect(pause).toBeDefined();
    expect(pause!.status).toBe('supported');
    expect(pause!.configFields).toContain('node');
  });

  it('human mode prints scenario lines (no JSON)', async () => {
    const r = await runCli(['scenario', 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('cli-drill');
    expect(r.stdout.trim().startsWith('{')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('kaizen CLI — run execute (gates intact, rejected runs persisted)', () => {
  it('without --network → commander usage error, exit 1', async () => {
    const list = json<{ scenarios: Array<{ id: string }> }>(
      await runCli(['--json', 'scenario', 'list']),
    );
    const scenarioId = list.scenarios[0]!.id;
    const r = await runCli(['--json', 'run', 'execute', scenarioId]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--network');
  });

  it('unknown target network → exit 1, a rejected run is persisted and its id surfaced', async () => {
    const list = json<{ scenarios: Array<{ id: string }> }>(
      await runCli(['--json', 'scenario', 'list']),
    );
    const scenarioId = list.scenarios.find((s) => s.name === 'cli-drill')!.id;
    const before = json<{ runs: Array<{ state: string }> }>(
      await runCli(['--json', 'run', 'list', '--state', 'rejected']),
    ).runs.length;

    const r = await runCli(['--json', 'run', 'execute', scenarioId, '--network', 'ghost']);
    expect(r.code).toBe(1);
    const body = json<{ ok: boolean; error: { code: string; message: string }; rejectedRunId?: string }>(r);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeTruthy();
    // The CLI surfaces the persisted rejected run honestly (never swallows it).
    expect(body.rejectedRunId).toBeTruthy();

    const after = json<{ runs: Array<{ id: string; state: string; scenarioName: string }> }>(
      await runCli(['--json', 'run', 'list', '--state', 'rejected']),
    );
    expect(after.runs.length).toBe(before + 1);
    const persisted = after.runs.find((run) => run.id === body.rejectedRunId);
    expect(persisted).toBeDefined();
    expect(persisted!.state).toBe('rejected');
    expect(persisted!.scenarioName).toBe('cli-drill');
  });

  it('human mode prints the persisted rejected-run hint', async () => {
    const list = json<{ scenarios: Array<{ id: string }> }>(
      await runCli(['--json', 'scenario', 'list']),
    );
    const scenarioId = list.scenarios.find((s) => s.name === 'cli-drill')!.id;
    const r = await runCli(['run', 'execute', scenarioId, '--network', 'ghost']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/ERROR \[[A-Z_]+\]/);
    expect(r.stderr).toContain('a rejected run was persisted');
    expect(r.stderr).toContain('kaizen run get');
  });

  it('unknown scenario id → exit 1 (structured envelope)', async () => {
    const r = await runCli(['--json', 'run', 'execute', 'ghost-scenario', '--network', 'ghost-net']);
    expect(r.code).toBe(1);
    const body = json<{ ok: boolean; error: { code: string } }>(r);
    expect(body.ok).toBe(false);
  });

  it('rejects a non-numeric --timeout with INVALID_INPUT before executing', async () => {
    const list = json<{ scenarios: Array<{ id: string }> }>(
      await runCli(['--json', 'scenario', 'list']),
    );
    const scenarioId = list.scenarios[0]!.id;
    const r = await runCli(['--json', 'run', 'execute', scenarioId, '--network', 'x', '--timeout', 'soon']);
    expect(r.code).toBe(1);
    expect(json<{ error: { code: string } }>(r).error.code).toBe('INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------

describe('kaizen CLI — run inspection, replay eligibility, cancel', () => {
  it('run get on a rejected run shows state, error, and null provenance', async () => {
    const rejected = json<{ runs: Array<{ id: string }> }>(
      await runCli(['--json', 'run', 'list', '--state', 'rejected']),
    ).runs[0]!;
    const r = await runCli(['--json', 'run', 'get', rejected.id]);
    expect(r.code).toBe(0);
    const body = json<{
      ok: boolean;
      run: { id: string; state: string; replayOfRunId: string | null; error: { code: string } | null };
      replayNote: string | null;
      replays: unknown[];
    }>(r);
    expect(body.ok).toBe(true);
    expect(body.run.state).toBe('rejected');
    expect(body.run.replayOfRunId).toBeNull();
    expect(body.run.error).not.toBeNull();
    expect(body.replayNote).toBeNull();
    expect(body.replays).toEqual([]);
  });

  it('run get of an unknown id → exit 1 SCENARIO_RUN_NOT_FOUND', async () => {
    const r = await runCli(['--json', 'run', 'get', 'ghost-run']);
    expect(r.code).toBe(1);
    expect(json<{ error: { code: string } }>(r).error.code).toBe('SCENARIO_RUN_NOT_FOUND');
  });

  it('replays of a non-replayed run: --replay-of query returns an empty set', async () => {
    const rejected = json<{ runs: Array<{ id: string }> }>(
      await runCli(['--json', 'run', 'list', '--state', 'rejected']),
    ).runs[0]!;
    const r = await runCli(['--json', 'run', 'list', '--replay-of', rejected.id]);
    expect(r.code).toBe(0);
    const body = json<{ ok: boolean; runs: unknown[] }>(r);
    expect(body.runs).toEqual([]);
  });

  it('replay of a rejected source → exit 1 (provenance is NOT authorization)', async () => {
    const rejected = json<{ runs: Array<{ id: string }> }>(
      await runCli(['--json', 'run', 'list', '--state', 'rejected']),
    ).runs[0]!;
    const r = await runCli(['--json', 'run', 'replay', rejected.id, '--network', 'ghost']);
    expect(r.code).toBe(1);
    const body = json<{ ok: boolean; error: { code: string }; rejectedRunId?: string }>(r);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('SCENARIO_RUN_NOT_REPLAYABLE');
    // No new run was created for an ineligible source → no id mis-attribution.
    expect(body.rejectedRunId).toBeUndefined();
  });

  it('replay without --network → commander usage error, exit 1', async () => {
    const r = await runCli(['run', 'replay', 'some-run']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--network');
  });

  it('replay with a non-numeric --timeout → INVALID_INPUT', async () => {
    const r = await runCli(['--json', 'run', 'replay', 'some-run', '--network', 'x', '--timeout', 'soon']);
    expect(r.code).toBe(1);
    expect(json<{ error: { code: string } }>(r).error.code).toBe('INVALID_INPUT');
  });

  it('run list rejects an unknown --state value (valid states listed)', async () => {
    const r = await runCli(['--json', 'run', 'list', '--state', 'bogus']);
    expect(r.code).toBe(1);
    const body = json<{ error: { code: string; message: string } }>(r);
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(body.error.message).toContain('rejected'); // valid states enumerated
  });

  it('cancel of an unknown run → exit 1 SCENARIO_RUN_NOT_FOUND', async () => {
    const r = await runCli(['--json', 'run', 'cancel', 'ghost-run']);
    expect(r.code).toBe(1);
    expect(json<{ error: { code: string } }>(r).error.code).toBe('SCENARIO_RUN_NOT_FOUND');
  });

  it('cancel of an already-finished run → exit 1 SCENARIO_RUN_CONFLICT', async () => {
    const rejected = json<{ runs: Array<{ id: string }> }>(
      await runCli(['--json', 'run', 'list', '--state', 'rejected']),
    ).runs[0]!;
    const r = await runCli(['--json', 'run', 'cancel', rejected.id]);
    expect(r.code).toBe(1);
    expect(json<{ error: { code: string } }>(r).error.code).toBe('SCENARIO_RUN_CONFLICT');
  });
});

// ---------------------------------------------------------------------------

describe('kaizen CLI — run cancel durability honesty (stubbed engine)', () => {
  it('cancel of a run that stops: exit 0 with the terminal record', async () => {
    const stubFactory = () =>
      ({
        scenarioRuns: {
          cancel: async () => ({
            id: 'run-y',
            state: 'cancelled',
            replayOfRunId: null,
            cancellation: { requestedBy: 'cli', requestedAt: '2026-10-20T00:00:00.000Z' },
          }),
          get: () => ({ id: 'run-y', state: 'cancelled', replayOfRunId: null }),
        },
        close: async () => {},
      }) as unknown as KaizenEngine;

    const r = await runCli(['--json', 'run', 'cancel', 'run-y'], stubFactory);
    expect(r.code).toBe(0);
    const body = json<{ ok: boolean; run: { state: string } }>(r);
    expect(body.ok).toBe(true);
    expect(body.run.state).toBe('cancelled');
  });

  it('cancel nobody observed (no executing process): reported as a timeout, never success', async () => {
    const stubFactory = () =>
      ({
        scenarioRuns: {
          cancel: async () => ({
            id: 'run-orphan',
            state: 'cancel-requested',
            replayOfRunId: null,
            cancellation: { requestedBy: 'cli', requestedAt: '2026-10-20T00:00:00.000Z' },
          }),
          get: () => ({
            id: 'run-orphan',
            state: 'cancel-requested',
            replayOfRunId: null,
            cancellation: { requestedBy: 'cli', requestedAt: '2026-10-20T00:00:00.000Z' },
          }),
        },
        close: async () => {},
      }) as unknown as KaizenEngine;

    const r = await runCli(['--json', 'run', 'cancel', 'run-orphan', '--timeout', '50'], stubFactory);
    expect(r.code).toBe(1);
    const body = json<{ ok: boolean; error: { code: string; message: string } }>(r);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('OPERATION_TIMEOUT');
    expect(body.error.message).toContain('recorded but the run did not stop');
    expect(body.error.message).toContain('orphaned by a crashed process');
  });
});

// ---------------------------------------------------------------------------

describe('kaizen CLI — wait-timeout honesty (stubbed engine, no real run)', () => {
  it('reports a still-running run honestly on wait timeout (exit 1, never success)', async () => {
    const runningRecord = {
      id: 'run-timeout',
      state: 'running',
    };
    const stubFactory = () =>
      ({
        scenarioRuns: {
          execute: () => runningRecord,
          wait: () =>
            new Promise((_resolve, reject) =>
              setTimeout(() => reject(new KaizenError('OPERATION_TIMEOUT', 'wait timed out')), 5),
            ),
          get: () => runningRecord,
        },
        close: async () => {},
      }) as unknown as KaizenEngine;

    const r = await runCli(
      ['--json', 'run', 'execute', 'any-scenario', '--network', 'any-net', '--timeout', '50'],
      stubFactory,
    );
    expect(r.code).toBe(1);
    const body = json<{ ok: boolean; error: { code: string; message: string; details?: { state?: string } } }>(r);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('OPERATION_TIMEOUT');
    expect(body.error.message).toContain('did not reach a terminal state');
    expect(body.error.message).toContain('the run keeps executing');
    expect(body.error.details?.state).toBe('running');
  });
});
