/**
 * kaizen — CLI program (command tree + actions).
 *
 * The CLI calls the SAME engine services as the API (DEC-002): it constructs
 * an in-process engine and never implements operational logic of its own.
 * Scenario execution/replay go through `engine.scenarioRuns.execute()` /
 * `.replay()` exactly like the API (DEC-021) — one executor, one gate chain,
 * one injector pipeline; the CLI adds no second execution path and holds no
 * network listener of its own.
 *
 * Output contract (unchanged from the original CLI):
 *  - human-readable text by default
 *  - `--json` for machine-readable output (stable envelope)
 *  - exit code 0 on success, 1 on any failure
 *
 * `buildProgram()` is exported (with an engine-factory DI seam) so tests can
 * drive real commands against a real engine without spawning a process.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  createEngine,
  isKaizenError,
  KaizenError,
  KAIZEN_VERSION,
  isTerminalScenarioRunState,
  scenarioRunReplayNote,
  SCENARIO_RUN_STATES,
  toErrorJson,
  type CustomTopologyInput,
  type KaizenEngine,
  type NetworkPreset,
  type NodeRole,
  type OperationResult,
  type ScenarioListFilter,
  type ScenarioPage,
  type ScenarioRecord,
  type ScenarioRunListFilter,
  type ScenarioRunPage,
  type ScenarioRunRecord,
  type ScenarioRunState,
  type ScenarioRunSummary,
  type ScenarioValidationResult,
  type SerializedOperationDefinition,
} from '@kaizen/engine';

interface GlobalOpts {
  json?: boolean;
  dataDir?: string;
}

export interface CliDependencies {
  /** Engine factory (DI seam for tests). Default: in-process createEngine. */
  engineFactory?: () => KaizenEngine;
}

