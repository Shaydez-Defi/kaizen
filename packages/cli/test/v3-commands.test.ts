/**
 * CLI `kaizen v3 …` command tests (T-8.2). buildProgram() with a REAL engine
 * over a temp dataDir whose V3AnchorService uses a scripted fake chain (no
 * network). The signer is the public DEV URI `//Alice` (test material).
 * Live evidence: test/integration/v3-anchor.int.test.ts (KAIZEN_TEST_V3_WRITE=1).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import {
  V3AnchorService,
  createEngine,
  type KaizenEngine,
  type ScenarioRunRecord,
  type V3ChainConnector,
  type V3ChainSession,
  type V3TxReceipt,
} from '@kaizen/engine';
import { buildProgram } from '../src/program';

let dir: string;
let signerEnv: NodeJS.ProcessEnv = { KAIZEN_V3_SIGNER_SURI: '//Alice' };

const receipt = (over: Partial<V3TxReceipt> = {}): V3TxReceipt => ({
  txHash: '0x' + '11'.repeat(32),
  blockHash: '0x' + '22'.repeat(32),
  blockNumber: 9,
  extrinsicIndex: 1,
  finalized: true,
  events: ['system.Remarked'],
  logs: [],
  instantiated: null,
  remarkHash: null,
  ...over,
});

const fakeChain: V3ChainConnector = {
  async connect(): Promise<V3ChainSession> {
    return {
      info: async () => ({
        chainName: 'PortaldotV3 Test',
        genesisHash: '0x' + 'd4'.repeat(32),
        specName: 'portaldot-v3',
        specVersion: 3002,
        tokenSymbol: 'tPOT',
        tokenDecimals: 14,
        bestNumber: 1,
      }),
      freeBalance: async () => 123_450_000_000_000_000n,
      evmAddressOf: async () => '0x' + '31'.repeat(20),
      blockHashAt: async () => '0x' + '22'.repeat(32),
      deploymentAt: async () => null,
      remarkAt: async () => null,
      submitRemark: async () => receipt(),
      deployContract: async () => receipt({ instantiated: '0x' + 'ab'.repeat(20) }),
      callContract: async () => receipt(),
      readContract: async () => '0x' + '0'.repeat(64),
      close: async () => undefined,
    };
  },
};

function engineFactory(): KaizenEngine {
  const engine = createEngine({ dataDir: dir });
  engine.v3Anchors = new V3AnchorService({ store: engine.store, events: engine.events, connector: fakeChain, env: signerEnv });
  return engine;
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


beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-cli-v3-'));
  const engine = createEngine({ dataDir: dir });
  const at = '2026-10-21T10:00:00.000Z';
  engine.store.insertScenarioRun({
    id: 'run-done', scenarioId: 'scn', scenarioName: 'pause alice', scenarioSchemaVersion: 1,
    snapshot: { id: 'scn' }, networkId: 'net_1', networkName: 'demo', targetNodes: [], requestedBy: 'test',
    replayOfRunId: null, state: 'completed', currentStepId: null, currentStepOrder: null, steps: [],
    validation: null, warnings: [], error: null, cleanup: null, cancellation: null,
    createdAt: at, startedAt: at, updatedAt: at, finishedAt: at,
  } as unknown as ScenarioRunRecord);
  void engine.close();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('kaizen v3', () => {
  it('lists the v3 subcommands in help', async () => {
    const r = await runCli(['v3', '--help']);
    for (const c of ['probe', 'status', 'deploy-registry', 'import-deployment', 'hash', 'anchor', 'anchors', 'verify']) expect(r.stdout).toContain(c);
  });

  it('shows status with balance and the public address only', async () => {
    const r = await runCli(['v3', 'status']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');
    expect(r.stdout).toContain('1234.5000 tPOT');
    expect(r.stdout + r.stderr).not.toContain('//Alice');
  });

  it('computes the run hash offline', async () => {
    const r = await runCli(['--json', 'v3', 'hash', 'run-done']);
    expect(json(r)).toMatchObject({ ok: true, runId: 'run-done', anchorable: true });
  });

  it('validates --method and refuses without a registry unless remark is chosen', async () => {
    const bad = await runCli(['--json', 'v3', 'anchor', 'run-done', '--method', 'evm']);
    expect(bad.code).toBe(1);
    expect(json<{ error: { code: string } }>(bad).error.code).toBe('INVALID_INPUT');
    const noReg = await runCli(['--json', 'v3', 'anchor', 'run-done']);
    expect(noReg.code).toBe(1);
    expect(json<{ error: { code: string } }>(noReg).error.code).toBe('V3_REGISTRY_NOT_DEPLOYED');
  });

  it('anchors via remark, lists, and verifies with exit codes', async () => {
    const r = await runCli(['v3', 'anchor', 'run-done', '--method', 'remark']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('FINALIZED via remark');
    expect(r.stdout).toContain('#/explorer/query/0x' + '22'.repeat(32));
    const list = json<{ anchors: { id: string }[] }>(await runCli(['--json', 'v3', 'anchors']));
    expect(list.anchors).toHaveLength(1);
    const id = list.anchors[0]?.id ?? '';
    const v = await runCli(['v3', 'verify', id]);
    // fake remarkAt returns null → remark text mismatch → honest non-zero exit
    expect(v.stdout).toContain('MISMATCH');
    expect(v.code).toBe(1);
  });

  it('fails clearly without a signer', async () => {
    signerEnv = {};
    try {
      const r = await runCli(['--json', 'v3', 'anchor', 'run-done', '--method', 'remark']);
      expect(r.code).toBe(1);
      expect(json<{ error: { code: string } }>(r).error.code).toBe('V3_SIGNER_NOT_CONFIGURED');
    } finally {
      signerEnv = { KAIZEN_V3_SIGNER_SURI: '//Alice' };
    }
  });
});
