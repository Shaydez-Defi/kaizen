/**
 * LIVE test — Phase 2B web client against the real backend.
 *
 * Runs the ACTUAL KaizenApiClient + KaizenEventStream — the exact code the
 * browser executes — against a real API server, real engine/StateStore, and
 * REAL portaldot_dev nodes. Cross-checks client-visible monitoring values
 * against an independent raw RPC read of the same node.
 *
 * This is client-layer + backend verification. Browser rendering is covered
 * by jsdom component tests in apps/web/src — those are NOT run against a
 * real backend. No claim of full browser E2E is made here.
 */

import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEngine,
  readSnapshot,
  wsUrlForPort,
  type KaizenEngine,
} from '@kaizen/engine';
import { createServer } from '../../apps/api/src/server';
import { ApiError, KaizenApiClient } from '../../apps/web/src/api/client';
import { KaizenEventStream } from '../../apps/web/src/api/events';
import { LIVE, SHARED_BIN_CACHE, ensureSharedBinary, testRoot } from './testkit';

describe.runIf(LIVE)('Web client (live, real backend + real network)', () => {
  let engine: KaizenEngine;
  let client: KaizenApiClient;
  let stream: KaizenEventStream;
  let dir: string;
  let baseUrl: string;
  let networkId: string;
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];

  beforeAll(async () => {
    await ensureSharedBinary();
    dir = testRoot('webclient');
    engine = createEngine({ dataDir: dir, binaryCacheDir: SHARED_BIN_CACHE });
    const app = createServer(engine);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no tcp address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
    client = new KaizenApiClient({ baseUrl });

    // The UI's real event stream (Node 24 provides a WHATWG WebSocket).
    stream = new KaizenEventStream(`ws://127.0.0.1:${addr.port}/api/events`);
    stream.subscribe((e) =>
      events.push({ name: e.name, payload: (e.payload ?? {}) as Record<string, unknown> }),
    );
  }, 300_000);

  afterAll(async () => {
    stream.close();
    await engine.processes.killAll();
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('talks to the real API (health + structured validation errors)', async () => {
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.service).toBe('kaizen-api');

    const err = await client
      .createNetwork({ name: 'BAD NAME', preset: 'single-node' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('INVALID_INPUT');
    expect((err as ApiError).issues.length).toBeGreaterThan(0);
  }, 30_000);

  it('creates a real network and sees the typed event on the UI stream', async () => {
    const res = await client.createNetwork({ name: 'web-live', preset: 'single-node' });
    networkId = res.network.id;

    const detail = await client.getNetwork(networkId);
    expect(detail.network.name).toBe('web-live');
    expect(detail.nodes).toHaveLength(1);

    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      !events.some((e) => e.name === 'network.created')
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const created = events.find((e) => e.name === 'network.created')?.payload as
      | { networkId: string; at: string }
      | undefined;
    expect(created).toBeDefined();
    expect(created!.networkId).toBe(networkId);
    expect(new Date(created!.at).getTime()).toBeGreaterThan(0);

    // structured 404 through the client as well
    const missing = await client.getNetwork('net_nope').catch((e) => e);
    expect((missing as ApiError).code).toBe('NETWORK_NOT_FOUND');
    expect((missing as ApiError).status).toBe(404);
  }, 60_000);

  it('starts the network (health-gated) and monitors REAL RPC data', async () => {
    const start = await client.startNetwork(networkId);
    expect(start.ok).toBe(true);

    // poll the client until the monitor has a real reachable sample
    let snapshot = (await client.monitorSnapshot(networkId)).snapshot;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !snapshot.samples.some((s) => s.rpc.reachable)) {
      await new Promise((r) => setTimeout(r, 2_000));
      snapshot = (await client.monitorSnapshot(networkId)).snapshot;
    }
    const sample = snapshot.samples[0]!;
    const health = snapshot.health[0]!;
    expect(sample.rpc.reachable).toBe(true);
    expect(health.state).toBe('healthy');
    expect(sample.head).not.toBeNull();
    expect(typeof sample.head!.number).toBe('number');
    expect(sample.genesisHash).toMatch(/^0x[0-9a-f]+$/i);
    expect(sample.peers!.count).toBe(sample.peers!.expected); // single node: 0/0

    // node detail through the client carries the same live evidence
    const nodeId = snapshot.samples[0]!.nodeId;
    const nodeDetail = await client.getNode(networkId, nodeId);
    expect(nodeDetail.sample?.rpc.reachable).toBe(true);
    expect(nodeDetail.health?.state).toBe('healthy');
    expect(nodeDetail.node.status).toBe('running');

    // CROSS-CHECK: what the UI shows vs an independent raw RPC read
    const node = nodeDetail.node;
    const raw = await readSnapshot(wsUrlForPort(node.ports.ws));
    const rawHead = Number(raw.head?.number ?? -1);
    expect(rawHead).toBeGreaterThanOrEqual(0);
    // the chain moves; allow small drift between the two reads
    expect(Math.abs(rawHead - sample.head!.number)).toBeLessThanOrEqual(10);
    // independent peer count agrees with the sample the UI displays
    expect(raw.health.peers).toBe(sample.peers!.count);
    // the node reports a real libp2p identity (12D3KooW…)
    expect(raw.localPeerId).toMatch(/^12D3KooW/);
  }, 180_000);

  it('returns real log bytes for the running node (new logs endpoint)', async () => {
    const detail = await client.getNetwork(networkId);
    const node = detail.nodes[0]!;
    const logs = await client.nodeLogs(networkId, node.id);
    expect(logs.nodeId).toBe(node.id);
    expect(logs.lines.length).toBeGreaterThan(0);
    // real Substrate startup/runtime markers
    expect(logs.lines.join('\n')).toMatch(/listening for new connections|idle|peers|highest known block/i);

    // invalid maxBytes → structured 400 through the client path
    const bad = await fetch(
      `${baseUrl}/api/networks/${networkId}/nodes/${node.id}/logs?maxBytes=10`,
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_INPUT',
    );
  }, 30_000);

  it('stops the network and shows honest post-stop health', async () => {
    const stop = await client.stopNetwork(networkId);
    expect(stop.ok).toBe(true);

    // after stop: process dead → health is unhealthy (decisive evidence),
    // NOT a fabricated "stopped=healthy" or stale value
    const detail = await client.getNetwork(networkId);
    expect(detail.network.status).toBe('stopped');
    const snapshot = (await client.monitorSnapshot(networkId)).snapshot;
    expect(snapshot.health[0]!.state).toBe('unhealthy');
    expect(snapshot.samples[0]!.rpc.reachable).toBe(false);

    // lifecycle events were seen on the UI stream (typed, timestamped)
    const statuses = events
      .filter((e) => e.name === 'network.status')
      .map((e) => e.payload as { networkId: string; status: string });
    expect(statuses.some((p) => p.networkId === networkId && p.status === 'running')).toBe(true);
    expect(statuses.some((p) => p.networkId === networkId && p.status === 'stopped')).toBe(true);

    // cleanup through the client
    const removed = await client.removeNetwork(networkId);
    expect(removed.removed).toBe(networkId);
  }, 120_000);
});
