/**
 * `kaizen up` — one command from a clean clone to a running local network
 * (T-3.6C). It only ORCHESTRATES existing engine services, in order:
 *
 *   1. binary   — engine.binaries.status(); if missing, engine.binaries.setup()
 *                 (the user asked for it by running `up`; `--no-setup` refuses)
 *   2. network  — reuse the named network if it exists, else
 *                 engine.networks.create({ name, preset })
 *   3. start    — engine.networks.start() (health-gated), skipped if running
 *   4. report   — real node endpoints from the persisted node records
 *
 * No operational logic lives here (DEC-002): every step is one engine call.
 * Docker / Kubernetes targets are Phase 6 and are refused with a typed INVALID_INPUT
 * error that says so, rather than faked (DEC-009).
 */

import { KaizenError, type KaizenEngine, type NetworkPreset, type NodeRecord } from '@kaizen/engine';

export const UP_DEFAULT_NAME = 'kaizen-local';
export const UP_DEFAULT_PRESET: NetworkPreset = 'four-validator';
export const UP_TARGETS = ['local', 'docker', 'kubernetes', 'k8s'] as const;
/** Defaults of the API (apps/api/src/server.ts) and the Vite dev server. */
export const UP_API_URL = 'http://127.0.0.1:4310';
export const UP_CONSOLE_URL = 'http://127.0.0.1:5173';

export interface UpOptions {
  name: string;
  preset: string;
  target: string;
  setup: boolean;
}

export type UpEngine = Pick<KaizenEngine, 'binaries' | 'networks'>;

export interface UpStep {
  id: 'binary' | 'network' | 'start';
  done: 'existing' | 'performed';
  detail: string;
}

export interface UpSummary {
  ok: boolean;
  networkId: string;
  networkName: string;
  preset: string;
  steps: UpStep[];
  nodes: Array<{ id: string; name: string; role: string; rpc: string; ws: string }>;
  apiUrl: string;
  consoleUrl: string;
  error?: { code: string; message: string };
}

function endpoints(node: NodeRecord): { rpc: string; ws: string } {
  return { rpc: `http://127.0.0.1:${node.ports.rpc}`, ws: `ws://127.0.0.1:${node.ports.ws}` };
}

export async function kaizenUp(
  engine: UpEngine,
  opts: UpOptions,
  progress: (line: string) => void = () => undefined,
): Promise<UpSummary> {
  const target = opts.target.toLowerCase();
  if (!(UP_TARGETS as readonly string[]).includes(target)) {
    throw new KaizenError('INVALID_INPUT', `Unknown target "${opts.target}" — supported: local (docker, kubernetes planned)`);
  }
  if (target !== 'local') {
    throw new KaizenError(
      'INVALID_INPUT',
      `Target "${target}" is planned for Phase 6 (Docker / Kubernetes adapters) and is not built yet. Use --target local.`,
    );
  }

  const steps: UpStep[] = [];

  // 1. binary
  const status = await engine.binaries.status();
  if (status.available) {
    steps.push({ id: 'binary', done: 'existing', detail: `portaldot binary ready (${status.entry?.binaryVersion ?? 'verified'})` });
  } else if (!opts.setup) {
    throw new KaizenError(
      'BINARY_NOT_AVAILABLE',
      `Portaldot binary not available (${status.problems.join('; ') || 'not installed'}). Run without --no-setup, or run: kaizen setup`,
    );
  } else {
    progress('… downloading and verifying the Portaldot node binary (kaizen setup)');
    const entry = await engine.binaries.setup();
    steps.push({ id: 'binary', done: 'performed', detail: `portaldot binary installed (${entry.binaryVersion}, sha256 ${entry.sha256.slice(0, 12)}…)` });
  }
  progress(`✓ ${steps[steps.length - 1]!.detail}`);

  // 2. network
  const existing = engine.networks.list().find((n) => n.name === opts.name);
  let networkId: string;
  let preset: string;
  if (existing) {
    networkId = existing.id;
    preset = existing.preset;
    steps.push({ id: 'network', done: 'existing', detail: `network "${existing.name}" exists (${existing.preset}, ${existing.nodeCount} nodes)` });
  } else {
    const created = await engine.networks.create({ name: opts.name, preset: opts.preset as NetworkPreset });
    networkId = created.id;
    preset = created.preset;
    const count = engine.networks.getNetwork(created.id).nodes.length;
    steps.push({ id: 'network', done: 'performed', detail: `network "${created.name}" created (${created.preset}, ${count} nodes)` });
  }
  progress(`✓ ${steps[steps.length - 1]!.detail}`);

  // 3. start
  const before = engine.networks.getNetwork(networkId);
  let error: UpSummary['error'];
  if (before.network.status === 'running') {
    steps.push({ id: 'start', done: 'existing', detail: `already running (${before.nodes.length} nodes)` });
    progress(`✓ ${steps[steps.length - 1]!.detail}`);
  } else {
    progress(`… starting ${before.nodes.length} nodes and waiting until healthy`);
    const result = await engine.networks.start(networkId);
    if (result.ok) {
      steps.push({ id: 'start', done: 'performed', detail: `${before.nodes.length} nodes started and healthy (${(result.durationMs / 1000).toFixed(1)}s)` });
      progress(`✓ ${steps[steps.length - 1]!.detail}`);
    } else {
      error = { code: result.error?.code ?? 'OPERATION_FAILED', message: result.error?.message ?? 'start failed' };
    }
  }

  const after = engine.networks.getNetwork(networkId);
  return {
    ok: !error,
    networkId,
    networkName: after.network.name,
    preset,
    steps,
    nodes: after.nodes.map((n) => ({ id: n.id, name: n.name, role: n.role, ...endpoints(n) })),
    apiUrl: UP_API_URL,
    consoleUrl: UP_CONSOLE_URL,
    ...(error ? { error } : {}),
  };
}

/** Human summary box (the shape shown on the landing page terminal). */
export function formatUpSummary(s: UpSummary): string[] {
  const first = s.nodes[0];
  const rows: [string, string][] = [
    ['RPC', first ? first.ws : '—'],
    ['API', `${s.apiUrl}   (node apps/api/dist/index.js)`],
    ['Console', `${s.consoleUrl}   (npm run dev -w @kaizen/web)`],
  ];
  const k = Math.max(...rows.map((r) => r[0].length));
  const v = Math.max(...rows.map((r) => r[1].length));
  const line = (l: string, m: string, r: string) => `${l}${'─'.repeat(k + 2)}${m}${'─'.repeat(v + 2)}${r}`;
  const out = [line('┌', '┬', '┐')];
  for (const [a, b] of rows) out.push(`│ ${a.padEnd(k)} │ ${b.padEnd(v)} │`);
  out.push(line('└', '┴', '┘'));
  out.push('');
  out.push(`Nodes of "${s.networkName}":`);
  for (const n of s.nodes) out.push(`  ${n.name.padEnd(24)} ${n.role.padEnd(9)} ${n.ws}`);
  out.push('');
  out.push(`Stop it with: kaizen network stop ${s.networkName}`);
  return out;
}
