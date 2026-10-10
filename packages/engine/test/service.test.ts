/**
 * NetworkService unit tests (T-2.1/T-2.2) — creation flows against a FAKE
 * node binary (injected spawnImpl): topology → chain spec → keys → ports,
 * patched-spec generation, and partial-creation cleanup. No real processes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BinaryManager,
  ChainSpecService,
  EventBus,
  NetworkService,
  NodeProcessManager,
  PortAllocator,
  StateStore,
  isKaizenError,
  type CreateNetworkInput,
} from '@kaizen/engine';

/**
 * Fake portaldot_dev: answers `key generate-node-key`, `key inspect`, and
 * `build-spec` (plain + raw). `FAIL_FROM` makes the Nth generate-node-key
 * call die to exercise partial-creation cleanup.
 */
function fakeBinaryScript(failFrom?: number): string {
  return `
const fs = require('fs');
const args = process.argv.slice(1);
if (args[0] === 'build-spec') {
  if (args.includes('--raw')) { process.stdout.write('{}'); process.exit(0); }
  process.stdout.write(JSON.stringify({
    name: 'Local Testnet', id: 'local_testnet', chainType: 'Local',
    genesis: { runtime: {
      session: { keys: [
        ['5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY','5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',{grandpa:'5FA9nQDVg267DEd8m1ZypXLBnvN7SFxYwV7ndqSYGiN9TTpu',babe:'5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',im_online:'5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',authority_discovery:'5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'}],
        ['5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty','5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',{grandpa:'5GoNkf6WdbxCFnPdAnYYQyCjAKPJgLNxXwPjwTh6DGg6gN3E',babe:'5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',im_online:'5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',authority_discovery:'5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty'}]
      ] },
      staking: { validatorCount: 2, minimumValidatorCount: 2,
        invulnerables: ['5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY','5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty'],
        stakers: [
          ['5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY','5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',3000000000000000000,'Validator'],
          ['5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty','5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',3000000000000000000,'Validator']
        ] },
      balances: { balances: [] }
    } }
  }));
  process.exit(0);
}
if (args[0] === 'key' && args[1] === 'generate-node-key') {
  const f = process.env.KAIZEN_FAKE_CALLS;
  let n = 0;
  try { n = Number(fs.readFileSync(f, 'utf8')); } catch {}
  n += 1;
  fs.writeFileSync(f, String(n));
  if (n >= ${failFrom ?? Number.MAX_SAFE_INTEGER}) {
    process.stderr.write('simulated key generation failure\\n');
    process.exit(1);
  }
  const idx = args.indexOf('--file');
  fs.writeFileSync(args[idx + 1], 'fake-secret');
  process.stderr.write('12D3KooWFakePeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n');
  process.exit(0);
}
if (args[0] === 'key' && args[1] === 'inspect') {
  const ed = args.includes('--scheme');
  process.stdout.write(
    '  Public key (SS58): x\\n  SS58 Address:      ' +
    (ed ? '5DbKjhNLpqX3zqZdNBc9BGb4fHU1cRBaDhJUskrvkwfraDi6' : '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y') +
    '\\n'
  );
  process.exit(0);
}
process.stderr.write('fake binary: unknown args ' + JSON.stringify(args) + '\\n');
process.exit(1);
`;
}

function makeService(dir: string, failFrom?: number) {
  const callsFile = path.join(dir, 'fake-calls.txt');
  fs.writeFileSync(callsFile, '0');
  const spawnImpl = ((_cmd: string, _args: string[]) =>
    spawn(process.execPath, ['-e', fakeBinaryScript(failFrom), ..._args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KAIZEN_FAKE_CALLS: callsFile },
    })) as unknown as typeof spawn;
  const binaries = {
    status: async () => ({ available: true, problems: [], entry: null }),
    nodePath: () => '/fake/portaldot_dev',
  } as unknown as BinaryManager;
  const store = new StateStore(':memory:');
  const events = new EventBus();
  const processes = new NodeProcessManager();
  const ports = new PortAllocator({
    p2p: { start: 45100, end: 45199 },
    rpc: { start: 45200, end: 45299 },
    ws: { start: 45300, end: 45399 },
    prometheus: { start: 45400, end: 45499 },
  });
  const chainSpecs = new ChainSpecService({ binaries, spawnImpl });
  const networks = new NetworkService({
    store,
    binaries,
    processes,
    events,
    ports,
    dataDir: dir,
    spawnImpl,
    chainSpecs,
  });
  return { networks, store, events, ports };
}

