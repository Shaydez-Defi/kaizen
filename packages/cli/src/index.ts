#!/usr/bin/env node
/**
 * kaizen — CLI interface to the shared operations engine.
 *
 * The CLI calls the SAME engine services as the API (DEC-002): it constructs
 * an engine in-process. It never implements operational logic of its own.
 *
 * Output contract:
 *  - human-readable text by default
 *  - `--json` for machine-readable output (stable envelope)
 *  - exit code 0 on success, 1 on any failure
 */

import path from 'node:path';
import { Command } from 'commander';
import {
  createEngine,
  KAIZEN_VERSION,
  toErrorJson,
  type KaizenEngine,
  type NetworkPreset,
  type OperationResult,
} from '@kaizen/engine';

interface GlobalOpts {
  json?: boolean;
  dataDir?: string;
}

const program = new Command();

program
  .name('kaizen')
  .description('Kaizen — Portaldot node operations platform (CLI)')
  .version(KAIZEN_VERSION)
  .option('--json', 'machine-readable JSON output')
  .option('--data-dir <path>', 'Kaizen data directory (default: $KAIZEN_DATA_DIR or ./.kaizen)');

const getOpts = (): GlobalOpts => program.opts<GlobalOpts>();

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printResult(result: OperationResult): void {
  if (result.ok) {
    console.log(
      `${result.kind} OK — network ${result.networkId ?? '-'} (${result.durationMs}ms, operation #${result.operationId})`,
    );
  } else {
    console.error(
      `${result.kind} FAILED — [${result.error?.code ?? 'ERROR'}] ${result.error?.message ?? 'unknown error'}`,
    );
  }
}

/**
 * Shared runner: constructs an in-process engine, runs the action, converts
 * any error into a structured envelope, and sets the exit code.
 */
async function run(
  fn: (engine: KaizenEngine, opts: GlobalOpts) => Promise<void>,
): Promise<void> {
  const opts = getOpts();
  const engine = createEngine({
    dataDir: opts.dataDir ? path.resolve(opts.dataDir) : undefined,
  });
  try {
    await fn(engine, opts);
  } catch (e) {
    const err = toErrorJson(e);
    if (opts.json) printJson({ ok: false, error: err });
    else console.error(`ERROR [${err.code}] ${err.message}`);
    process.exitCode = 1;
  } finally {
    await engine.close();
  }
}

// ---------------------------------------------------------------------------
// setup / status

program
  .command('setup')
  .description('Explicitly download and verify the Portaldot node binary (never happens implicitly)')
  .action(async () => {
    await run(async (engine, opts) => {
      const entry = await engine.binaries.setup();
      if (opts.json) {
        printJson({ ok: true, binary: entry });
        return;
      }
      console.log('Portaldot node binary ready:');
      console.log(`  version : ${entry.binaryVersion}`);
      console.log(`  platform: ${entry.platform}`);
      console.log(`  sha256  : ${entry.sha256}`);
      console.log(`  source  : ${entry.sourceUrl}`);
      console.log(`  path    : ${engine.binaries.nodePath()}`);
    });
  });

program
  .command('status')
  .description('Show binary availability (never downloads)')
  .action(async () => {
    await run(async (engine, opts) => {
      const status = await engine.binaries.status();
      if (opts.json) {
        printJson({ ok: status.available, status });
        if (!status.available) process.exitCode = 1;
        return;
      }
      console.log(status.available ? 'Binary: available' : 'Binary: NOT available');
      if (status.entry) {
        console.log(`  version: ${status.entry.binaryVersion}`);
        console.log(`  sha256 : ${status.entry.sha256}`);
      }
      for (const problem of status.problems) console.log(`  - ${problem}`);
      if (!status.available) process.exitCode = 1;
    });
  });

// ---------------------------------------------------------------------------
// network

const network = program.command('network').description('Network operations');

network
  .command('create <name>')
  .description('Create a network definition (does not start it)')
  .option('-p, --preset <preset>', 'single-node | two-node', 'single-node')
  .action(async (name: string, cmdOpts: { preset: string }) => {
    await run(async (engine, opts) => {
      const record = await engine.networks.create({
        name,
        preset: cmdOpts.preset as NetworkPreset,
      });
      if (opts.json) {
        printJson({ ok: true, network: record });
        return;
      }
      console.log(`Created network "${record.name}" (${record.id})`);
      console.log(`  preset  : ${record.preset}`);
      console.log(`  chain   : ${record.chain}`);
      console.log(`  baseDir : ${record.baseDir}`);
      console.log(`  test net: ${record.designatedTest ? 'yes' : 'no'}`);
    });
  });

network
  .command('list')
  .description('List networks')
  .action(async () => {
    await run(async (engine, opts) => {
      const networks = engine.networks.list();
      if (opts.json) {
        printJson({ ok: true, networks });
        return;
      }
      if (networks.length === 0) {
        console.log('No networks yet. Create one with: kaizen network create <name>');
        return;
      }
      for (const n of networks) {
        console.log(
          `${n.id}  ${n.name.padEnd(20)} ${n.preset.padEnd(12)} ${n.status.padEnd(9)} nodes=${n.nodeCount}`,
        );
      }
    });
  });

network
  .command('start <idOrName>')
  .description('Start all nodes of a network and wait until healthy')
  .action(async (idOrName: string) => {
    await run(async (engine, opts) => {
      const result = await engine.networks.start(idOrName);
      if (opts.json) printJson({ ok: result.ok, result });
      else printResult(result);
      if (!result.ok) process.exitCode = 1;
    });
  });

network
  .command('stop <idOrName>')
  .description('Stop all nodes of a network (SIGTERM, escalating to SIGKILL)')
  .action(async (idOrName: string) => {
    await run(async (engine, opts) => {
      const result = await engine.networks.stop(idOrName);
      if (opts.json) printJson({ ok: result.ok, result });
      else printResult(result);
      if (!result.ok) process.exitCode = 1;
    });
  });

network
  .command('status <idOrName>')
  .description('Inspect real node state via RPC (health, peers, block height)')
  .action(async (idOrName: string) => {
    await run(async (engine, opts) => {
      const inspection = await engine.networks.inspect(idOrName);
      if (opts.json) {
        printJson({ ok: true, inspection });
        return;
      }
      console.log(`Network ${inspection.name} (${inspection.networkId}) — ${inspection.status}`);
      for (const node of inspection.nodes) {
        const proc = `process=${node.process.state}${node.process.pid ? ` pid=${node.process.pid}` : ''}`;
        if (node.snapshot) {
          const s = node.snapshot;
          console.log(
            `  ${node.name.padEnd(24)} ${proc}  chain=${s.chain} height=${s.head.number} peers=${s.health.peers} syncing=${s.health.isSyncing} spec=${s.runtime.specName}@${s.runtime.specVersion}`,
          );
        } else {
          console.log(
            `  ${node.name.padEnd(24)} ${proc}  RPC unreachable: ${node.rpcError ?? 'unknown'}`,
          );
        }
      }
    });
  });

network
  .command('remove <idOrName>')
  .description('Remove a stopped network and its on-disk state')
  .action(async (idOrName: string) => {
    await run(async (engine, opts) => {
      await engine.networks.remove(idOrName);
      if (opts.json) printJson({ ok: true, removed: idOrName });
      else console.log(`Removed network ${idOrName}`);
    });
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(`ERROR [INTERNAL] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
