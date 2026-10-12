/**
 * LIVE test — T-1.8 API over the shared engine.
 * Verifies: REST routes delegate to real engine services, input validation,
 * structured errors, WS event stream hello. Uses a real (but non-started)
 * network to avoid duplicating the full network lifecycle test.
 */

import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEngine, type KaizenEngine } from '@kaizen/engine';
import { createServer } from '../../apps/api/src/server';
import { LIVE, SHARED_BIN_CACHE, ensureSharedBinary, testRoot } from './testkit';

describe.runIf(LIVE)('API (live, real engine)', () => {
  let engine: KaizenEngine;
  let app: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    await ensureSharedBinary();
    dir = testRoot('api');
    engine = createEngine({ dataDir: dir, binaryCacheDir: SHARED_BIN_CACHE });
    app = createServer(engine);
    await app.listen({ host: '127.0.0.1', port: 0 });
  }, 300_000);

  afterAll(async () => {
    await app.close();
    await engine.processes.killAll();
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('GET /api/health reports the service', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('kaizen-api');
  });

  it('rejects invalid network creation with a structured 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/networks',
      payload: { name: 'INVALID NAME!!', preset: 'single-node' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  it('creates and lists a REAL network through the API (delegating to the engine)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/networks',
      payload: { name: 'api-net', preset: 'single-node' },
    });
    expect(create.statusCode).toBe(201);
    const { network } = create.json() as { network: { id: string; name: string } };
    expect(network.name).toBe('api-net');

    // duplicate → 409 structured
    const dup = await app.inject({
      method: 'POST',
      url: '/api/networks',
      payload: { name: 'api-net', preset: 'single-node' },
    });
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { error: { code: string } }).error.code).toBe('NETWORK_ALREADY_EXISTS');

    const list = await app.inject({ method: 'GET', url: '/api/networks' });
    const { networks } = list.json() as { networks: Array<{ id: string; nodeCount: number }> };
    expect(networks.find((n) => n.id === network.id)?.nodeCount).toBe(1);

    const detail = await app.inject({ method: 'GET', url: `/api/networks/${network.id}` });
    expect(detail.statusCode).toBe(200);

    // unknown id → structured error
    const missing = await app.inject({ method: 'GET', url: '/api/networks/net_nope' });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: { code: string } }).error.code).toBe('NETWORK_NOT_FOUND');

    // cleanup via API
    const del = await app.inject({ method: 'DELETE', url: `/api/networks/${network.id}` });
    expect(del.statusCode).toBe(200);
  });

  it('streams a hello message on the WS event channel', async () => {
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no tcp address');
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/api/events`);
    try {
      const hello = await new Promise<{ type: string; version: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no hello within 10s')), 10_000);
        ws.addEventListener('message', (ev) => {
          clearTimeout(timer);
          resolve(JSON.parse(String(ev.data)) as { type: string; version: string });
        });
        ws.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('ws error'));
        });
      });
      expect(hello.type).toBe('hello');
      expect(hello.version).toBeTruthy();
    } finally {
      ws.close();
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Phase 2A surface: custom topologies, node ops, monitoring, purge, events

  it('validates custom topologies and exposes node/monitor/purge endpoints', async () => {
    // invalid custom topology → structured 400 with per-problem details
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/networks',
      payload: {
        name: 'api-bad',
        preset: 'custom',
        custom: {
          nodes: [
            { name: 'v1', role: 'validator', wellKnownKey: 'alice' },
            { name: 'v2', role: 'validator', wellKnownKey: 'alice' },
          ],
        },
      },
    });
    expect(invalid.statusCode).toBe(400);
    const invalidBody = invalid.json() as { error: { code: string; details: { problems: string[] } } };
    expect(invalidBody.error.code).toBe('INVALID_INPUT');
    expect(invalidBody.error.details.problems.join(' ')).toMatch(/duplicate wellKnownKey/);

    // valid custom creation → persisted node configs
    const create = await app.inject({
      method: 'POST',
      url: '/api/networks',
      payload: {
        name: 'api-custom',
        preset: 'custom',
        custom: {
          nodes: [
            { name: 'a', role: 'validator', wellKnownKey: 'alice' },
            { name: 'b', role: 'validator', wellKnownKey: 'bob' },
            { name: 'observer', role: 'full' },
          ],
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const { network } = create.json() as { network: { id: string } };

    const detail = await app.inject({ method: 'GET', url: `/api/networks/${network.id}` });
    const nodes = (detail.json() as { nodes: Array<{ id: string; role: string }> }).nodes;
    expect(nodes).toHaveLength(3);
    const fullNode = nodes.find((n) => n.role === 'full')!;

    // node detail: record present; with no stored snapshot the route samples
    // on demand (DEC-017) → honest unreachable data for the non-running node
    const nodeDetail = await app.inject({
      method: 'GET',
      url: `/api/networks/${network.id}/nodes/${fullNode.id}`,
    });
    expect(nodeDetail.statusCode).toBe(200);
    const nodeBody = nodeDetail.json() as {
      node: { id: string; role: string };
      sample: { rpc: { reachable: boolean } } | null;
      health: { state: string } | null;
    };
    expect(nodeBody.node.role).toBe('full');
    expect(nodeBody.sample?.rpc.reachable).toBe(false);
    expect(nodeBody.health?.state).toBe('unhealthy');

    // unknown node → 404 NODE_NOT_FOUND
    const missingNode = await app.inject({
      method: 'GET',
      url: `/api/networks/${network.id}/nodes/net_x-nope`,
    });
    expect(missingNode.statusCode).toBe(404);
    expect((missingNode.json() as { error: { code: string } }).error.code).toBe('NODE_NOT_FOUND');

    // stopping a non-running node → 409 NODE_NOT_RUNNING
    const stopDead = await app.inject({
      method: 'POST',
      url: `/api/networks/${network.id}/nodes/${fullNode.id}/stop`,
    });
    expect(stopDead.statusCode).toBe(409);
    expect((stopDead.json() as { error: { code: string } }).error.code).toBe('NODE_NOT_RUNNING');

    // monitoring snapshot on a non-running network: honest unreachable data
    const monitor = await app.inject({ method: 'GET', url: `/api/networks/${network.id}/monitor` });
    expect(monitor.statusCode).toBe(200);
    const snapshot = (monitor.json() as {
      snapshot: { samples: Array<{ rpc: { reachable: boolean } }>; health: Array<{ state: string }> };
    }).snapshot;
    expect(snapshot.samples).toHaveLength(3);
    expect(snapshot.samples.every((s) => !s.rpc.reachable)).toBe(true);
    expect(snapshot.health.every((h) => h.state === 'unhealthy')).toBe(true);

    // purge on a stopped network → ok
    const purge = await app.inject({ method: 'POST', url: `/api/networks/${network.id}/purge` });
    expect(purge.statusCode).toBe(200);
    expect((purge.json() as { ok: boolean }).ok).toBe(true);

    const del = await app.inject({ method: 'DELETE', url: `/api/networks/${network.id}` });
    expect(del.statusCode).toBe(200);
  }, 180_000);

  it('streams typed events for real operations (network.created + network.status)', async () => {
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no tcp address');
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/api/events`);
    const received: Array<{ type: string; name?: string; payload?: unknown }> = [];
    try {
      ws.addEventListener('message', (ev) => {
        received.push(JSON.parse(String(ev.data)) as { type: string; name?: string; payload?: unknown });
      });
      // wait for hello so the subscription is definitely live
      await new Promise((r) => setTimeout(r, 300));

      const create = await app.inject({
        method: 'POST',
        url: '/api/networks',
        payload: {
          name: 'api-ws',
          preset: 'custom',
          custom: { nodes: [{ name: 'solo', role: 'validator', wellKnownKey: 'alice' }] },
        },
      });
      expect(create.statusCode).toBe(201);
      const { network } = create.json() as { network: { id: string } };

      // typed events carry timestamps + identifiers
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !received.some((m) => m.name === 'network.created')) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const created = received.find((m) => m.name === 'network.created')?.payload as {
        networkId: string;
        preset: string;
        nodeCount: number;
        at: string;
      };
      expect(created.networkId).toBe(network.id);
      expect(created.preset).toBe('custom');
      expect(created.nodeCount).toBe(1);
      expect(new Date(created.at).getTime()).toBeGreaterThan(0);

      const status = received
        .filter((m) => m.name === 'network.status')
        .map((m) => m.payload as { networkId: string; status: string; at: string })
        .find((p) => p.networkId === network.id && p.status === 'created');
      expect(status).toBeDefined();
      expect(new Date(status!.at).getTime()).toBeGreaterThan(0);

      await app.inject({ method: 'DELETE', url: `/api/networks/${network.id}` });
    } finally {
      ws.close();
    }
  }, 60_000);
});
