/**
 * Shared helpers for LIVE integration tests.
 *
 * These tests spawn REAL portaldot_dev processes. They only run when
 * KAIZEN_TEST_LIVE=1; otherwise every suite is skipped (never "passed").
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BinaryManager } from '@kaizen/engine';

export const LIVE = process.env['KAIZEN_TEST_LIVE'] === '1';

/** Shared binary cache across test files (avoid re-downloading 30 MB per file). */
export const SHARED_BIN_CACHE =
  process.env['KAIZEN_TEST_BIN_DIR'] ?? path.join(os.tmpdir(), 'kaizen-test-bin');

let binaryPromise: Promise<string> | null = null;

/** Ensure the shared test binary exists (explicit setup — downloads once). */
export async function ensureSharedBinary(): Promise<string> {
  binaryPromise ??= (async () => {
    const mgr = new BinaryManager({ cacheDir: SHARED_BIN_CACHE });
    const entry = await mgr.setup();
    console.log(
      `[it] binary ready: ${entry.binaryVersion} sha256=${entry.sha256.slice(0, 12)}…`,
    );
    return mgr.nodePath();
  })();
  return binaryPromise;
}

/** Fresh, isolated temp root per test suite. */
export function testRoot(name: string): string {
  const dir = path.join(os.tmpdir(), 'kaizen-it', `${name}-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Raw JSON-RPC call over HTTP (verified working on this node build in Phase 0). */
export async function httpRpc<T = unknown>(
  port: number,
  method: string,
  params: unknown[] = [],
  timeoutMs = 5_000,
): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(`${method} error: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

/** Poll until fn() returns truthy or timeout. */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  { timeoutMs = 60_000, intervalMs = 1_000, label = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no attempt yet';
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = 'condition not met';
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out (${timeoutMs}ms) for ${label}: ${last}`);
}

/** system_health via HTTP, retried until answered. */
export async function waitHealthy(
  rpcPort: number,
  timeoutMs = 90_000,
): Promise<{ isSyncing: boolean; peers: number; shouldHavePeers: boolean }> {
  return waitFor(
    async () => {
      const health = await httpRpc<{ isSyncing: boolean; peers: number; shouldHavePeers: boolean }>(
        rpcPort,
        'system_health',
      );
      return health ?? null;
    },
    { timeoutMs, label: `system_health on :${rpcPort}` },
  );
}
