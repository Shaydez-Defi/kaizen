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
});
