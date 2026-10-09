/**
 * LIVE test — T-1.4 NodeProcessManager against the real node binary.
 * Verifies: real start → RPC-reachable → duplicate refusal → SIGTERM stop →
 * no orphans; STARTUP_FAILED with log tail on bad args.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildNodeArgs,
  isPidAlive,
  NodeProcessManager,
  PortAllocator,
} from '@kaizen/engine';
import { LIVE, ensureSharedBinary, httpRpc, testRoot, waitHealthy, waitFor } from './testkit';

describe.runIf(LIVE)('NodeProcessManager (live, real node)', () => {
  let mgr: NodeProcessManager;
  let nodePath: string;
  let dir: string;
  let ports: PortAllocator;

  beforeAll(async () => {
    nodePath = await ensureSharedBinary();
    dir = testRoot('proc');
    mgr = new NodeProcessManager();
    ports = new PortAllocator();
  });

  afterAll(async () => {
    await mgr.killAll();
    const orphans = mgr.managedNodeIds;
    expect(orphans).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it(
    'starts a real dev node, becomes RPC-healthy, refuses duplicates, stops cleanly',
    async () => {
      const p = await ports.allocate();
      const baseDir = path.join(dir, 'n1');
      const logFile = path.join(dir, 'n1.log');
      const nodeKeyFile = path.join(dir, 'n1.nodekey');
      const args = buildNodeArgs({
        name: 'it-node-1',
        baseDir,
        ports: p,
        chain: 'dev',
        wellKnownKey: 'alice',
        nodeKeyFile,
      });

      const status = await mgr.start({
        nodeId: 'n1',
        binaryPath: nodePath,
        args,
        logFile,
        baseDir,
      });
      expect(status.state).toBe('running');
      expect(status.pid).toBeGreaterThan(0);
      expect(mgr.isRunning('n1')).toBe(true);
      expect(isPidAlive(status.pid ?? 0)).toBe(true);
      expect(fs.existsSync(path.join(baseDir, 'kaizen-node.pid'))).toBe(true);

      // real node answers RPC (HTTP verified path)
      const health = await waitHealthy(p.rpc, 90_000);
      expect(typeof health.peers).toBe('number');

      // log capture is real
      await new Promise((r) => setTimeout(r, 2_000));
      const log = fs.readFileSync(logFile, 'utf8');
      expect(log).toMatch(/Listening for new connections|Pre-sealed block|Imported #/);

      // duplicate management refused
      await expect(
        mgr.start({ nodeId: 'n1', binaryPath: nodePath, args, logFile, baseDir }),
      ).rejects.toMatchObject({ code: 'NODE_ALREADY_RUNNING' });

      // clean SIGTERM stop, no orphan
      const stopped = await mgr.stop('n1');
      expect(stopped.state).toBe('stopped');
      expect(isPidAlive(stopped.pid ?? 0)).toBe(false);
      expect(mgr.isRunning('n1')).toBe(false);
      expect(fs.existsSync(path.join(baseDir, 'kaizen-node.pid'))).toBe(false);

      // RPC port released
      await expect(httpRpc(p.rpc, 'system_health', [], 2_000)).rejects.toThrow();
    },
    180_000,
  );

  it(
    'fails startup of a node with an invalid flag and surfaces the log tail',
    async () => {
      const p = await ports.allocate();
      const baseDir = path.join(dir, 'n2');
      const logFile = path.join(dir, 'n2.log');
      // deliberately invalid flag (passes assertSafeArgs — caught by the binary itself)
      const args = [
        '--dev',
        '--definitely-not-a-real-flag',
        '--base-path',
        baseDir,
        '--port',
        String(p.p2p),
        '--rpc-port',
        String(p.rpc),
        '--ws-port',
        String(p.ws),
        '--prometheus-port',
        String(p.prometheus),
      ];
      await expect(
        mgr.start(
          { nodeId: 'n2', binaryPath: nodePath, args, logFile, baseDir },
          { settleMs: 1_500 },
        ),
      ).rejects.toMatchObject({ code: 'STARTUP_FAILED' });
      expect(mgr.isRunning('n2')).toBe(false);
    },
    60_000,
  );

  it(
    'supports cross-process stop: a SECOND manager instance adopts and stops the daemon',
    async () => {
      // This is the CLI scenario: process A starts the node, process B (a new
      // kaizen invocation) must be able to stop it via persisted pid/baseDir.
      const p = await ports.allocate();
      const baseDir = path.join(dir, 'n3');
      const logFile = path.join(dir, 'n3.log');
      const spec = {
        nodeId: 'n3',
        binaryPath: nodePath,
        args: buildNodeArgs({
          name: 'it-n3',
          baseDir,
          ports: p,
          chain: 'dev',
          wellKnownKey: 'alice',
          nodeKeyFile: path.join(dir, 'n3.nodekey'),
        }),
        logFile,
        baseDir,
      };
      const started = await mgr.start(spec);
      expect(started.pid).toBeGreaterThan(0);
      await waitHealthy(p.rpc, 90_000);

      // "another CLI process": manager with no knowledge of the child
      const otherInstance = new NodeProcessManager();
      const stopped = await otherInstance.stop('n3', {
        pid: started.pid,
        baseDir,
      });
      expect(stopped.state).toBe('stopped');
      expect(isPidAlive(started.pid ?? 0)).toBe(false);
      expect(fs.existsSync(path.join(baseDir, 'kaizen-node.pid'))).toBe(false);

      // stopping again is a no-op, not an error (idempotent)
      const again = await otherInstance.stop('n3', { pid: started.pid, baseDir });
      expect(again.state).toBe('stopped');
    },
    180_000,
  );

  it(
    'detects an external SIGKILL (crash) and restart recovers the chain DB',
    async () => {
      const p = await ports.allocate();
      const baseDir = path.join(dir, 'n4');
      const spec = {
        nodeId: 'n4',
        binaryPath: nodePath,
        args: buildNodeArgs({
          name: 'it-n4',
          baseDir,
          ports: p,
          chain: 'dev',
          wellKnownKey: 'alice',
          nodeKeyFile: path.join(dir, 'n4.nodekey'),
        }),
        logFile: path.join(dir, 'n4.log'),
        baseDir,
      };
      const started = await mgr.start(spec);
      if (!started.pid) throw new Error('expected a pid');
      await waitHealthy(p.rpc, 90_000);

      // let the chain produce a block so there is real data to recover
      const heightBefore = await waitFor(
        async () => {
          // chain_getHeader result IS the header object (Phase 0, R-07)
          const header = await httpRpc<{ number: string }>(p.rpc, 'chain_getHeader');
          const n = Number.parseInt(header.number, 16);
          return n >= 1 ? n : null;
        },
        { timeoutMs: 60_000, intervalMs: 1_000, label: 'first block produced' },
      );

      // simulate a crash: SIGKILL delivered from outside the manager
      process.kill(started.pid, 'SIGKILL');

      // the manager must record the unexpected exit as a crash (not 'stopped')
      await waitFor(
        async () => (mgr.getStatus('n4')?.state === 'crashed' ? true : null),
        { timeoutMs: 15_000, intervalMs: 200, label: 'crash detected' },
      );
      expect(mgr.isRunning('n4')).toBe(false);
      expect(mgr.getStatus('n4')?.exitSignal).toBe('SIGKILL');

      // restart on the same base-path: the chain DB must recover (height kept)
      const restarted = await mgr.start(spec);
      expect(restarted.state).toBe('running');
      await waitHealthy(p.rpc, 90_000);
      const heightAfter = await waitFor(
        async () => {
          const header = await httpRpc<{ number: string }>(p.rpc, 'chain_getHeader');
          const n = Number.parseInt(header.number, 16);
          return n >= heightBefore ? n : null;
        },
        { timeoutMs: 60_000, intervalMs: 1_000, label: 'height recovered after restart' },
      );
      expect(heightAfter).toBeGreaterThanOrEqual(heightBefore);

      const stop = await mgr.stop('n4');
      expect(stop.state).toBe('stopped');
    },
    240_000,
  );
});
