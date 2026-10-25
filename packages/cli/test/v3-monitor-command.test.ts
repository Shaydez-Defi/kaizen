/**
 * CLI `kaizen v3 monitor` (plan item 3): read-only node monitoring through a
 * stubbed JSON-RPC fetch (no network).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { buildProgram } from '../src/program';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-monitor-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const hash = (n: number): string => '0x' + n.toString(16).padStart(64, '0');

function stubNode(opts: { down?: boolean } = {}): void {
  let tick = 0;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    if (opts.down) throw new Error('connect ECONNREFUSED');
    const { method, params, id } = JSON.parse(String(init.body)) as { method: string; params: unknown[]; id: number };
    const best = 5_000 + Math.floor(tick++ / 4);
    let result: unknown;
    if (method === 'chain_getBlockHash') result = params.length ? hash(Number(params[0])) : hash(best);
    else if (method === 'chain_getFinalizedHead') result = hash(best - 2);
    else if (method === 'chain_getHeader') result = { number: '0x' + parseInt(String(params[0]), 16).toString(16) };
    else if (method === 'system_health') result = { peers: 2, isSyncing: false, shouldHavePeers: true };
    else if (method === 'system_chain') result = 'PortaldotV3 Test';
    else return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { message: 'unknown' } }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
}

/** exitOverride must cover subcommands (they are created inside buildProgram,
 *  before a root-level exitOverride() call could propagate). */
function enableExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) enableExitOverride(sub);
}

async function runCli(argv: string[]): Promise<CliResult> {
  const program = buildProgram();
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
  const outWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  const errWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
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

describe('kaizen v3 monitor', () => {
  it('samples a node, prints a summary, verifies, and writes the report', async () => {
    stubNode();
    const out = path.join(dir, 'report.json');
    const r = await runCli(['v3', 'monitor', '--samples', '3', '--interval', '0', '--verify', '--out', out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('PortaldotV3 Test');
    expect(r.stdout).toContain('finality lag');
    expect(r.stdout).toContain('verification    : verified');
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(report.samples).toHaveLength(3);
    expect(report.summary.okSamples).toBe(3);
    expect(report.verification.status).toBe('verified');
  });

  it('--json emits the report; an unreachable node is reported, not hidden', async () => {
    stubNode({ down: true });
    const r = await runCli(['--json', 'v3', 'monitor', '--samples', '2', '--interval', '0']);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    expect(body.report.summary.verdict).toBe('unreachable');
    expect(body.report.samples[0].ok).toBe(false);
  });

  it('rejects out-of-range sample counts', async () => {
    stubNode();
    const r = await runCli(['--json', 'v3', 'monitor', '--samples', '0']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('INVALID_INPUT');
  });
});
