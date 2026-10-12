/**
 * T-3.1 failure-mechanism feasibility spike (Phase 3A).
 *
 * A STANDALONE experiment harness — deliberately NOT part of the production
 * engine path. It drives existing engine services (create/start/stop) and
 * observes real portaldot_dev processes via RPC/process state. It never
 * modifies the engine, API, or UI.
 *
 * Safety invariants (all enforced here):
 *  - refuses to induce any fault unless the target network is
 *    `designatedTest` (DEC-008 gate preserved)
 *  - every SIGSTOP is registered and un-CONTed on ANY exit path
 *    (normal, error, SIGINT/SIGTERM) — no paused nodes can leak
 *  - all spawned helpers (socat, manual nodes) are killed in finally
 *  - argv arrays only, never shell strings
 *
 * Usage:  node test/experiments/t31-spike.mjs <subcommand>
 *         (subcommands: a-pause, b-peer, b-peer-reserved, c-partition,
 *          c-partition-reserved, c-partition-mdns, c-iptables,
 *          c-iptables-cgroup, c-netns, d-terminate, rpc-probe — see
 *          docs/TESTING.md §10)
 * Requires: `npm run build` first (imports the built engine) and the binary
 * cache at $KAIZEN_TEST_BIN_DIR or <tmpdir>/kaizen-test-bin.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  createEngine,
  buildNodeArgs,
  isPidAlive,
  httpUrlForPort,
} from '@kaizen/engine';

// ---- globals & guaranteed cleanup -----------------------------------------

// honors $TMPDIR like the rest of the test suite (testkit.ts convention)
const TMP_ROOT = os.tmpdir();
const BIN_CACHE = process.env.KAIZEN_TEST_BIN_DIR ?? path.join(TMP_ROOT, 'kaizen-test-bin');
const registry = { stoppedPids: new Set(), spawned: [], engine: null, dirs: [], iptablesRules: [], netnsCleanup: [], pkillPatterns: new Set(), cgroup: null };

function log(...a) {
  console.log(`[t31 ${new Date().toISOString()}]`, ...a);
}

async function emergencyCleanup() {
  for (const pid of registry.stoppedPids) {
    try {
      process.kill(pid, 'SIGCONT');
    } catch { /* already dead */ }
  }
  registry.stoppedPids.clear();
  for (const child of registry.spawned) {
    try {
      if (child.detached && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* already dead */ }
  }
  if (registry.engine) {
    try {
      await registry.engine.processes.killAll();
      await registry.engine.close();
    } catch { /* best effort */ }
  }
  // privileged-state rollback: firewall rules first, then netns/veth
  for (const rule of registry.iptablesRules) {
    try {
      spawnSync('sudo', ['-n', ...rule], { encoding: 'utf8' });
    } catch { /* best effort */ }
  }
  registry.iptablesRules.length = 0;
  for (const cmd of registry.netnsCleanup) {
    try {
      spawnSync('sudo', ['-n', ...cmd], { encoding: 'utf8' });
    } catch { /* best effort */ }
  }
  registry.netnsCleanup.length = 0;
  for (const pattern of registry.pkillPatterns) {
    try {
      spawnSync('sudo', ['-n', 'pkill', '-9', '-f', pattern], { encoding: 'utf8' });
    } catch { /* best effort */ }
  }
  // cgroup rollback: return any survivors to the root cgroup, then rmdir
  if (registry.cgroup) {
    try {
      const procs = fs.readFileSync(`${registry.cgroup.path}/cgroup.procs`, 'utf8');
      for (const pid of procs.split('\n').map((s) => s.trim()).filter(Boolean)) {
        spawnSync('sudo', ['-n', 'tee', '/sys/fs/cgroup/cgroup.procs'], { input: pid, encoding: 'utf8' });
      }
      spawnSync('sudo', ['-n', 'rmdir', registry.cgroup.path], { encoding: 'utf8' });
    } catch { /* best effort */ }
    registry.cgroup = null;
  }
  for (const dir of registry.dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

process.on('SIGINT', () => { void emergencyCleanup().finally(() => process.exit(130)); });
process.on('SIGTERM', () => { void emergencyCleanup().finally(() => process.exit(143)); });

// ---- small helpers --------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(port, method, params = [], timeoutMs = 4_000) {
  const res = await fetch(httpUrlForPort(port), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function tryRpc(port, method, params = [], timeoutMs = 4_000) {
  try {
    return { ok: true, result: await rpc(port, method, params, timeoutMs) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
}

const hexNum = (h) => (typeof h === 'string' ? parseInt(h, 16) : -1);

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

// ---- experiment scaffolding ----------------------------------------------

async function setup({ name, preset }) {
  const dir = path.join(TMP_ROOT, `t31-${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  registry.dirs.push(dir);
  const engine = createEngine({ dataDir: dir, binaryCacheDir: BIN_CACHE });
  registry.engine = engine;
  const network = await engine.networks.create({ name: `t31-${name}`, preset });
  if (network.designatedTest !== true) {
    throw new Error('SAFETY: target network is not designatedTest — refusing');
  }
  const start = await engine.networks.start(network.id);
  if (!start.ok) throw new Error(`setup: network start failed: ${JSON.stringify(start.error)}`);
  log(`setup: network ${network.id} (${preset}, designatedTest=true) RUNNING, dataDir=${dir}`);
  return { engine, network };
}

function nodeRecords(engine, networkId) {
  const { nodes } = engine.networks.getNetwork(networkId);
  return nodes;
}

async function baseline(engine, networkId) {
  const nodes = nodeRecords(engine, networkId);
  const rows = [];
  for (const n of nodes) {
    const peers = await tryRpc(n.ports.rpc, 'system_peers');
    const head = await tryRpc(n.ports.rpc, 'chain_getHeader', ['0x0']);
    const headNow = await tryRpc(n.ports.rpc, 'chain_getHeader');
    rows.push({
      name: n.name, id: n.id, pid: n.pid, alive: isPidAlive(n.pid),
      peers: peers.ok ? peers.result.length : `ERR ${peers.error}`,
      genesis: head.ok ? head.result.hash?.slice(0, 12) : 'ERR',
      head: headNow.ok ? hexNum(headNow.result?.number) : 'ERR',
      ports: n.ports,
    });
  }
  const snap = await engine.monitoring.snapshotNow(networkId);
  log('baseline nodes:', JSON.stringify(rows, null, 1));
  log('baseline health:', snap.health.map((h) => `${h.nodeId.split('-').pop()}:${h.state}`).join(' '));
  return { rows, snap };
}

/** One observation tick: process liveness + RPC + peers + head + monitor state. */
async function tick(engine, networkId, extra = {}) {
  const nodes = nodeRecords(engine, networkId);
  const out = [];
  for (const n of nodes) {
    const peers = await tryRpc(n.ports.rpc, 'system_peers', [], 2_500);
    const head = await tryRpc(n.ports.rpc, 'chain_getHeader', [], 2_500);
    out.push({
      node: n.name.split('-').pop(),
      alive: isPidAlive(n.pid),
      rpc: peers.ok ? 'up' : 'down',
      peers: peers.ok ? peers.result.map((p) => p.peerId.slice(0, 10)).join(',') : '-',
      head: head.ok ? hexNum(head.result?.number) : '-',
      ...extra,
    });
  }
  const snap = await engine.monitoring.snapshotNow(networkId);
  for (const row of out) {
    const h = snap.health.find((x) => x.nodeId.endsWith(`-${row.node}`)) ??
      snap.health.find((x) => snap.samples.find((s) => s.nodeId === x.nodeId)?.name.endsWith(`-${row.node}`));
    row.health = h?.state ?? '?';
    row.reasons = (h?.reasons ?? []).join(';').slice(0, 90);
  }
  log('tick:', JSON.stringify(out));
  return out;
}

async function observe(engine, networkId, seconds, intervalMs = 3_000, extra = {}) {
  const end = Date.now() + seconds * 1_000;
  const all = [];
  while (Date.now() < end) {
    all.push(...await tick(engine, networkId, extra));
    await sleep(intervalMs);
  }
  return all;
}

// ---- A: SIGSTOP / SIGCONT pause ------------------------------------------

async function expAPause() {
  const { engine, network } = await setup({ name: 'pause', preset: 'two-node' });
  try {
    await baseline(engine, network.id);
    const [alice, bob] = nodeRecords(engine, network.id);
    log(`A: pausing ${alice.name} (pid ${alice.pid}) with SIGSTOP`);
    registry.stoppedPids.add(alice.pid);
    process.kill(alice.pid, 'SIGSTOP');

    await observe(engine, network.id, 45, 3_000, { phase: 'paused' });
    log('A: pid alive during pause?', isPidAlive(alice.pid));

    log('A: resuming with SIGCONT');
    process.kill(alice.pid, 'SIGCONT');
    registry.stoppedPids.delete(alice.pid);
    await observe(engine, network.id, 45, 3_000, { phase: 'resumed' });

    // recovery check: both healthy + heads advancing again
    const t1 = await tick(engine, network.id);
    await sleep(10_000);
    const t2 = await tick(engine, network.id);
    const advanced = t2.every((r, i) => r.head === '-' || t1[i].head === '-' || r.head >= t1[i].head);
    log(`A: recovery — heads non-regressing=${advanced}; states=${t2.map((r) => r.health).join(',')}`);
    void bob;
  } finally {
    await engine.networks.stop(network.id).catch(() => {});
    await engine.networks.remove(network.id).catch(() => {});
  }
}

// ---- B: peer disconnect via reserved-peer RPC -----------------------------

async function expBPeer() {
  const { engine, network } = await setup({ name: 'peer', preset: 'two-node' });
  try {
    const [alice, bob] = nodeRecords(engine, network.id);
    await baseline(engine, network.id);

    const methods = await rpc(alice.ports.rpc, 'rpc_methods');
    const names = (methods.methods ?? []).map((m) => m.name ?? m);
    log('B: system_* methods:', names.filter((n) => String(n).startsWith('system_')).join(' '));

    const bobPeerId = await rpc(bob.ports.rpc, 'system_localPeerId');
    log('B: bob peer id =', bobPeerId);

    // Path 1: bare peer id — this build's RPC layer parses multiaddrs only.
    const addBare = await tryRpc(alice.ports.rpc, 'system_addReservedPeer', [bobPeerId]);
    log('B: addReservedPeer(bare peer id) →', JSON.stringify(addBare).slice(0, 200));

    // Path 2: full multiaddr (the correct form for this build).
    const bobMultiaddr = `/ip4/127.0.0.1/tcp/${bob.ports.p2p}/p2p/${bobPeerId}`;
    const add = await tryRpc(alice.ports.rpc, 'system_addReservedPeer', [bobMultiaddr]);
    log(`B: addReservedPeer(${bobMultiaddr}) →`, JSON.stringify(add).slice(0, 200));
    const reserved = await tryRpc(alice.ports.rpc, 'system_reservedPeers');
    log('B: system_reservedPeers on alice →', JSON.stringify(reserved).slice(0, 200));

    const rm = await tryRpc(alice.ports.rpc, 'system_removeReservedPeer', [bobPeerId]);
    log('B: removeReservedPeer(bob peer id) →', JSON.stringify(rm).slice(0, 200));
    const reservedAfter = await tryRpc(alice.ports.rpc, 'system_reservedPeers');
    log('B: system_reservedPeers after remove →', JSON.stringify(reservedAfter).slice(0, 200));

    log('B: watching both nodes for disconnect evidence (60s)…');
    const ticks = await observe(engine, network.id, 60, 3_000, { phase: 'post-remove' });
    const alicePeers = ticks.filter((t) => t.node === 'alice').map((t) => t.peers);
    log('B: alice peer sets over time:', alicePeers.join(' | '));
    const bobPeers = ticks.filter((t) => t.node === 'bob').map((t) => t.peers);
    log('B: bob peer sets over time:', bobPeers.join(' | '));
    const everZero = alicePeers.some((p) => p === '' || p === '-');
    log(`B: VERDICT removeReservedPeer disconnected the live (reserved) connection: ${everZero}`);
  } finally {
    await engine.networks.stop(network.id).catch(() => {});
    await engine.networks.remove(network.id).catch(() => {});
  }
}

// ---- B2: removeReservedPeer on a reserved-only node (reservation-bound) --
//
// B showed removeReservedPeer only clears set membership for a normal
// (discovery-maintained) connection. On a --reserved-only node the
// connection exists ONLY because of the reservation — test whether removal
// there actually closes the live connection.

async function expBReserved() {
  const { engine, network } = await setup({ name: 'peer-res', preset: 'two-node' });
  try {
    const [alice] = nodeRecords(engine, network.id);
    await baseline(engine, network.id);
    const alicePeerId = await rpc(alice.ports.rpc, 'system_localPeerId');
    const binary = engine.binaries.nodePath();
    const workdir = registry.dirs[0];
    const ports = { p2p: await freePort(), rpc: await freePort(), ws: await freePort(), prometheus: await freePort() };
    const directMultiaddr = `/ip4/127.0.0.1/tcp/${alice.ports.p2p}/p2p/${alicePeerId}`;

    const rsv = await manualNode({
      binary, name: 'spike-rsv', specPath: network.chainSpecPath,
      baseDir: path.join(workdir, 'spike-rsv'),
      ports,
      bootnodes: [directMultiaddr],
      extraArgs: ['--no-mdns', '--reserved-only', '--reserved-nodes', directMultiaddr],
    });
    log(`B2: reserved-only spike-rsv peerId=${rsv.peerId}; alice=${alicePeerId}`);

    // wait for attachment (rsv has exactly one allowed peer: alice)
    const deadline = Date.now() + 90_000;
    let attached = false;
    while (Date.now() < deadline) {
      const r = await tryRpc(ports.rpc, 'system_peers');
      if (r.ok && r.result.length === 1) { attached = true; break; }
      await sleep(3_000);
    }
    if (!attached) throw new Error('B2: spike-rsv never attached to alice');
    const reservedBefore = await tryRpc(ports.rpc, 'system_reservedPeers');
    log('B2: PRE-REMOVE reserved set on spike-rsv:', JSON.stringify(reservedBefore).slice(0, 160));

    log('B2: calling system_removeReservedPeer(alice) ON the reserved-only node…');
    const rm = await tryRpc(ports.rpc, 'system_removeReservedPeer', [alicePeerId]);
    log('B2: removeReservedPeer →', JSON.stringify(rm).slice(0, 160));
    const reservedAfter = await tryRpc(ports.rpc, 'system_reservedPeers');
    log('B2: reserved set after remove:', JSON.stringify(reservedAfter).slice(0, 160));

    const seen = [];
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      const b = await tryRpc(ports.rpc, 'system_peers');
      const a = await tryRpc(alice.ports.rpc, 'system_peers');
      seen.push({
        t: `${Math.round((60_000 - (end - Date.now())) / 1000)}s`,
        rsv: b.ok ? b.result.length : 'down',
        aliceSeesRsv: a.ok ? a.result.some((p) => p.peerId === rsv.peerId) : '?',
      });
      await sleep(3_000);
    }
    log('B2: timeline:', JSON.stringify(seen));
    const firstDrop = seen.findIndex((s) => s.rsv === 0 || s.aliceSeesRsv === false);
    log(`B2: VERDICT removeReservedPeer disconnected the reservation-bound live connection: ${firstDrop >= 0} (at ${firstDrop >= 0 ? seen[firstDrop].t : 'never'})`);

    rsv.child.kill('SIGKILL');
    await sleep(500);
  } finally {
    await engine.networks.stop(network.id).catch(() => {});
    await engine.networks.remove(network.id).catch(() => {});
  }
}

// ---- C: partition via per-node TCP proxy cut (no privileges) --------------
// mode 'bootnode' → victim reaches alice only via bootnode+proxy (kad on)
// mode 'reserved' → victim is --reserved-only with reserved-nodes=proxy
//                   (discovery off, only the reserved multiaddr may be dialed)

function ssEstablished(...needles) {
  try {
    const out = spawnSync('ss', ['-tn', 'state', 'established'], { encoding: 'utf8' });
    return (out.stdout ?? '')
      .split('\n')
      .filter((l) => needles.some((n) => l.includes(n)))
      .map((l) => l.replace(/\s+/g, ' ').trim());
  } catch {
    return ['ss unavailable'];
  }
}

/** `ss -tnp` with process attribution (own processes → no sudo needed). */
function ssWithPid(...needles) {
  try {
    const out = spawnSync('ss', ['-tnp', 'state', 'established'], { encoding: 'utf8' });
    return (out.stdout ?? '')
      .split('\n')
      .filter((l) => needles.length === 0 || needles.some((n) => l.includes(n)))
      .map((l) => l.replace(/\s+/g, ' ').trim());
  } catch {
    return [];
  }
}

/** Run an argv command under passwordless sudo -n; never a shell string. */
function sudoSync(argv) {
  const r = spawnSync('sudo', ['-n', ...argv], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** JSON-RPC read of a node running inside a named network namespace. */
function nsRpc(ns, port, method, params = [], timeoutSec = 3) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const r = spawnSync('sudo', ['-n', 'ip', 'netns', 'exec', ns,
    'curl', '-s', '-m', String(timeoutSec),
    '-H', 'Content-Type: application/json', '-X', 'POST', '--data', payload,
    `http://127.0.0.1:${port}`], { encoding: 'utf8' });
  try {
    const j = JSON.parse(r.stdout);
    if (j.error) return { ok: false, error: JSON.stringify(j.error).slice(0, 120) };
    return { ok: true, result: j.result };
  } catch {
    return { ok: false, error: (r.err ?? r.stdout ?? '').slice(0, 120) || 'no response' };
  }
}

async function manualNode({ binary, name, key, specPath, baseDir, ports, bootnodes, extraArgs = [], netns = null }) {
  fs.mkdirSync(baseDir, { recursive: true });
  const keyFile = path.join(baseDir, 'node.key');
  const gen = spawnSync(binary, ['key', 'generate-node-key', '--file', keyFile], { encoding: 'utf8' });
  // peer id is printed to stderr; same regex the engine uses (service.ts)
  const match = `${gen.stdout ?? ''}\n${gen.stderr ?? ''}`.match(/1[2-9][A-Za-z0-9]{45,}/);
  if (!match) throw new Error(`C: could not parse peer id for ${name}: ${(gen.stderr ?? '').slice(0, 200)}`);
  const peerId = match[0];
  const args = buildNodeArgs({
    name, baseDir, ports,
    chain: { specPath },
    wellKnownKey: key,
    bootnodes,
    nodeKeyFile: keyFile,
  });
  args.push(...extraArgs);
  const logFile = path.join(baseDir, 'node.log');
  const fd = fs.openSync(logFile, 'a');
  const child = netns
    ? spawn('sudo', ['-n', 'ip', 'netns', 'exec', netns, binary, ...args], { stdio: ['ignore', fd, fd] })
    : spawn(binary, args, { stdio: ['ignore', fd, fd] });
  registry.spawned.push(child);
  log(`C: spawned ${name} (pid ${child.pid}) bootnodes=${bootnodes.join(',')}`);
  return { child, peerId, logFile, ports, baseDir };
}

async function expCPartition(mode = 'bootnode') {
  // two-node preset → a real shared chain spec (single-node is a --dev chain
  // with no spec file). Engine manages alice+bob0; the experiment adds two
  // keyless manual peers: spike-cut (via proxy) and spike-keep (direct).
  const { engine, network } = await setup({ name: `part-${mode}`, preset: 'two-node' });
  try {
    const [alice] = nodeRecords(engine, network.id);
    await baseline(engine, network.id);
    const alicePeerId = await rpc(alice.ports.rpc, 'system_localPeerId');
    const binary = engine.binaries.nodePath();
    const workdir = registry.dirs[0];

    const proxyPort = await freePort();
    const cutPorts = { p2p: await freePort(), rpc: await freePort(), ws: await freePort(), prometheus: await freePort() };
    const keepPorts = { p2p: await freePort(), rpc: await freePort(), ws: await freePort(), prometheus: await freePort() };
    for (const p of [proxyPort, ...Object.values(cutPorts), ...Object.values(keepPorts)]) {
      if (!(await portFree(p))) throw new Error(`port ${p} not free`);
    }

    const proxyMultiaddr = `/ip4/127.0.0.1/tcp/${proxyPort}/p2p/${alicePeerId}`;
    const directMultiaddr = `/ip4/127.0.0.1/tcp/${alice.ports.p2p}/p2p/${alicePeerId}`;

    // socat = the per-node p2p proxy: spike-cut's bootnode route to alice.
    // detached → its own process group, so killing -pid takes the forked
    // per-connection children too (a listener-only kill leaves them alive).
    const socat = spawn('socat', [
      `TCP-LISTEN:${proxyPort},reuseaddr,fork`,
      `TCP:127.0.0.1:${alice.ports.p2p}`,
    ], { stdio: 'ignore', detached: true });
    registry.spawned.push(socat);
    registry.spawnedGroups ??= new Set();
    registry.spawnedGroups.add(socat.pid);
    log(`C: proxy socat pid ${socat.pid}: :${proxyPort} → 127.0.0.1:${alice.ports.p2p}`);
    await sleep(500);

    const cutNode = await manualNode({
      binary, name: 'spike-cut', specPath: network.chainSpecPath,
      baseDir: path.join(workdir, 'spike-cut'),
      ports: cutPorts,
      bootnodes: [proxyMultiaddr],
      // mDNS is default-ON for non-dev chains and would bypass the proxy
      // entirely — 'mdns' mode deliberately leaves it on to demonstrate the
      // bypass; 'reserved' mode pins the victim to the proxied multiaddr only.
      extraArgs: mode === 'reserved'
        ? ['--no-mdns', '--reserved-only', '--reserved-nodes', proxyMultiaddr]
        : mode === 'mdns'
          ? []
          : ['--no-mdns'],
    });
    const keepNode = await manualNode({
      binary, name: 'spike-keep', specPath: network.chainSpecPath,
      baseDir: path.join(workdir, 'spike-keep'),
      ports: keepPorts,
      bootnodes: [directMultiaddr],
      extraArgs: ['--no-mdns'],
    });
    log(`C: spike-cut peerId=${cutNode.peerId} spike-keep peerId=${keepNode.peerId}`);

    // wait for both manual peers to attach (alice total = engine-bob + 2)
    const deadline = Date.now() + 120_000;
    let alicePeers = [];
    while (Date.now() < deadline) {
      const r = await tryRpc(alice.ports.rpc, 'system_peers');
      alicePeers = r.ok ? r.result : [];
      if (alicePeers.length >= 3) break;
      await sleep(3_000);
    }
    log('C: PRE-CUT alice peers:', alicePeers.map((p) => p.peerId.slice(0, 14)).join(' '));
    if (alicePeers.length < 3) throw new Error('C: manual peers never attached — aborting');
    log('C: proxied TCP legs (:proxyPort):', JSON.stringify(ssEstablished(`:${proxyPort}`)));
    log('C: spike-cut p2p legs (:cutP2p):', JSON.stringify(ssEstablished(`:${cutPorts.p2p}`)));

    log('C: CUTTING the proxy (kill socat process group) — severs the proxied link');
    try {
      process.kill(-socat.pid, 'SIGKILL'); // negative pid = whole group
    } catch { /* already dead */ }
    const cutTicks = [];
    const cutStart = Date.now();
    while (Date.now() - cutStart < 90_000) {
      const a = await tryRpc(alice.ports.rpc, 'system_peers');
      const b = await tryRpc(cutNode.ports.rpc, 'system_peers');
      const k = await tryRpc(keepNode.ports.rpc, 'system_peers');
      const elapsed = (Date.now() - cutStart) / 1000;
      cutTicks.push({
        t: `${elapsed}s`,
        alice: a.ok ? a.result.map((p) => p.peerId.slice(6, 14)).sort().join('+') : 'down',
        cut: b.ok ? b.result.map((p) => p.peerId.slice(6, 14)).sort().join('+') : 'down',
        keep: k.ok ? k.result.map((p) => p.peerId.slice(6, 14)).sort().join('+') : 'down',
      });
      //1s granularity early (catch transient drops), 5s later
      await sleep(elapsed < 25 ? 1_000 : 5_000);
    }
    log('C: POST-CUT timeline:', JSON.stringify(cutTicks));
    log('C: POST-CUT proxied TCP legs:', JSON.stringify(ssEstablished(`:${proxyPort}`)));
    const firstDrop = cutTicks.findIndex((t) => t.alice.split('+').length < 3);
    log(`C: proxied link severed (alice peer count drops) at: ${firstDrop >= 0 ? cutTicks[firstDrop].t : 'NEVER'}`);
    const last = cutTicks.at(-1);
    const sustained = last.cut.split('+').filter(Boolean).length === 0;
    log(`C: VERDICT sustained isolation of spike-cut without kernel-level help: ${sustained}`);

    log('C: RESTORING the proxy and watching for reconnect');
    const socat2 = spawn('socat', [
      `TCP-LISTEN:${proxyPort},reuseaddr,fork`,
      `TCP:127.0.0.1:${alice.ports.p2p}`,
    ], { stdio: 'ignore', detached: true });
    registry.spawned.push(socat2);
    const rdeadline = Date.now() + 120_000;
    let reconnected = false;
    while (Date.now() < rdeadline) {
      const a = await tryRpc(alice.ports.rpc, 'system_peers');
      if (a.ok && a.result.length === 3) { reconnected = true; break; }
      await sleep(5_000);
    }
    log(`C: VERDICT reconnect after proxy restore: ${reconnected}`);

    // cleanup manual nodes + proxy before engine teardown
    cutNode.child.kill('SIGKILL'); keepNode.child.kill('SIGKILL');
    try {
      process.kill(-socat2.pid, 'SIGKILL');
    } catch { /* already dead */ }
    await sleep(1_000);
  } finally {
    await engine.networks.stop(network.id).catch(() => {});
    await engine.networks.remove(network.id).catch(() => {});
  }
}

// ---- F: kernel isolation via port-scoped iptables (privileged) ------------
// AUTHORIZED for Phase 3A by the operator: narrow, reversible rules scoped
// to ONE designated test node's traffic on loopback. Nothing host-global is
// modified (baseline is empty/-P ACCEPT and is verified after cleanup).
// Every applied rule is registered in registry.iptablesRules and removed on
// ANY exit path (finally + emergency cleanup).

async function expCIptables(mode = 'port') {
  const { engine, network } = await setup({ name: `iptables-${mode}`, preset: 'two-node' });
  let bob = null;
  const deleteRules = () => {
    while (registry.iptablesRules.length > 0) {
      const rule = registry.iptablesRules.pop();
      const r = sudoSync(rule);
      if (!r.ok) log(`F: rule delete FAILED: ${rule.join(' ')} :: ${r.err.slice(0, 100)}`);
    }
  };
  try {
    const [alice, bobNode] = nodeRecords(engine, network.id);
    bob = bobNode;
    await baseline(engine, network.id);
    const binary = engine.binaries.nodePath();
    const workdir = registry.dirs[0];
    const alicePeerId = await rpc(alice.ports.rpc, 'system_localPeerId');

    // unaffected third peer, directly attached to alice
    const keepPorts = { p2p: await freePort(), rpc: await freePort(), ws: await freePort(), prometheus: await freePort() };
    const keep = await manualNode({
      binary, name: 'spike-keep', specPath: network.chainSpecPath,
      baseDir: path.join(workdir, 'spike-keep'), ports: keepPorts,
      bootnodes: [`/ip4/127.0.0.1/tcp/${alice.ports.p2p}/p2p/${alicePeerId}`],
      extraArgs: ['--no-mdns'],
    });
    registry.pkillPatterns.add(path.join(workdir, 'spike-keep'));

    const attachDeadline = Date.now() + 90_000;
    let attached = false;
    while (Date.now() < attachDeadline) {
      const r = await tryRpc(alice.ports.rpc, 'system_peers');
      if (r.ok && r.result.length >= 2) { attached = true; break; }
      await sleep(3_000);
    }
    if (!attached) throw new Error('F: topology (alice+bob+keep) never formed');

    const baselineRules = sudoSync(['iptables', '-S']);
    const baselineRules6 = sudoSync(['ip6tables', '-S']);
    log('F: iptables baseline (chain policies + docker-owned chains):', JSON.stringify(baselineRules.out));
    log('F: ip6tables baseline (expect -P lines):', JSON.stringify(baselineRules6.out));
    const bobPeerId = await rpc(bob.ports.rpc, 'system_localPeerId'); // BEFORE any rules
    // Only p2p-relevant sockets: never bob's RPC/WS/prometheus server ports
    // (dropping those would sever our own observation channel).
    const serverPorts = new Set([bob.ports.rpc, bob.ports.ws, bob.ports.prometheus]);
    const bobSockets = ssWithPid(`pid=${bob.pid},`)
      .filter((l) => l.includes('127.0.0.1'))
      .filter((l) => {
        const local = l.match(/127\.0\.0\.1:(\d+)/);
        return local && !serverPorts.has(Number(local[1]));
      });
    log('F: bob p2p TCP sockets pre-rule:', JSON.stringify(bobSockets));

    const addRule = (bin, argv) => {
      const r = sudoSync([bin, ...argv]);
      log(`F: apply "${bin} ${argv.join(' ')}" → ${r.ok ? 'OK' : `FAIL ${r.err.slice(0, 120)}`}`);
      // -I INSERT takes a position after the chain; -D DELETE must be
      // `-D <chain> <rule-spec...>` (learned: wrong form leaked rules)
      if (r.ok) registry.iptablesRules.push([bin, '-D', argv[1], ...argv.slice(3)]);
    };
    if (mode === 'cgroup') {
      const CG = `/sys/fs/cgroup/t31-${Date.now().toString(36)}`;
      const cgPath = CG.replace('/sys/fs/cgroup', '');
      const mk = sudoSync(['mkdir', '-p', CG]);
      log(`F: cgroup ${CG} create → ${mk.ok ? 'OK' : mk.err.slice(0, 120)}`);
      if (!mk.ok) throw new Error('F: cgroup creation failed');
      const mv = spawnSync('sudo', ['-n', 'tee', `${CG}/cgroup.procs`], { input: String(bob.pid), encoding: 'utf8' });
      log(`F: moved bob (pid ${bob.pid}) into cgroup → ${mv.status === 0 ? 'OK' : String(mv.stderr).slice(0, 120)}`);
      registry.cgroup = { path: CG };

      // Established local ports of bob's sockets — ALL address families and
      // interfaces (this build talks over 127.0.0.1, [::1] AND eth0).
      // server ports (rpc/ws/prometheus) are excluded so observation lives.
      const localPorts = new Set();
      for (const line of ssWithPid(`pid=${bob.pid},`)) {
        const m = line.match(/^\d+\s+\d+\s+(\S+)\s+\S+/);
        if (!m) continue;
        const lm = m[1].match(/:(\d+)$/);
        if (!lm) continue;
        const lp = Number(lm[1]);
        if (!serverPorts.has(lp)) localPorts.add(lp);
      }
      log(`F: bob local ports to seal: ${JSON.stringify([...localPorts])}`);

      // Evidence-derived rule set (f2/f4/f5):
      //  - interface scoping (-i lo) leaks eth0 traffic   → dropped
      //  - --ctdir ORIGINAL is inert on this iptables-nft → not used
      //  - ip6tables is mandatory                         → both families
      for (const bin of ['iptables', 'ip6tables']) {
        addRule(bin, ['-I', 'INPUT', '1', '-p', 'tcp', '--dport', String(bob.ports.p2p), '-j', 'DROP']);
        addRule(bin, ['-I', 'OUTPUT', '1', '-p', 'tcp', '--sport', String(bob.ports.p2p), '-j', 'DROP']);
        for (const lp of localPorts) {
          if (lp === bob.ports.p2p) continue;
          addRule(bin, ['-I', 'OUTPUT', '1', '-p', 'tcp', '--sport', String(lp), '-j', 'DROP']);
          addRule(bin, ['-I', 'INPUT', '1', '-p', 'tcp', '--dport', String(lp), '-j', 'DROP']);
        }
        addRule(bin, ['-I', 'OUTPUT', '1', '-m', 'conntrack', '--ctstate', 'NEW', '-m', 'cgroup', '--path', cgPath, '-j', 'DROP']);
      }
    } else {
      // IPv4-only port scoping (deliberately narrow demonstration)
      addRule('iptables', ['-I', 'INPUT', '1', '-i', 'lo', '-p', 'tcp', '--dport', String(bob.ports.p2p), '-j', 'DROP']);
      addRule('iptables', ['-I', 'OUTPUT', '1', '-o', 'lo', '-p', 'tcp', '--sport', String(bob.ports.p2p), '-j', 'DROP']);
      // every distinct established p2p socket local port bob owns (outbound
      // dials use ephemeral sources on this build — discovered live)
      const extraPorts = new Set();
      for (const line of bobSockets) {
        const local = line.match(/127\.0\.0\.1:(\d+)/);
        if (!local) continue;
        const lport = Number(local[1]);
        if (lport !== bob.ports.p2p) extraPorts.add(lport);
      }
      for (const lport of extraPorts) {
        addRule('iptables', ['-I', 'OUTPUT', '1', '-o', 'lo', '-p', 'tcp', '--sport', String(lport), '-j', 'DROP']);
        addRule('iptables', ['-I', 'INPUT', '1', '-i', 'lo', '-p', 'tcp', '--dport', String(lport), '-j', 'DROP']);
      }
    }

    log('F: observing isolation (alice must lose bob; keep unaffected; bob RPC stays up)…');
    const timeline = [];
    const cutStart = Date.now();
    let dropAt = null;
    while (Date.now() - cutStart < 150_000) {
      const a = await tryRpc(alice.ports.rpc, 'system_peers');
      const k = await tryRpc(keep.ports.rpc, 'system_peers');
      const bView = await tryRpc(bob.ports.rpc, 'system_peers');
      const bRpc = await tryRpc(bob.ports.rpc, 'system_health', [], 2_000);
      const row = {
        t: `${Math.round((Date.now() - cutStart) / 1000)}s`,
        alice: a.ok ? a.result.map((p) => p.peerId.slice(6, 14)).sort().join('+') : 'down',
        keep: k.ok ? k.result.map((p) => p.peerId.slice(6, 14)).sort().join('+') : 'down',
        bobView: bView.ok ? bView.result.map((p) => p.peerId.slice(6, 14)).sort().join('+') : 'down',
        bobRpc: bRpc.ok ? 'up' : 'down',
      };
      timeline.push(row);
      if (dropAt === null && a.ok && !a.result.some((p) => p.peerId === bobPeerId)) dropAt = row.t;
      const elapsed = Math.round((Date.now() - cutStart) / 1000);
      if (elapsed % 15 === 0) {
        log(`F: @${elapsed}s bob sockets: ${JSON.stringify(ssWithPid(`pid=${bob.pid},`))}`);
        if (registry.cgroup) {
          const procs = fs.readFileSync(`${registry.cgroup.path}/cgroup.procs`, 'utf8').trim();
          log(`F: @${elapsed}s cgroup membership: ${JSON.stringify(procs)}`);
        }
      }
      await sleep(5_000);
    }
    log('F: timeline:', JSON.stringify(timeline));
    log(`F: alice lost bob at: ${dropAt ?? 'NEVER'}`);
    const last = timeline.at(-1);
    log(`F: sustained at end — alice=${last.alice} keep=${last.keep} bobView=${last.bobView} bobRpc=${last.bobRpc}`);

    log('F: removing rules (exact -D) and verifying baseline…');
    deleteRules();
    const after = sudoSync(['iptables', '-S']);
    log(`F: iptables after cleanup === baseline: ${after.out === baselineRules.out} (${JSON.stringify(after.out)})`);

    log('F: watching reconvergence (120s)…');
    const reStart = Date.now();
    let reconnected = false;
    while (Date.now() - reStart < 120_000) {
      const a = await tryRpc(alice.ports.rpc, 'system_peers');
      if (a.ok && a.result.length >= 2) { reconnected = true; break; }
      await sleep(5_000);
    }
    log(`F: VERDICT sustained selective isolation + reconvergence after rule removal: drop=${dropAt !== null} reconnected=${reconnected}`);
  } finally {
    deleteRules();
    await engine.networks.stop(network.id).catch(() => {});
    await engine.networks.remove(network.id).catch(() => {});
    if (registry.cgroup) {
      // nodes are dead now: empty cgroup → rmdir works (moving a LIVE
      // process back to root fails EBUSY in this container — proven)
      try {
        const procs = fs.readFileSync(`${registry.cgroup.path}/cgroup.procs`, 'utf8');
        for (const pid of procs.split('\n').map((s) => s.trim()).filter(Boolean)) {
          spawnSync('sudo', ['-n', 'tee', '/sys/fs/cgroup/cgroup.procs'], { input: pid, encoding: 'utf8' });
        }
      } catch { /* already empty */ }
      sudoSync(['rmdir', registry.cgroup.path]);
      registry.cgroup = null;
      const leftovers = fs.readdirSync('/sys/fs/cgroup').filter((n) => n.startsWith('t31-'));
      log(`F: cgroup cleanup verify — leftovers: ${JSON.stringify(leftovers)}`);
    }
    const verify = sudoSync(['iptables', '-S']);
    const verify6 = sudoSync(['ip6tables', '-S']);
    log('F: final firewall state (v4):', JSON.stringify(verify.out));
    log('F: final firewall state (v6):', JSON.stringify(verify6.out));
  }
}

// ---- G: network-namespace isolation via veth cut (privileged) -------------
// AUTHORIZED for Phase 3A: one throwaway netns + one veth pair dedicated to
// a single test node. Partition = host-side link down (kernel-level, scoped
// to that link; loopback and all other traffic untouched). Cleanup removes
// the veth and the netns and verifies both are gone.

async function expCNetns() {
  const NS = 't31ns';
  const VETH_HOST = 'vt31a';
  const VETH_NS = 'vt31b';
  const HOST_IP = '10.77.53.1';
  const NS_IP = '10.77.53.2';
  const { engine, network } = await setup({ name: 'netns', preset: 'two-node' });
  let nsNode = null;
  try {
    const [alice, bob] = nodeRecords(engine, network.id);
    await baseline(engine, network.id);
    const binary = engine.binaries.nodePath();
    const workdir = registry.dirs[0];
    const alicePeerId = await rpc(alice.ports.rpc, 'system_localPeerId');

    log('G: creating netns + veth (authorized privileged setup)…');
    const steps = [
      ['ip', 'netns', 'add', NS],
      ['ip', 'link', 'add', VETH_HOST, 'type', 'veth', 'peer', 'name', VETH_NS],
      ['ip', 'link', 'set', VETH_NS, 'netns', NS],
      ['ip', 'addr', 'add', `${HOST_IP}/24`, 'dev', VETH_HOST],
      ['ip', 'link', 'set', VETH_HOST, 'up'],
      ['ip', 'netns', 'exec', NS, 'ip', 'addr', 'add', `${NS_IP}/24`, 'dev', VETH_NS],
      ['ip', 'netns', 'exec', NS, 'ip', 'link', 'set', VETH_NS, 'up'],
      ['ip', 'netns', 'exec', NS, 'ip', 'link', 'set', 'lo', 'up'],
    ];
    for (const s of steps) {
      const r = sudoSync(s);
      log(`G: ${s.join(' ')} → ${r.ok ? 'OK' : `FAIL ${r.err.slice(0, 120)}`}`);
      if (!r.ok) throw new Error(`G: netns setup failed at: ${s.join(' ')}`);
    }
    // rollback order registered for emergency cleanup (delete link, then ns)
    registry.netnsCleanup.push(['ip', 'link', 'del', VETH_HOST], ['ip', 'netns', 'del', NS]);

    const nsPorts = { p2p: 35051, rpc: 36051, ws: 37051, prometheus: 38051 };
    nsNode = await manualNode({
      binary, name: 'spike-ns', specPath: network.chainSpecPath,
      baseDir: path.join(workdir, 'spike-ns'),
      ports: nsPorts,
      bootnodes: [`/ip4/${HOST_IP}/tcp/${alice.ports.p2p}/p2p/${alicePeerId}`],
      extraArgs: ['--no-mdns'],
      netns: NS,
    });
    registry.pkillPatterns.add(path.join(workdir, 'spike-ns'));

    // wait for attachment
    const attachDeadline = Date.now() + 120_000;
    let alicePeers = [];
    while (Date.now() < attachDeadline) {
      const r = await tryRpc(alice.ports.rpc, 'system_peers');
      alicePeers = r.ok ? r.result : [];
      if (alicePeers.length >= 2) break;
      await sleep(3_000);
    }
    const nsView = nsRpc(NS, nsPorts.rpc, 'system_peers');
    const nsAddrs = nsRpc(NS, nsPorts.rpc, 'system_localListenAddresses');
    log(`G: PRE-CUT alice peers=${alicePeers.map((p) => p.peerId.slice(6, 14)).join('+')} nsView=${nsView.ok ? nsView.result.length : nsView.error} nsListenAddrs=${nsAddrs.ok ? JSON.stringify(nsAddrs.result).slice(0, 140) : '?'}`);
    if (alicePeers.length < 2 || !nsView.ok) throw new Error('G: ns node never attached');

    log('G: CUT — host-side veth down (kernel-level, scoped to this link only)');
    const cut = sudoSync(['ip', 'link', 'set', VETH_HOST, 'down']);
    log(`G: link down → ${cut.ok ? 'OK' : cut.err.slice(0, 120)}`);

    const timeline = [];
    const cutStart = Date.now();
    let dropAt = null;
    while (Date.now() - cutStart < 90_000) {
      const a = await tryRpc(alice.ports.rpc, 'system_peers');
      const b = await tryRpc(bob.ports.rpc, 'system_peers');
      const n = nsRpc(NS, nsPorts.rpc, 'system_peers', [], 2);
      const nHead = nsRpc(NS, nsPorts.rpc, 'chain_getHeader', [], 2);
      const aHead = await tryRpc(alice.ports.rpc, 'chain_getHeader');
      const row = {
        t: `${Math.round((Date.now() - cutStart) / 1000)}s`,
        alice: a.ok ? a.result.map((p) => p.peerId.slice(6, 14)).sort().join('+') : 'down',
        bob: b.ok ? b.result.filter((p) => p.peerId !== undefined).length : 'down',
        nsRpc: n.ok ? 'up' : 'down',
        nsPeers: n.ok ? n.result.length : '-',
        nsHead: nHead.ok ? hexNum(nHead.result?.number) : '-',
        aliceHead: aHead.ok ? hexNum(aHead.result?.number) : '-',
      };
      timeline.push(row);
      if (dropAt === null && a.ok && !a.result.some((p) => p.peerId === nsNode.peerId)) dropAt = row.t;
      await sleep(5_000);
    }
    log('G: POST-CUT timeline:', JSON.stringify(timeline));
    log(`G: alice lost ns-node at: ${dropAt ?? 'NEVER'}`);
    const last = timeline.at(-1);
    log(`G: at end — nsRpc=${last.nsRpc} nsPeers=${last.nsPeers} nsHead=${last.nsHead} aliceHead=${last.aliceHead} (head delta shows frozen vs advancing)`);
    const hostLegs = ssEstablished(`:${nsPorts.p2p}`);
    log('G: host TCP legs to ns node after cut:', JSON.stringify(hostLegs));
    const bobOk = last.bob === 1;
    log(`G: unaffected connectivity (alice↔bob intact) during isolation: ${bobOk}`);

    log('G: RECOVERY — link up, watching reconvergence (120s)…');
    const up = sudoSync(['ip', 'link', 'set', VETH_HOST, 'up']);
    log(`G: link up → ${up.ok ? 'OK' : up.err.slice(0, 120)}`);
    const reStart = Date.now();
    let reconnected = false;
    while (Date.now() - reStart < 120_000) {
      const a = await tryRpc(alice.ports.rpc, 'system_peers');
      if (a.ok && a.result.some((p) => p.peerId === nsNode.peerId)) { reconnected = true; break; }
      await sleep(5_000);
    }
    const nsPeersAfter = nsRpc(NS, nsPorts.rpc, 'system_peers');
    log(`G: VERDICT sustained netns partition + reconvergence: drop=${dropAt !== null} reconnected=${reconnected} nsPeersAfter=${nsPeersAfter.ok ? nsPeersAfter.result.length : '?'}`);
  } finally {
    if (nsNode) {
      try { nsNode.child.kill('SIGKILL'); } catch { /* already dead */ }
    }
    for (const pattern of [...registry.pkillPatterns]) {
      spawnSync('sudo', ['-n', 'pkill', '-9', '-f', pattern], { encoding: 'utf8' });
    }
    registry.pkillPatterns.clear();
    await sleep(1_000);
    // remove veth then netns (order matters: ns deletion is cleanest after link gone)
    sudoSync(['ip', 'link', 'del', VETH_HOST]);
    sudoSync(['ip', 'netns', 'del', NS]);
    registry.netnsCleanup.length = 0;
    const nsList = sudoSync(['ip', 'netns', 'list']);
    const linkCheck = sudoSync(['ip', 'link', 'show', VETH_HOST]);
    log(`G: cleanup verify — netns list=${JSON.stringify(nsList.out)} vethGone=${!linkCheck.ok}`);
    await engine.networks.stop(network.id).catch(() => {});
    await engine.networks.remove(network.id).catch(() => {});
  }
}

// ---- D: termination + restart via the engine ------------------------------

async function expDTerminate() {
  const { engine, network } = await setup({ name: 'term', preset: 'two-node' });
  try {
    await baseline(engine, network.id);
    const [, bob] = nodeRecords(engine, network.id);
    const genesisBefore = network.chainSpecPath ? 'spec' : 'dev';

    log(`D: stopping ${bob.name} through the engine (SIGTERM→SIGKILL)`);
    const stop = await engine.networks.stopNode(bob.id);
    log('D: stop result ok =', stop.ok);
    await observe(engine, network.id, 20, 4_000, { phase: 'bob-stopped' });

    log('D: restarting bob through the engine');
    const start = await engine.networks.startNode(bob.id);
    log('D: start result ok =', start.ok);
    const after = nodeRecords(engine, network.id).find((n) => n.id === bob.id);
    log(`D: new pid=${after.pid} (was ${bob.pid}); alive=${isPidAlive(after.pid)}; genesis-keep=${genesisBefore}`);

    log('D: watching reconnect + chain progress (60s)…');
    await observe(engine, network.id, 60, 4_000, { phase: 'bob-restarted' });
    const t1 = await tick(engine, network.id);
    await sleep(12_000);
    const t2 = await tick(engine, network.id);
    log(`D: heads t1=${t1.map((r) => r.head)} t2=${t2.map((r) => r.head)} states=${t2.map((r) => r.health).join(',')}`);
  } finally {
    await engine.networks.stop(network.id).catch(() => {});
    await engine.networks.remove(network.id).catch(() => {});
  }
}

// ---- rpc-probe: method inventory (mechanism B groundwork) -----------------

async function expRpcProbe() {
  const { engine, network } = await setup({ name: 'probe', preset: 'two-node' });
  try {
    const [alice] = nodeRecords(engine, network.id);
    const methods = await rpc(alice.ports.rpc, 'rpc_methods');
    const names = (methods.methods ?? []).map((m) => String(m.name ?? m)).sort();
    log(`rpc-probe: ${names.length} methods total`);
    log('rpc-probe: ALL methods:\n ', names.join('\n  '));
  } finally {
    await engine.networks.stop(network.id).catch(() => {});
    await engine.networks.remove(network.id).catch(() => {});
  }
}

// ---- main -----------------------------------------------------------------

const cmd = process.argv[2];
const experiments = {
  'a-pause': expAPause,
  'b-peer': expBPeer,
  'b-peer-reserved': expBReserved,
  'c-partition': () => expCPartition('bootnode'),
  'c-partition-reserved': () => expCPartition('reserved'),
  'c-partition-mdns': () => expCPartition('mdns'),
  'c-iptables': expCIptables,
  'c-iptables-cgroup': () => expCIptables('cgroup'),
  'c-netns': expCNetns,
  'd-terminate': expDTerminate,
  'rpc-probe': expRpcProbe,
};
const fn = experiments[cmd];
if (!fn) {
  console.error('usage: node test/experiments/t31-spike.mjs <a-pause|b-peer|b-peer-reserved|c-partition|c-partition-reserved|c-partition-mdns|c-iptables|c-netns|d-terminate|rpc-probe>');
  process.exit(2);
}

fn()
  .then(async () => { await emergencyCleanup(); log('DONE (clean)'); process.exit(0); })
  .catch(async (e) => { log('FAILED:', e?.stack ?? e); await emergencyCleanup(); process.exit(1); });
