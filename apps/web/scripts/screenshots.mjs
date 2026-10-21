#!/usr/bin/env node
/**
 * Design-review screenshot harness (T-3.6C) — dev tooling, NOT part of the
 * app bundle and never used at runtime.
 *
 * Serves the production build (`vite preview`), then renders each screen in
 * headless Chromium with Playwright while intercepting `/api/*` and the
 * `/api/events` WebSocket with the FIXTURE responses below. The images are
 * therefore renders of the real UI code over fixture API data (labelled as
 * such wherever they are published) — not evidence of a live network.
 *
 * Usage (from apps/web, after `npm run build`):
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
 *   CHROMIUM=/usr/bin/chromium node scripts/screenshots.mjs [outDir] [width] [only]
 * Playwright is intentionally not a repo dependency (large browser download).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve(process.argv[2] ?? 'shots');
const width = Number(process.argv[3] ?? 1440);
const only = process.argv[4] ?? '';
const PORT = 4179;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const T0 = Date.parse('2026-10-22T14:01:12Z');
const iso = (s) => new Date(T0 + s * 1000).toISOString();
const NAMES = ['alice', 'bob', 'charlie', 'dave'];
const PEER = (i) => `12D3KooWKaizenNode${i + 1}`; // base58: no 0/O/I/l

function nodes(over = {}) {
  return NAMES.map((n, i) => ({
    id: `net_m-${n}`,
    networkId: 'net_m',
    name: `meridian-test-${n}`,
    role: 'validator',
    chain: 'local-spec',
    wellKnownKey: n,
    bootnodes: NAMES.filter((_, j) => j !== i).map((_, k, arr) => {
      const j = NAMES.indexOf(arr[k]);
      return `/ip4/127.0.0.1/tcp/${31000 + j}/p2p/${PEER(j)}`;
    }),
    baseDir: `/home/op/.kaizen/networks/meridian-test/node-${n}`,
    nodeKeyFile: '/x',
    logFile: '/x',
    ports: { p2p: 31000 + i, rpc: 32000 + i, ws: 33000 + i, prometheus: 34000 + i },
    expectedPeers: 3,
    status: over[n]?.status ?? 'running',
    pid: over[n]?.status === 'stopped' ? undefined : 48120 + i,
  }));
}

function snapshot(down = null) {
  const up = NAMES.filter((n) => n !== down);
  return {
    networkId: 'net_m',
    name: 'meridian-test',
    at: iso(120),
    intervalMs: 2000,
    samples: NAMES.map((n, i) => {
      const off = n === down;
      return {
        networkId: 'net_m',
        nodeId: `net_m-${n}`,
        name: `meridian-test-${n}`,
        at: iso(120),
        process: { status: off ? 'stopped' : 'running', pid: off ? undefined : 48120 + i },
        rpc: off ? { reachable: false, error: 'ECONNREFUSED' } : { reachable: true },
        health: off ? null : { isSyncing: false, peers: up.length - 1, shouldHavePeers: true },
        peers: off ? null : { count: up.length - 1, expected: 3, list: up.filter((m) => m !== n).map((m) => ({ peerId: PEER(NAMES.indexOf(m)), roles: 'AUTHORITY', bestHash: '0x', bestNumber: 1284 })) },
        head: off ? null : { number: 1284, hash: '0xa' },
        finalized: off ? null : { number: 1282, hash: '0xb' },
        genesisHash: '0x00',
        sync: null,
        uptimeMs: 3_725_000,
        warnings: [],
      };
    }),
    health: NAMES.map((n) => ({ nodeId: `net_m-${n}`, state: n === down ? 'unavailable' : 'healthy', reasons: [], since: iso(0), lastSampleAt: iso(120), rpcFailures: 0 })),
  };
}

const network = (status = 'running') => ({ id: 'net_m', name: 'meridian-test', preset: 'four-validator', status, designatedTest: true, chain: 'local-spec', chainSpecPath: '/x', baseDir: '/home/op/.kaizen/networks/meridian-test', createdAt: iso(0), updatedAt: iso(0), nodeCount: 4 });

const doneFault = {
  id: 'flt-mvj2k81p-7c1e',
  networkId: 'net_m',
  nodeId: 'net_m-charlie',
  nodeName: 'meridian-test-charlie',
  type: 'terminate',
  mode: 'execute',
  state: 'completed',
  requestedBy: 'web',
  requestedAt: iso(130),
  updatedAt: iso(196),
  finishedAt: iso(197),
  holdDurationMs: 30_000,
  evidence: {
    before: { at: iso(130), rpcReachable: true, head: { hash: '0x', number: 1290 } },
    applied: { at: iso(130), how: 'SIGTERM pid 48122' },
    effect: { observed: true, attempts: 1, detail: 'RPC refused while stopped; peers 3 → 2 on the other validators', observation: null, at: iso(131) },
    removed: { at: iso(160), how: 'restarted node process (pid 48311)' },
    recovery: { verified: true, attempts: 3, detail: 'head advanced #1290 → #1301, 3 peers', observation: null, at: iso(168) },
    notes: [],
  },
  result: { ok: true, outcome: 'verified', claims: { applied: true, effectObserved: true, faultRemoved: true, recovered: true, recoveryVerified: true } },
};
const activeFault = { ...doneFault, id: 'flt-mvj4q02x-91ab', state: 'executing', finishedAt: undefined, result: undefined, evidence: { before: doneFault.evidence.before, applied: doneFault.evidence.applied, effect: doneFault.evidence.effect, notes: [] } };

const LOGS = [
  '2026-10-22 14:03:22 INFO  Received SIGTERM, shutting down',
  '2026-10-22 14:03:52 INFO  Kaizen restart: portaldot_dev --chain local-spec',
  '2026-10-22 14:03:55 WARN  Peer 12D3KooWKaizenNode2 disconnected during startup',
  '2026-10-22 14:03:58 INFO  Syncing 11 blocks from #1290',
  '2026-10-22 14:04:00 INFO  Imported #1301 (0x8f2a…c41d)',
  '2026-10-22 14:04:01 INFO  Idle (3 peers), best: #1301, finalized #1299',
];

const SCENES = {
  landing: { path: '/', full: true },
  overview: { path: '/overview' },
  lab: { path: '/lab?node=net_m-charlie' },
  'lab-active': { path: '/lab', faults: [activeFault], down: 'charlie' },
  incident: { path: '/incidents', faults: [doneFault] },
  deployments: { path: '/deployments', full: true },
  networks: { path: '/networks' },
  scenarios: { path: '/scenarios' },
};

function events(scene) {
  const ev = [
    ['network.status', { networkId: 'net_m', status: 'running', at: iso(0) }],
    ['operation.completed', { networkId: 'net_m', kind: 'network.start', ok: true, at: iso(18) }],
    ['monitor.health', { networkId: 'net_m', nodeId: 'net_m-alice', name: 'meridian-test-alice', state: 'healthy', at: iso(76) }],
    ['monitor.health', { networkId: 'net_m', nodeId: 'net_m-dave', name: 'meridian-test-dave', state: 'healthy', at: iso(98) }],
  ];
  if (scene.faults?.length) {
    const f = scene.faults[0];
    ev.push(['fault.state', { networkId: 'net_m', faultId: f.id, nodeId: f.nodeId, nodeName: f.nodeName, type: f.type, from: 'ready', to: 'executing', at: iso(130) }]);
    ev.push(['node.status', { networkId: 'net_m', nodeId: f.nodeId, name: f.nodeName, status: 'stopped', at: iso(131) }]);
    ev.push(['monitor.health', { networkId: 'net_m', nodeId: f.nodeId, name: f.nodeName, state: 'unavailable', at: iso(138) }]);
  }
  return ev;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('vite preview did not start')), 30_000);
    server.stdout.on('data', (d) => {
      if (String(d).includes(String(PORT))) {
        clearTimeout(t);
        resolve();
      }
    });
  });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
  try {
    for (const [name, scene] of Object.entries(SCENES)) {
      if (only && !only.split(',').includes(name)) continue;
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.on('pageerror', (e) => console.log(`[${name}] pageerror:`, e.message));
      const down = scene.down ?? null;
      await page.routeWebSocket('**/api/events', (ws) => {
        ws.send(JSON.stringify({ type: 'hello' }));
        for (const [n, p] of events(scene)) ws.send(JSON.stringify({ type: 'event', name: n, payload: p }));
      });
      await page.route('**/api/**', (route) => {
        const u = new URL(route.request().url());
        const p = u.pathname;
        const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        if (p === '/api/health') return json({ ok: true, service: 'kaizen-api', version: '0.1.0', dataDir: '/home/op/.kaizen' });
        if (p === '/api/binaries') return json({ ok: true, status: { available: true, problems: [] } });
        if (p === '/api/networks') return json({ ok: true, networks: [network(down ? 'degraded' : 'running')] });
        if (p === '/api/networks/net_m') return json({ ok: true, network: network(down ? 'degraded' : 'running'), nodes: nodes(down ? { [down]: { status: 'stopped' } } : {}) });
        if (p === '/api/networks/net_m/monitor') return json({ ok: true, snapshot: snapshot(down) });
        if (p === '/api/networks/net_m/faults') return json({ ok: true, faults: scene.faults ?? [] });
        if (p.endsWith('/logs')) return json({ ok: true, nodeId: 'net_m-charlie', lines: LOGS });
        if (p === '/api/scenarios') return json({ ok: true, scenarios: [], malformed: [], total: 0, limit: 50, offset: 0 });
        if (p === '/api/scenarios/operations') return json({ ok: true, operations: [] });
        if (p === '/api/scenarios/runs') return json({ ok: true, runs: [], malformed: [], total: 0, limit: 10, offset: 0 });
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'fixture missing' } }) });
      });
      await page.goto(`http://127.0.0.1:${PORT}${scene.path}`, { waitUntil: 'load' });
      await page.waitForTimeout(scene.full ? 2600 : 2200);
      if (scene.full) {
        // reveal in-view animations section by section
        const h = await page.evaluate(() => document.documentElement.scrollHeight);
        for (let y = 0; y < h; y += 500) {
          await page.evaluate((yy) => window.scrollTo(0, yy), y);
          await page.waitForTimeout(140);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(500);
      }
      const file = path.join(outDir, `${name}-${width}.png`);
      await page.screenshot({ path: file, fullPage: Boolean(scene.full) });
      const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      console.log(`${file}  overflowX=${sw > cw ? `YES (${sw}>${cw})` : 'no'}`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
