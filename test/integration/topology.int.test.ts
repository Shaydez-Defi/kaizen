/**
 * LIVE test — Phase 2A topologies against real Portaldot processes (T-2.1…T-2.3).
 *
 * Evidence bar per topology: real processes, real RPC, real peer counts, real
 * chain identity (genesis hash), real block production (log authorship), real
 * GRANDPA finality. "Four processes running" alone never counts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine, isKaizenError, isPidAlive, type KaizenEngine } from '@kaizen/engine';
import { httpRpc, LIVE, SHARED_BIN_CACHE, ensureSharedBinary, testRoot, waitFor } from './testkit';

interface Header {
  number: string;
  hash: string;
}

function bestNumber(rpcPort: number): Promise<number> {
  return httpRpc<Header>(rpcPort, 'chain_getHeader').then((h) => parseInt(h.number, 16));
}

function genesisHashOf(rpcPort: number): Promise<string> {
  return httpRpc<string>(rpcPort, 'chain_getBlockHash', ['0x0']);
}

async function finalizedNumber(rpcPort: number): Promise<number> {
  const hash = await httpRpc<string>(rpcPort, 'chain_getFinalizedHead');
  const header = await httpRpc<Header>(rpcPort, 'chain_getHeader', [hash]);
  return parseInt(header.number, 16);
}

function peerCount(rpcPort: number): Promise<number> {
  return httpRpc<{ peers: number }>(rpcPort, 'system_health').then((h) => h.peers);
}

function countInFile(file: string, needle: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split(needle).length - 1;
}

describe.runIf(LIVE)('Topologies (live, real networks)', () => {
  let engine: KaizenEngine;
  let dir: string;

  beforeAll(async () => {
    await ensureSharedBinary();
    dir = testRoot('topo');
    engine = createEngine({
      dataDir: dir,
      binaryCacheDir: SHARED_BIN_CACHE,
      healthTimeoutMs: 120_000,
    });
  }, 300_000);

  afterAll(async () => {
    try {
      for (const n of engine.networks.list()) {
        if (n.status === 'running' || n.status === 'starting') {
          await engine.networks.stop(n.id).catch(() => undefined);
        }
      }
    } finally {
      await engine.processes.killAll();
      await engine.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'four-validator: patched 4-authority genesis → 4 real validators, full mesh, all author blocks, finality',
    async () => {
      const net = await engine.networks.create({ name: 'it-4val', preset: 'four-validator' });
      expect(net.chain).toBe('local-spec');
      expect(fs.existsSync(net.chainSpecPath ?? '')).toBe(true);

      // Genesis surgery evidence: the raw spec was generated from a patched
      // plain spec carrying FOUR authorities (not the base spec's two).
      const sidecar = JSON.parse(
        fs.readFileSync(path.join(net.baseDir, 'chain-spec.genesis.json'), 'utf8'),
      ) as { validatorCount: number; authorities: Array<{ key: string; account: string; grandpa: string }> };
      expect(sidecar.validatorCount).toBe(4);
      expect(sidecar.authorities.map((a) => a.key)).toEqual(['alice', 'bob', 'charlie', 'dave']);
      expect(new Set(sidecar.authorities.map((a) => a.account)).size).toBe(4);
      expect(new Set(sidecar.authorities.map((a) => a.grandpa)).size).toBe(4);

      const { nodes } = engine.networks.getNetwork(net.id);
      expect(nodes).toHaveLength(4);
      expect(nodes.every((n) => n.role === 'validator')).toBe(true);
      expect(nodes.every((n) => n.expectedPeers === 3)).toBe(true);
      expect(nodes[0]?.bootnodes).toEqual([]); // seed first
      expect(nodes.slice(1).every((n) => n.bootnodes.length === 1)).toBe(true);

      const start = await engine.networks.start(net.id);
      expect(start.ok, `start failed: ${JSON.stringify(start.error)}`).toBe(true);

      // Chain identity: one genesis hash across all four nodes.
      const genesisHashes = await Promise.all(nodes.map((n) => genesisHashOf(n.ports.rpc)));
      expect(new Set(genesisHashes).size).toBe(1);

      // Real peer connectivity: full mesh (each node sees the other three).
      await Promise.all(
        nodes.map((n) =>
          waitFor(async () => (await peerCount(n.ports.rpc)) >= 3 || null, {
            timeoutMs: 120_000,
            label: `peers>=3 on ${n.name}`,
          }),
        ),
      );

      // All four authorities really author blocks (BABE rotation, from logs).
      await Promise.all(
        nodes.map((n) =>
          waitFor(async () => (countInFile(n.logFile, 'Prepared block for proposing') >= 1 ? true : null), {
            timeoutMs: 120_000,
            label: `block authorship on ${n.name}`,
          }),
        ),
      );

      // GRANDPA finality advances on every node (4/4 authorities online).
      await Promise.all(
        nodes.map((n) =>
          waitFor(async () => ((await finalizedNumber(n.ports.rpc)) >= 3 ? true : null), {
            timeoutMs: 180_000,
            label: `finality on ${n.name}`,
          }),
        ),
      );

      // Heads stay close (no isolated node drifting).
      const bests = await Promise.all(nodes.map((n) => bestNumber(n.ports.rpc)));
      expect(Math.max(...bests) - Math.min(...bests)).toBeLessThanOrEqual(3);

      const stop = await engine.networks.stop(net.id);
      expect(stop.ok).toBe(true);
      for (const n of engine.networks.getNetwork(net.id).nodes) {
        expect(isPidAlive(n.pid ?? 0)).toBe(false);
      }
      await engine.networks.remove(net.id);
    },
    600_000,
  );

  it(
    'validator-fullnode: 3 validators + 1 full node — full node syncs, peers, authors NOTHING',
    async () => {
      const net = await engine.networks.create({ name: 'it-vfn', preset: 'validator-fullnode' });
      const { nodes } = engine.networks.getNetwork(net.id);
      expect(nodes).toHaveLength(4);
      expect(nodes.filter((n) => n.role === 'validator')).toHaveLength(3);
      const full = nodes.find((n) => n.role === 'full');
      expect(full).toBeDefined();
      expect(full?.wellKnownKey).toBeUndefined(); // keyless: cannot be an authority

      const sidecar = JSON.parse(
        fs.readFileSync(path.join(net.baseDir, 'chain-spec.genesis.json'), 'utf8'),
      ) as { validatorCount: number };
      expect(sidecar.validatorCount).toBe(3);

      const start = await engine.networks.start(net.id);
      expect(start.ok, `start failed: ${JSON.stringify(start.error)}`).toBe(true);

      // The full node connects to all three validators…
      await waitFor(async () => ((full ? await peerCount(full.ports.rpc) : 0) >= 3 || null), {
        timeoutMs: 120_000,
        label: 'full node peers>=3',
      });
      // …syncs the chain…
      await waitFor(
        async () => {
          if (!full) return null;
          const fullHead = await bestNumber(full.ports.rpc);
          const validatorBests = await Promise.all(
            nodes.filter((n) => n.role === 'validator').map((n) => bestNumber(n.ports.rpc)),
          );
          return Math.max(...validatorBests) - fullHead <= 3 ? true : null;
        },
        { timeoutMs: 120_000, label: 'full node syncs to validators' },
      );
      // …and finality runs on the validators.
      await waitFor(
        async () => {
          const finals = await Promise.all(
            nodes.filter((n) => n.role === 'validator').map((n) => finalizedNumber(n.ports.rpc)),
          );
          return Math.min(...finals) >= 2 ? true : null;
        },
        { timeoutMs: 180_000, label: 'validator finality' },
      );
      // After all that progress, the full node has authored NOTHING.
      expect(full ? countInFile(full.logFile, 'Prepared block for proposing') : 0).toBe(0);

      await engine.networks.stop(net.id);
      await engine.networks.remove(net.id);
    },
    600_000,
  );

  it('custom: validated node list is persisted as real node configs', async () => {
    const net = await engine.networks.create({
      name: 'it-custom',
      preset: 'custom',
      custom: {
        nodes: [
          { name: 'seed', role: 'validator', wellKnownKey: 'alice' },
          { name: 'mate', role: 'validator', wellKnownKey: 'bob' },
          { name: 'observer', role: 'full' },
        ],
      },
    });
    const { nodes } = engine.networks.getNetwork(net.id);
    expect(nodes.map((n) => n.name)).toEqual(['it-custom-seed', 'it-custom-mate', 'it-custom-observer']);
    expect(nodes.map((n) => n.role)).toEqual(['validator', 'validator', 'full']);
    expect(nodes.map((n) => n.wellKnownKey)).toEqual(['alice', 'bob', undefined]);
    expect(nodes.every((n) => n.expectedPeers === 2)).toBe(true);
    // alice+bob are the base genesis authorities → no patch sidecar needed.
    expect(fs.existsSync(path.join(net.baseDir, 'chain-spec.genesis.json'))).toBe(false);
    expect(fs.existsSync(net.chainSpecPath ?? '')).toBe(true);
    // per-node unique data dirs + key files
    const dirs = nodes.map((n) => n.baseDir);
    expect(new Set(dirs).size).toBe(3);
    for (const n of nodes) expect(fs.existsSync(n.nodeKeyFile)).toBe(true);
    await engine.networks.remove(net.id);
  }, 180_000);

  it('rejects invalid topologies BEFORE creating anything (no debris)', async () => {
    const networksBefore = engine.networks.list().length;
    const networksDir = path.join(dir, 'networks');
    const dirsBefore = fs.existsSync(networksDir) ? fs.readdirSync(networksDir).length : 0;
    try {
      await engine.networks.create({
        name: 'it-badtopo',
        preset: 'custom',
        custom: {
          nodes: [
            { name: 'v1', role: 'validator', wellKnownKey: 'alice' },
            { name: 'v2', role: 'validator', wellKnownKey: 'alice' }, // duplicate key
          ],
        },
      });
      expect.unreachable('duplicate-key topology must be rejected');
    } catch (e) {
      expect(isKaizenError(e)).toBe(true);
      if (isKaizenError(e)) expect(e.code).toBe('INVALID_INPUT');
    }
    expect(engine.networks.list().length).toBe(networksBefore);
    const dirsAfter = fs.existsSync(networksDir) ? fs.readdirSync(networksDir).length : 0;
    expect(dirsAfter).toBe(dirsBefore); // failed create left no network dir
  }, 60_000);

  it(
    'purge: refuses while running; after stop, wipes chain data; restart boots from genesis',
    async () => {
      const net = await engine.networks.create({ name: 'it-purge', preset: 'single-node' });
      const { nodes } = engine.networks.getNetwork(net.id);
      const start = await engine.networks.start(net.id);
      expect(start.ok).toBe(true);

      // purge must refuse while processes are alive
      await expect(engine.networks.purgeChain(net.id)).rejects.toThrow(/still running/);

      await waitFor(async () => ((await bestNumber(nodes[0]!.ports.rpc)) >= 2 ? true : null), {
        timeoutMs: 120_000,
        label: 'chain progress before purge',
      });
      await engine.networks.stop(net.id);

      const purge = await engine.networks.purgeChain(net.id);
      expect(purge.ok).toBe(true);
      expect(fs.existsSync(nodes[0]!.baseDir)).toBe(false); // chain DB gone
      // identity survives: node key file + ports + spec remain
      expect(fs.existsSync(nodes[0]!.nodeKeyFile)).toBe(true);
      expect(engine.networks.getNetwork(net.id).nodes[0]?.ports).toEqual(nodes[0]?.ports);

      // restart: chain starts from (near) genesis again
      const restart = await engine.networks.start(net.id);
      expect(restart.ok, `restart failed: ${JSON.stringify(restart.error)}`).toBe(true);
      await waitFor(
        async () => {
          const head = await bestNumber(nodes[0]!.ports.rpc);
          return head >= 1 && head < 30 ? true : null;
        },
        { timeoutMs: 90_000, label: 'fresh chain after purge' },
      );
      await engine.networks.stop(net.id);
      await engine.networks.remove(net.id);
    },
    420_000,
  );

  it('concurrent network creation: unique identities, ports, specs', async () => {
    const make = (name: string) =>
      engine.networks.create({
        name,
        preset: 'custom',
        custom: {
          nodes: [
            { name: 'a', role: 'validator', wellKnownKey: 'alice' },
            { name: 'b', role: 'validator', wellKnownKey: 'bob' },
          ],
        },
      });
    const [n1, n2, n3] = await Promise.all([make('it-cc1'), make('it-cc2'), make('it-cc3')]);
    const ids = [n1, n2, n3].map((n) => n.id);
    expect(new Set(ids).size).toBe(3);

    const allPorts = [n1, n2, n3].flatMap((n) =>
      engine.networks.getNetwork(n.id).nodes.flatMap((node) => [
        node.ports.p2p,
        node.ports.rpc,
        node.ports.ws,
        node.ports.prometheus,
      ]),
    );
    expect(new Set(allPorts).size).toBe(allPorts.length); // no port reuse
    for (const n of [n1, n2, n3]) {
      expect(fs.existsSync(n.chainSpecPath ?? '')).toBe(true);
      await engine.networks.remove(n.id);
    }
  }, 300_000);
});