const roots: string[] = [];
function freshRoot(): string {
  const dir = path.join(os.tmpdir(), 'kaizen-svc-test', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('NetworkService.create (fake binary)', () => {
  it('builds a four-validator network: patched spec, 4 keys, unique ports, wired bootnodes', async () => {
    const dir = freshRoot();
    const { networks, store } = makeService(dir);
    const input: CreateNetworkInput = { name: 'svc-4val', preset: 'four-validator' };
    const net = await networks.create(input);

    expect(net.chain).toBe('local-spec');
    expect(fs.existsSync(net.chainSpecPath ?? '')).toBe(true);

    const sidecar = JSON.parse(
      fs.readFileSync(path.join(net.baseDir, 'chain-spec.genesis.json'), 'utf8'),
    ) as { validatorCount: number; authorities: Array<{ key: string }> };
    expect(sidecar.validatorCount).toBe(4);
    expect(sidecar.authorities.map((a) => a.key)).toEqual(['alice', 'bob', 'charlie', 'dave']);

    const nodes = store.listNodes(net.id);
    expect(nodes).toHaveLength(4);
    expect(nodes.every((n) => n.role === 'validator')).toBe(true);
    expect(nodes.every((n) => n.expectedPeers === 3)).toBe(true);
    expect(nodes[0]?.bootnodes).toEqual([]);
    for (const node of nodes.slice(1)) {
      expect(node.bootnodes[0]).toContain(`/p2p/12D3KooWFakePeer`);
      expect(node.bootnodes[0]).toContain(String(nodes[0]?.ports.p2p));
    }
    const allPorts = nodes.flatMap((n) => [n.ports.p2p, n.ports.rpc, n.ports.ws, n.ports.prometheus]);
    expect(new Set(allPorts).size).toBe(16);
    expect(fs.existsSync(nodes[0]!.nodeKeyFile)).toBe(true);
    expect(fs.existsSync(path.join(net.baseDir, 'chain-spec-plain.json'))).toBe(true);
  }, 30_000);

  it('builds a custom full-node network without patching genesis (alice+bob only)', async () => {
    const dir = freshRoot();
    const { networks, store } = makeService(dir);
    const net = await networks.create({
      name: 'svc-custom',
      preset: 'custom',
      custom: {
        nodes: [
          { name: 'v1', role: 'validator', wellKnownKey: 'alice' },
          { name: 'watcher', role: 'full' },
        ],
      },
    });
    const nodes = store.listNodes(net.id);
    expect(nodes.map((n) => n.role)).toEqual(['validator', 'full']);
    expect(nodes[1]?.wellKnownKey).toBeUndefined();
    expect(nodes[1]?.expectedPeers).toBe(1);
    // no patch sidecar for pure genesis authorities
    expect(fs.existsSync(path.join(net.baseDir, 'chain-spec.genesis.json'))).toBe(false);
  }, 30_000);

  it('cleans up completely when creation fails partway (no dirs, no network row)', async () => {
    const dir = freshRoot();
    const { networks, store } = makeService(dir, /* failFrom = */ 3); // dies building node c's key
    const networksDir = path.join(dir, 'networks');
    try {
      await networks.create({ name: 'svc-fail', preset: 'four-validator' });
      expect.unreachable('create should fail when key generation dies');
    } catch (e) {
      expect(isKaizenError(e)).toBe(true);
      if (isKaizenError(e)) expect(e.code).toBe('INTERNAL');
    }
    // no network persisted, no dirs left behind
    expect(store.tryGetNetwork('svc-fail')).toBeUndefined();
    const leftovers = fs.existsSync(networksDir) ? fs.readdirSync(networksDir) : [];
    expect(leftovers).toEqual([]);
    expect(fs.existsSync(networksDir)).toBe(false); // even the parent dir is gone

    // …and the system recovers: a fresh create (new service, reset call
    // counter) succeeds afterwards.
    const retry = makeService(dir);
    const ok = await retry.networks.create({ name: 'svc-after', preset: 'two-node' });
    expect(retry.store.listNodes(ok.id).length).toBe(2);
    void store;
  }, 30_000);
});