/** Run outcomes that count as success for scripting. */
const SUCCESS_RUN_STATES = new Set<ScenarioRunState>(['completed', 'completed-with-warnings']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildProgram(deps: CliDependencies = {}): Command {
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
   * Shared runner: constructs an in-process engine (or the injected factory),
   * runs the action, converts any error into a structured envelope, and sets
   * the exit code.
   */
  async function run(
    fn: (engine: KaizenEngine, opts: GlobalOpts) => Promise<void>,
  ): Promise<void> {
    const opts = getOpts();
    const engine =
      deps.engineFactory ??
      (() =>
        createEngine({
          dataDir: opts.dataDir ? path.resolve(opts.dataDir) : undefined,
        }));
    const instance = engine();
    try {
      await fn(instance, opts);
    } catch (e) {
      const err = toErrorJson(e);
      if (opts.json) printJson({ ok: false, error: err });
      else console.error(`ERROR [${err.code}] ${err.message}`);
      process.exitCode = 1;
    } finally {
      await instance.close();
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

  /**
   * Parse a custom topology spec string into typed input:
   *   "alice:validator,backup:validator:ferdie,full-1:full"
   *   → name:role[:wellKnownKey]. Validation happens in the engine; the CLI
   *   only translates syntax and reports parse errors as INVALID_INPUT.
   */
  function parseCustomNodes(spec: string): CustomTopologyInput {
    const nodes = spec.split(',').map((chunk) => {
      const parts = chunk.trim().split(':');
      const [name, role, key] = parts;
      if (!name || (role !== 'validator' && role !== 'full')) {
        throw new Error(
          `Invalid node "${chunk}" — expected name:role[:wellKnownKey] with role validator|full`,
        );
      }
      return { name: name.trim(), role: role as NodeRole, wellKnownKey: key?.trim() };
    });
    return { nodes };
  }

  network
    .command('create <name>')
    .description('Create a network definition (does not start it)')
    .option(
      '-p, --preset <preset>',
      'single-node | two-node | four-validator | validator-fullnode | custom',
      'single-node',
    )
    .option(
      '--nodes <spec>',
      'custom topology: "name:role[:wellKnownKey],…" (e.g. "alice:validator,full-1:full")',
    )
    .action(async (name: string, cmdOpts: { preset: string; nodes?: string }) => {
      await run(async (engine, opts) => {
        let custom: CustomTopologyInput | undefined;
        if (cmdOpts.nodes) {
          try {
            custom = parseCustomNodes(cmdOpts.nodes);
          } catch (e) {
            throw new KaizenError('INVALID_INPUT', e instanceof Error ? e.message : String(e));
          }
        }
        const record = await engine.networks.create({
          name,
          preset: cmdOpts.preset as NetworkPreset,
          custom,
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
        const { nodes } = engine.networks.getNetwork(record.id);
        for (const node of nodes) {
          console.log(
            `  node ${node.id}  ${node.name.padEnd(20)} role=${node.role.padEnd(9)} ${node.wellKnownKey ? `key=${node.wellKnownKey.padEnd(8)}` : 'key=-'} ports=${node.ports.p2p}/${node.ports.rpc}/${node.ports.ws}/${node.ports.prometheus}`,
          );
        }
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

  network
    .command('purge <idOrName>')
    .description('Delete all node chain databases (keeps identities, ports, spec) so the next start boots from genesis')
    .action(async (idOrName: string) => {
      await run(async (engine, opts) => {
        const result = await engine.networks.purgeChain(idOrName);
        if (opts.json) printJson({ ok: result.ok, result });
        else printResult(result);
        if (!result.ok) process.exitCode = 1;
      });
    });

  network
    .command('monitor <idOrName>')
    .description('Sample every node now via real HTTP RPC and show health, peers, head/finalized')
    .action(async (idOrName: string) => {
      await run(async (engine, opts) => {
        const snapshot = await engine.monitoring.snapshotNow(idOrName);
        if (opts.json) {
          printJson({ ok: true, snapshot });
          return;
        }
        console.log(`Monitoring ${snapshot.name} (${snapshot.networkId}) at ${snapshot.at}`);
        for (const sample of snapshot.samples) {
          const health = snapshot.health.find((h) => h.nodeId === sample.nodeId);
          const proc = `process=${sample.process.status}${sample.process.pid ? ` pid=${sample.process.pid}` : ''}`;
          const chain = sample.rpc.reachable
            ? `head=#${sample.head?.number ?? '?'} finalized=#${sample.finalized?.number ?? '?'} peers=${sample.peers?.count ?? '?'}/${sample.peers?.expected ?? '?'}${sample.health?.isSyncing ? ' syncing' : ''}`
            : `RPC unreachable: ${sample.rpc.error ?? 'unknown'}`;
          console.log(`  ${sample.name.padEnd(24)} [${health?.state ?? 'unknown'}] ${proc}  ${chain}`);
          for (const reason of health?.reasons ?? []) console.log(`      - ${reason}`);
        }
      });
    });

  // ---------------------------------------------------------------------------
  // node (per-node lifecycle)

  const node = program.command('node').description('Single-node operations');

  node
    .command('list <network>')
    .description('List the nodes of a network with persisted configuration')
    .action(async (networkIdOrName: string) => {
      await run(async (engine, opts) => {
        const { network, nodes } = engine.networks.getNetwork(networkIdOrName);
        if (opts.json) {
          printJson({ ok: true, networkId: network.id, nodes });
          return;
        }
        for (const n of nodes) {
          console.log(
            `${n.id}  ${n.name.padEnd(20)} role=${n.role.padEnd(9)} status=${n.status.padEnd(8)} ${n.wellKnownKey ? `key=${n.wellKnownKey}` : ''} expectedPeers=${n.expectedPeers ?? 0}`,
          );
        }
      });
    });

  node
    .command('get <nodeId>')
    .description('Show one node: persisted config + latest monitoring sample/health if any')
    .action(async (nodeId: string) => {
      await run(async (engine, opts) => {
        const record = engine.store.tryGetNode(nodeId);
        if (!record) throw new KaizenError('NODE_NOT_FOUND', `No node with id "${nodeId}"`, { nodeId });
        const snapshot = engine.monitoring.getLatest(record.networkId);
        const sample = snapshot?.samples.find((s) => s.nodeId === nodeId) ?? null;
        const health = snapshot?.health.find((h) => h.nodeId === nodeId) ?? null;
        if (opts.json) {
          printJson({ ok: true, node: record, sample, health });
          return;
        }
        console.log(`${record.id} — ${record.name} (${record.networkId})`);
        console.log(`  role    : ${record.role}${record.wellKnownKey ? ` (key ${record.wellKnownKey})` : ''}`);
        console.log(`  status  : ${record.status}${record.pid ? ` pid=${record.pid}` : ''}`);
        console.log(`  ports   : p2p=${record.ports.p2p} rpc=${record.ports.rpc} ws=${record.ports.ws} prom=${record.ports.prometheus}`);
        console.log(`  expected peers: ${record.expectedPeers ?? 0}`);
        if (sample) {
          console.log(
            `  sample  : head=#${sample.head?.number ?? '?'} finalized=#${sample.finalized?.number ?? '?'} peers=${sample.peers?.count ?? '?'} rpc=${sample.rpc.reachable ? 'ok' : 'unreachable'}`,
          );
          console.log(`  health  : ${health?.state ?? 'unknown'} — ${(health?.reasons ?? []).join('; ')}`);
        } else {
          console.log('  sample  : none yet (start the network or run kaizen network monitor)');
        }
      });
    });

  node
    .command('start <nodeId>')
    .description('Start a single node of a network')
    .action(async (nodeId: string) => {
      await run(async (engine, opts) => {
        const result = await engine.networks.startNode(nodeId);
        if (opts.json) printJson({ ok: result.ok, result });
        else printResult(result);
        if (!result.ok) process.exitCode = 1;
      });
    });

  node
    .command('stop <nodeId>')
    .description('Stop a single node of a network (keeps its chain data)')
    .action(async (nodeId: string) => {
      await run(async (engine, opts) => {
        const result = await engine.networks.stopNode(nodeId);
        if (opts.json) printJson({ ok: result.ok, result });
        else printResult(result);
        if (!result.ok) process.exitCode = 1;
      });
    });

  // ---------------------------------------------------------------------------
  // scenario (authoring — saving/validating NEVER executes anything)

  const scenarioCmd = program
    .command('scenario')
    .description('Scenario authoring (validation + storage only — authoring never executes anything)');

  function readScenarioFile(file: string): unknown {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw new KaizenError(
        'INVALID_INPUT',
        `Cannot read scenario file "${file}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (e) {
      throw new KaizenError(
        'INVALID_INPUT',
        `Scenario file "${file}" is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  function printScenarioDetail(record: ScenarioRecord): void {
    console.log(`${record.id} — ${record.name} (${record.validationStatus})`);
    if (record.description) console.log(`  description: ${record.description}`);
    console.log(`  tags      : ${record.tags.length > 0 ? record.tags.join(', ') : '-'}`);
    console.log(
      `  validation: ${record.validation.errorCount} error(s), ${record.validation.warningCount} warning(s), steps=${record.validation.stepCount}, worst-case ${record.validation.worstCaseDurationMs}ms`,
    );
    console.log(
      `  requires  : designatedTest=${record.requires.designatedTest ?? '-'} preset=${record.requires.preset ?? '-'} minNodes=${record.requires.minNodes ?? '-'}`,
    );
    for (const step of record.steps) {
      const node = (step.operation.config as { node?: unknown }).node ?? '-';
      console.log(
        `  #${step.order} ${step.id.padEnd(12)} ${step.operation.type.padEnd(8)} node=${String(node).padEnd(12)} delayBefore=${step.delayBeforeMs}ms delayAfter=${step.delayAfterMs}ms timeout=${step.timeoutMs}ms`,
      );
    }
  }

  function printValidationIssues(result: ScenarioValidationResult): void {
    for (const issue of result.issues) {
      console.log(
        `  [${issue.severity}] ${issue.path || '(scenario)'}: ${issue.message}` +
          (issue.remediation ? ` — ${issue.remediation}` : ''),
      );
    }
  }

  scenarioCmd
    .command('list')
    .description('List saved scenarios')
    .option('--tag <tag>', 'filter by tag')
    .option('-q, --query <text>', 'filter by name/description text')
    .option('--status <valid|warning>', 'filter by validation status')
    .option('--limit <n>', 'page size (1-200)', '50')
    .option('--offset <n>', 'page offset', '0')
    .action(
      async (cmdOpts: {
        tag?: string;
        query?: string;
        status?: string;
        limit: string;
        offset: string;
      }) => {
        await run(async (engine, opts) => {
          if (cmdOpts.status !== undefined && cmdOpts.status !== 'valid' && cmdOpts.status !== 'warning') {
            throw new KaizenError(
              'INVALID_INPUT',
              `--status must be "valid" or "warning", got "${cmdOpts.status}"`,
            );
          }
          const filter: ScenarioListFilter = {
            limit: parseStrictInt(cmdOpts.limit, '--limit', { min: 1, max: 200 }),
            offset: parseStrictInt(cmdOpts.offset, '--offset', { min: 0 }),
            ...(cmdOpts.tag !== undefined ? { tag: cmdOpts.tag } : {}),
            ...(cmdOpts.query !== undefined ? { q: cmdOpts.query } : {}),
            ...(cmdOpts.status !== undefined ? { status: cmdOpts.status } : {}),
          };
          const page: ScenarioPage = engine.scenarios.list(filter);
          if (opts.json) {
            printJson({ ok: true, ...page });
            return;
          }
          if (page.scenarios.length === 0) {
            console.log('No scenarios match.');
          } else {
            for (const s of page.scenarios) {
              console.log(
                `${s.id}  ${s.name.padEnd(28)} ${s.validationStatus.padEnd(8)} steps=${s.steps.length}${s.tags.length > 0 ? ` tags=${s.tags.join(',')}` : ''}`,
              );
            }
            console.log(`(${page.total} total${page.total > page.scenarios.length ? `, showing ${page.scenarios.length} offset ${page.offset}` : ''})`);
          }
          for (const m of page.malformed) {
            console.log(`warning: unreadable scenario row ${m.id} [${m.code}]: ${m.message}`);
          }
        });
      },
    );

  scenarioCmd
    .command('get <id>')
    .description('Inspect one saved scenario (validation summary + ordered steps)')
    .action(async (id: string) => {
      await run(async (engine, opts) => {
        const record = engine.scenarios.get(id); // throws SCENARIO_NOT_FOUND
        if (opts.json) {
          printJson({ ok: true, scenario: record });
          return;
        }
        printScenarioDetail(record);
      });
    });

  scenarioCmd
    .command('create <file>')
    .description('Create (and store) a scenario from a JSON file — validation rules apply; never executes it')
    .action(async (file: string) => {
      await run(async (engine, opts) => {
        const record = engine.scenarios.create(readScenarioFile(file), 'cli');
        if (opts.json) {
          printJson({ ok: true, scenario: record });
          return;
        }
        console.log(`Created scenario "${record.name}" (${record.id}) — ${record.validationStatus}`);
        console.log(
          `  steps=${record.validation.stepCount} worst-case ${record.validation.worstCaseDurationMs}ms warnings=${record.validation.warningCount}`,
        );
        if (record.validation.warningCount > 0) printValidationIssues(record.validation);
      });
    });

  scenarioCmd
    .command('validate <file>')
    .description('Validate a scenario file WITHOUT saving or executing anything')
    .action(async (file: string) => {
      await run(async (engine, opts) => {
        const result = engine.scenarios.validate(readScenarioFile(file));
        // Validation outcome, not an operation failure: exit 1 only signals
        // "invalid" for scripting; the result itself is always reported.
        if (opts.json) {
          printJson({ ok: result.valid, result });
        } else if (result.valid) {
          console.log(
            `VALID — steps=${result.stepCount}, worst-case ${result.worstCaseDurationMs}ms, warnings=${result.warningCount}`,
          );
          if (result.warningCount > 0) printValidationIssues(result);
        } else {
          console.log(
            `INVALID — ${result.errorCount} error(s), ${result.warningCount} warning(s)`,
          );
          printValidationIssues(result);
        }
        if (!result.valid) process.exitCode = 1;
      });
    });

  scenarioCmd
    .command('operations')
    .description('Describe the safe operation registry (types, support status, config fields)')
    .action(async () => {
      await run(async (engine, opts) => {
        const operations: SerializedOperationDefinition[] = engine.scenarios.describeOperations();
        if (opts.json) {
          printJson({ ok: true, operations });
          return;
        }
        for (const op of operations) {
          console.log(
            `${op.type.padEnd(12)} ${op.status.padEnd(9)} ${op.kind.padEnd(9)} ${op.displayName} — config: ${op.configFields.join(', ')}`,
          );
          if (op.statusReason) console.log(`    reason : ${op.statusReason}`);
          if (op.statusUnblock) console.log(`    unblock: ${op.statusUnblock}`);
        }
      });
    });

  // ---------------------------------------------------------------------------
  // run (execution + history — the SAME engine path the API uses, DEC-021)

  const runCmd = program
    .command('run')
    .description(
      'Scenario execution runs: execute/replay go through the engine gates; runs are persisted before any side effect',
    );

  function parseStrictInt(raw: string, label: string, bounds: { min: number; max?: number }): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < bounds.min || (bounds.max !== undefined && n > bounds.max)) {
      throw new KaizenError(
        'INVALID_INPUT',
        `${label} must be an integer in ${bounds.min}..${bounds.max ?? 'no upper bound'}, got "${raw}"`,
      );
    }
    return n;
  }

  function requireRunState(value: string): ScenarioRunState {
    if (!(SCENARIO_RUN_STATES as readonly string[]).includes(value)) {
      throw new KaizenError(
        'INVALID_INPUT',
        `Unknown run state "${value}" — valid states: ${SCENARIO_RUN_STATES.join(', ')}`,
      );
    }
    return value as ScenarioRunState;
  }

  function printRunSummaryLine(r: ScenarioRunSummary): void {
    console.log(
      `${r.id}  ${r.state.padEnd(23)} ${r.scenarioName.padEnd(22)} network=${r.networkName.padEnd(14)} steps=${r.completedSteps}/${r.stepCount}` +
        `${r.replayOfRunId ? ` replay-of=${r.replayOfRunId}` : ''}${r.error ? ` error=[${r.error.code}]` : ''}`,
    );
  }

  function printRunDetail(runRecord: ScenarioRunRecord): void {
    console.log(`Run ${runRecord.id} — ${runRecord.state}`);
    console.log(`  scenario : ${runRecord.scenarioName} (${runRecord.scenarioId})`);
    console.log(`  network  : ${runRecord.networkName} (${runRecord.networkId})`);
    console.log(
      `  requested: ${runRecord.requestedBy}   created ${runRecord.createdAt}${runRecord.finishedAt ? `   finished ${runRecord.finishedAt}` : ''}`,
    );
    if (runRecord.error) {
      console.log(`  error    : [${runRecord.error.code}] ${runRecord.error.message}`);
    }
    for (const warning of runRecord.warnings) console.log(`  warning  : ${warning}`);
    if (runRecord.cancellation) {
      console.log(
        `  cancelled: requested by ${runRecord.cancellation.requestedBy} at ${runRecord.cancellation.requestedAt}`,
      );
    }
    for (const step of runRecord.steps) {
      console.log(
        `  #${step.order} ${step.stepId.padEnd(12)} ${step.operationType.padEnd(8)} node=${(step.nodeName ?? step.nodeLabel ?? '-').padEnd(12)} → ${step.state}${step.faultId ? ` fault=${step.faultId}` : ''}${step.outcome ? ` outcome=${step.outcome}` : ''}`,
      );
    }
    const note = scenarioRunReplayNote(runRecord);
    console.log(
      `  replay-of: ${runRecord.replayOfRunId ?? '— (original execution)'}`,
    );
    if (note) console.log(`  replay note: ${note}`);
  }

  /**
   * Gate refusals persist a rejected run BEFORE throwing (T-3.4). Surface
   * that run's id honestly (human hint + JSON field) instead of only the
   * error string — attributed by a created-at ≥ attempt-time guard, never
   * guessed.
   */
  function surfaceRejectedRun(
    engine: KaizenEngine,
    opts: GlobalOpts,
    e: unknown,
    attemptedAt: string,
  ): void {
    const err = toErrorJson(e);
    let rejectedRunId: string | undefined;
    let newest = '';
    for (const r of engine.scenarioRuns.list({ state: 'rejected', limit: 20 }).runs) {
      if (r.createdAt >= attemptedAt && r.createdAt >= newest) {
        newest = r.createdAt;
        rejectedRunId = r.id;
      }
    }
    if (opts.json) {
      printJson({
        ok: false,
        error: err,
        ...(rejectedRunId !== undefined ? { rejectedRunId } : {}),
      });
    } else {
      console.error(`ERROR [${err.code}] ${err.message}`);
      if (rejectedRunId !== undefined) {
        console.error(
          `note: a rejected run was persisted (${rejectedRunId}) — inspect: kaizen run get ${rejectedRunId}`,
        );
      }
    }
    process.exitCode = 1;
  }

  /** Await a terminal state; a wait timeout is reported honestly, never as success. */
  async function waitForRun(
    engine: KaizenEngine,
    accepted: ScenarioRunRecord,
    timeoutMs: number,
  ): Promise<ScenarioRunRecord> {
    try {
      return await engine.scenarioRuns.wait(accepted.id, timeoutMs);
    } catch (e) {
      if (isKaizenError(e) && e.code === 'OPERATION_TIMEOUT') {
        const current = engine.scenarioRuns.get(accepted.id);
        throw new KaizenError(
          'OPERATION_TIMEOUT',
          `run ${accepted.id} did not reach a terminal state within ${timeoutMs}ms (current state: ${current.state}); the run keeps executing — inspect with: kaizen run get ${accepted.id}`,
          { runId: accepted.id, state: current.state, ms: timeoutMs },
        );
      }
      throw e;
    }
  }

  function reportRunOutcome(opts: GlobalOpts, runRecord: ScenarioRunRecord): void {
    const ok = SUCCESS_RUN_STATES.has(runRecord.state);
    if (opts.json) {
      printJson({ ok, run: runRecord, replayNote: scenarioRunReplayNote(runRecord) });
    } else {
      printRunDetail(runRecord);
    }
    if (!ok) process.exitCode = 1;
  }

  runCmd
    .command('execute <scenarioId>')
    .description(
      'Execute a saved scenario against an EXPLICITLY selected eligible test network (engine gates apply; a refusal persists a rejected run)',
    )
    .requiredOption(
      '-n, --network <idOrName>',
      'target network id or name — explicit selection is required, never inferred',
    )
    .option('--timeout <ms>', 'bounded wait for a terminal run state', '300000')
    .action(async (scenarioId: string, cmdOpts: { network: string; timeout: string }) => {
      await run(async (engine, opts) => {
        const timeoutMs = parseStrictInt(cmdOpts.timeout, '--timeout', { min: 1, max: 3_600_000 });
        const attemptedAt = new Date().toISOString();
        let accepted: ScenarioRunRecord;
        try {
          accepted = engine.scenarioRuns.execute({
            scenarioId,
            networkIdOrName: cmdOpts.network,
            mode: 'execute',
            requestedBy: 'cli',
          });
        } catch (e) {
          surfaceRejectedRun(engine, opts, e, attemptedAt);
          return;
        }
        const finished = await waitForRun(engine, accepted, timeoutMs);
        reportRunOutcome(opts, finished);
      });
    });

  runCmd
    .command('replay <runId>')
    .description(
      "Replay a finished run's recorded actions as a NEW run against an EXPLICITLY selected network (provenance is not authorization; identical outcomes are NOT guaranteed)",
    )
    .requiredOption(
      '-n, --network <idOrName>',
      'target network id or name — re-confirmed explicitly; never inherited from the source run',
    )
    .option('--timeout <ms>', 'bounded wait for a terminal run state', '300000')
    .action(async (runId: string, cmdOpts: { network: string; timeout: string }) => {
      await run(async (engine, opts) => {
        const timeoutMs = parseStrictInt(cmdOpts.timeout, '--timeout', { min: 1, max: 3_600_000 });
        const attemptedAt = new Date().toISOString();
        let accepted: ScenarioRunRecord;
        try {
          accepted = engine.scenarioRuns.replay({
            runId,
            networkIdOrName: cmdOpts.network,
            mode: 'execute',
            requestedBy: 'cli',
          });
        } catch (e) {
          surfaceRejectedRun(engine, opts, e, attemptedAt);
          return;
        }
        const finished = await waitForRun(engine, accepted, timeoutMs);
        reportRunOutcome(opts, finished);
      });
    });

  runCmd
    .command('list')
    .description('List scenario runs — every state, including failed and rejected')
    .option('--scenario <id>', 'filter by scenario id')
    .option('--network <id>', 'filter by network id')
    .option('--state <state>', `filter by run state (${SCENARIO_RUN_STATES.join(' | ')})`)
    .option('--replay-of <runId>', 'only runs replayed FROM this source run (provenance)')
    .option('--limit <n>', 'page size (1-200)', '50')
    .option('--offset <n>', 'page offset', '0')
    .action(
      async (cmdOpts: {
        scenario?: string;
        network?: string;
        state?: string;
        replayOf?: string;
        limit: string;
        offset: string;
      }) => {
        await run(async (engine, opts) => {
          const filter: ScenarioRunListFilter = {
            limit: parseStrictInt(cmdOpts.limit, '--limit', { min: 1, max: 200 }),
            offset: parseStrictInt(cmdOpts.offset, '--offset', { min: 0 }),
            ...(cmdOpts.scenario !== undefined ? { scenarioId: cmdOpts.scenario } : {}),
            ...(cmdOpts.network !== undefined ? { networkId: cmdOpts.network } : {}),
            ...(cmdOpts.state !== undefined ? { state: requireRunState(cmdOpts.state) } : {}),
            ...(cmdOpts.replayOf !== undefined ? { replayOf: cmdOpts.replayOf } : {}),
          };
          const page: ScenarioRunPage = engine.scenarioRuns.list(filter);
          if (opts.json) {
            printJson({ ok: true, ...page });
            return;
          }
          if (page.runs.length === 0) {
            console.log('No runs match.');
          } else {
            for (const r of page.runs) printRunSummaryLine(r);
            console.log(
              `(${page.total} total${page.total > page.runs.length ? `, showing ${page.runs.length} offset ${page.offset}` : ''})`,
            );
          }
          for (const m of page.malformed) {
            console.log(`warning: unreadable run row ${m.id}: ${m.message}`);
          }
        });
      },
    );

  runCmd
    .command('get <runId>')
    .description(
      'Inspect one run: steps + evidence, failure details, cancellation, and replay provenance (replayOfRunId + honesty note + replays of this run)',
    )
    .action(async (runId: string) => {
      await run(async (engine, opts) => {
        const runRecord = engine.scenarioRuns.get(runId); // throws SCENARIO_RUN_NOT_FOUND
        const replayNote = scenarioRunReplayNote(runRecord);
        const replays = engine.scenarioRuns.list({ replayOf: runRecord.id, limit: 50 }).runs;
        if (opts.json) {
          printJson({ ok: true, run: runRecord, replayNote, replays });
          return;
        }
        printRunDetail(runRecord);
        if (replays.length > 0) {
          console.log('  replays of this run:');
          for (const r of replays) printRunSummaryLine(r);
        }
      });
    });

  runCmd
    .command('cancel <runId>')
    .description(
      'Request cancellation of a run — works cross-process (the durable request is honored by the executing process; interrupts in-flight faults via the injector and waits, bounded, for the terminal state)',
    )
    .option(
      '--timeout <ms>',
      'bounded wait for the cancellation to take effect (durable request observed by the executing process)',
      '60000',
    )
    .action(async (runId: string, cmdOpts: { timeout: string }) => {
      await run(async (engine, opts) => {
        const timeoutMs = parseStrictInt(cmdOpts.timeout, '--timeout', { min: 1, max: 3_600_000 });
        const requested = await engine.scenarioRuns.cancel(runId, 'cli');
        // The request may be durable (run executing in ANOTHER process): poll,
        // bounded, until the run reaches a terminal state. Honesty rule: a
        // request nobody observed is reported as a timeout, never as success.
        let final = requested;
        const deadline = Date.now() + timeoutMs;
        while (!isTerminalScenarioRunState(final.state) && Date.now() < deadline) {
          await sleep(500);
          final = engine.scenarioRuns.get(runId);
        }
        if (!isTerminalScenarioRunState(final.state)) {
          throw new KaizenError(
            'OPERATION_TIMEOUT',
            `cancellation of run ${runId} was recorded but the run did not stop within ${timeoutMs}ms (current state: ${final.state}); no process executing it observed the request — it may be orphaned by a crashed process and is terminalized by startup reconciliation. Inspect: kaizen run get ${runId}`,
            { runId, state: final.state, ms: timeoutMs },
          );
        }
        // Exit contract: clean outcomes only. 'cancelled' (the request took
        // effect) and completed* (finished before the request landed) are
        // success; failed/cleanup-failed are not.
        const ok = final.state === 'cancelled' || SUCCESS_RUN_STATES.has(final.state);
        if (opts.json) {
          printJson({ ok, run: final, replayNote: scenarioRunReplayNote(final) });
        } else {
          printRunDetail(final);
        }
        if (!ok) process.exitCode = 1;
      });
    });

  return program;
}
