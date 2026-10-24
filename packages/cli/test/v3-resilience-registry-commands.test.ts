/**
 * CLI on-chain Proof-of-Resilience commands (T-9.8): deploy-resilience-registry /
 * anchor-certificate / resilience-score through the registry DI seam. The
 * registry client is a stub (no chain); the certificate is the real CI one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import {
  KaizenError,
  ResilienceRegistryService,
  type ResilienceAnchorReceipt,
  type ResilienceCertificate,
  type ResilienceChainJournalEntry,
  type ResilienceOnChainRead,
  type ResilienceRegistryDeployment,
} from '@kaizen/engine';
import { buildProgram } from '../src/program';

const CERT = path.resolve(__dirname, '../../../docs/evidence/resilience/certificate-517b2ffb81ec.json');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-res-chain-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const base = {
  chainName: 'PortaldotV3 Test',
  genesisHash: '0x' + 'd4'.repeat(32),
  signerAddress: '5HSwNUrjU8VqBfdjJdmGdEYig96V1uR6qySiKTZF6eoBd32o',
  txHash: '0x' + '11'.repeat(32),
  blockHash: '0x' + '22'.repeat(32),
  blockNumber: 170_000,
  extrinsicIndex: 2,
  finalized: true,
  events: ['system.ExtrinsicSuccess'],
  tokenSymbol: 'tPOT',
  tokenDecimals: 14,
  balanceBefore: '38315000000000000',
  balanceAfter: '29815000000000000',
  spent: '8500000000000000',
};

class StubRegistry extends ResilienceRegistryService {
  seen: { cert?: ResilienceCertificate; score?: number; registry?: string } = {};
  override async deploy(o: { journal?: (e: ResilienceChainJournalEntry) => void } = {}): Promise<ResilienceRegistryDeployment> {
    o.journal?.({ phase: 'submitting' } as ResilienceChainJournalEntry);
    return { ...base, name: 'KaizenResilienceRegistry', address: '0x' + 'ab'.repeat(20), codeHash: '0x' + '99'.repeat(32) };
  }
  override async anchor(cert: ResilienceCertificate, score: number, o: { registry?: string } = {}): Promise<ResilienceAnchorReceipt> {
    this.seen = { cert, score, ...(o.registry !== undefined ? { registry: o.registry } : {}) };
    if (!o.registry) throw new KaizenError('V3_REGISTRY_NOT_DEPLOYED', 'no registry');
    return { ...base, contract: o.registry, fingerprint: cert.fingerprint, validatorId: cert.validatorId, validatorKey: '0x' + '55'.repeat(32), score, evidenceFlags: 3 };
  }
  override async read(validatorId: string): Promise<ResilienceOnChainRead> {
    return { contract: '0x' + 'ab'.repeat(20), validatorId, validatorKey: '0x' + '55'.repeat(32), score: { score: 35, certifiedAt: 1, count: 1 }, latest: null, recorded: true, bestNumber: 9 };
  }
}

/** exitOverride must cover subcommands (they are created inside buildProgram,
 *  before a root-level exitOverride() call could propagate). */
function enableExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) enableExitOverride(sub);
}

async function runCli(argv: string[], registry: ResilienceRegistryService): Promise<CliResult> {
  const program = buildProgram({ resilienceRegistryFactory: () => registry });
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

describe('kaizen v3 resilience registry commands', () => {
  it('deploy-resilience-registry prints the address and writes the journal', async () => {
    const journal = path.join(dir, 'journal.jsonl');
    const r = await runCli(['v3', 'deploy-resilience-registry', '--journal', journal], new StubRegistry());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('KaizenResilienceRegistry deployed at 0x' + 'ab'.repeat(20));
    expect(r.stdout).toContain('spent   : 85.0000 tPOT');
    expect(fs.readFileSync(journal, 'utf8')).toContain('"submitting"');
  });

  it('anchor-certificate reads the certificate file and passes score + registry', async () => {
    const stub = new StubRegistry();
    const r = await runCli(['--json', 'v3', 'anchor-certificate', CERT, '--score', '35', '--registry', '0x' + 'ab'.repeat(20)], stub);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).anchor.score).toBe(35);
    expect(stub.seen.cert?.fingerprint).toBe('0x517b2ffb81ec129c8efd61f234662ca492bf75829b3c3ce30575d912551e2e33');
  });

  it('anchor-certificate rejects a bad score and reports engine errors with exit 1', async () => {
    const bad = await runCli(['v3', 'anchor-certificate', CERT, '--score', '150'], new StubRegistry());
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('INVALID_INPUT');
    const none = await runCli(['--json', 'v3', 'anchor-certificate', CERT, '--score', '35'], new StubRegistry());
    expect(none.code).toBe(1);
    expect(JSON.parse(none.stdout).error.code).toBe('V3_REGISTRY_NOT_DEPLOYED');
  });

  it('resilience-score prints the on-chain score', async () => {
    const r = await runCli(['v3', 'resilience-score', 'res-it-bob'], new StubRegistry());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('35/100');
    expect(r.stdout).toContain('recorded    : true');
  });
});
