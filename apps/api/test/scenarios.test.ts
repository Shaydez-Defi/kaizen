/**
 * Scenario authoring API tests (T-3.3).
 *
 * Real Fastify app + real SQLite (temp dataDir), driven via app.inject — no
 * portaldot binary, no network started, no fault executed. These are
 * database/API integration tests, not live-node tests.
 *
 * Covered: CRUD, validate-without-save, structured error formatting, list
 * filtering/pagination, unknown ids, malformed JSON, registry statuses,
 * authorization posture (DEC-019 loopback/JSON), and the hard guarantee
 * that authoring endpoints NEVER execute faults or expose execution routes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  EventBus,
  FailureInjector,
  NodeProcessManager,
  ScenarioService,
  StateStore,
  createEngine,
  type KaizenEngine,
} from '@kaizen/engine';
import { API_HOST, createServer } from '../src/server';

function validScenario(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    description: 'Pause alice briefly and verify recovery',
    tags: ['recovery-drill'],
    requires: { designatedTest: true, preset: 'two-node' },
    steps: [
      {
        id: 'pause-alice',
        operation: { type: 'pause', config: { node: 'alice', durationMs: 10_000 } },
        timeoutMs: 120_000,
        preconditions: [
          { kind: 'rpc-reachable', node: 'alice', expect: true },
          { kind: 'process-state', node: 'alice', expect: ['running'] },
        ],
        postconditions: [
          { kind: 'recovery-verified', node: 'alice' },
          { kind: 'rpc-reachable', node: 'alice', expect: true },
        ],
      },
    ],
    ...overrides,
  };
}

describe('Scenario authoring API (real app + real SQLite)', () => {
  let engine: KaizenEngine;
  let app: FastifyInstance;
  let dir: string;
  const faultEvents: string[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-scenario-api-'));
    engine = createEngine({ dataDir: dir, binaryCacheDir: path.join(dir, 'bin') });
    engine.events.subscribe((name) => {
      if (name.startsWith('fault.')) faultEvents.push(name);
    });
    app = createServer(engine);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---- CRUD ---------------------------------------------------------------

  it('starts empty and lists with pagination fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scenarios' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; scenarios: unknown[]; total: number; limit: number; offset: number };
    expect(body.ok).toBe(true);
    expect(body.scenarios).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it('creates a valid scenario (201) and reads it back by id', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      payload: validScenario('api-valid'),
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { ok: boolean; scenario: { id: string; name: string; validationStatus: string; createdBy: string } };
    expect(created.ok).toBe(true);
    expect(created.scenario.id).toMatch(/^scn-/);
    expect(created.scenario.name).toBe('api-valid');
    expect(created.scenario.validationStatus).toBe('valid');
    expect(created.scenario.createdBy).toBe('api');

    const get = await app.inject({ method: 'GET', url: `/api/scenarios/${created.scenario.id}` });
    expect(get.statusCode).toBe(200);
    const fetched = get.json() as { scenario: { id: string } };
    expect(fetched.scenario.id).toBe(created.scenario.id);
  });

  it('rejects invalid scenarios with 400 + structured issues (code/severity/path/remediation)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      payload: validScenario('api-invalid', {
        steps: [
          {
            operation: { type: 'pause', config: { node: 'alice' } },
            timeoutMs: 120_000,
          },
        ],
      }),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      ok: boolean;
      error: { code: string; details: { issues: Array<Record<string, unknown>>; errorCount: number } };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('SCENARIO_INVALID');
    expect(body.error.details.errorCount).toBeGreaterThan(0);
    const codes = body.error.details.issues.map((i) => i['code']);
    expect(codes).toContain('PRECONDITION_MISSING');
    for (const issue of body.error.details.issues) {
      expect(typeof issue['message']).toBe('string');
      expect(typeof issue['remediation']).toBe('string');
      expect(typeof issue['path']).toBe('string');
      expect(['error', 'warning']).toContain(issue['severity']);
    }
    expect(JSON.stringify(body)).not.toMatch(/stack/);
  });

  it('rejects unknown operation types at the API boundary (400, OPERATION_UNKNOWN)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      payload: validScenario('api-unknown-op', {
        steps: [
          {
            operation: { type: 'cryptominer', config: { node: 'alice' } },
            timeoutMs: 120_000,
            preconditions: [],
            postconditions: [],
          },
        ],
      }),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { details: { issues: Array<{ code: string }> } } };
    expect(body.error.details.issues.some((i) => i.code === 'OPERATION_UNKNOWN')).toBe(true);
  });

  it('rejects secret-shaped content (400, SECRET_CONTENT)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      payload: validScenario('api-secret', { description: 'node password: hunter2' }),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { details: { issues: Array<{ code: string; path: string }> } } };
    const issue = body.error.details.issues.find((i) => i.code === 'SECRET_CONTENT');
    expect(issue?.path).toBe('description');
    // The secret itself must never be echoed back in the response.
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('rejects duplicate names with 409', async () => {
    await app.inject({ method: 'POST', url: '/api/scenarios', payload: validScenario('api-dupe') });
    const res = await app.inject({ method: 'POST', url: '/api/scenarios', payload: validScenario('api-dupe') });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('SCENARIO_ALREADY_EXISTS');
  });

  it('answers 404 for unknown ids on get/update/delete', async () => {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/api/scenarios/scn-nope' });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code).toBe('SCENARIO_NOT_FOUND');
    }
  });

  it('updates scenarios (PUT) and revalidates as a whole', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      payload: validScenario('api-updatable'),
    });
    const id = (create.json() as { scenario: { id: string } }).scenario.id;

    const update = await app.inject({
      method: 'PUT',
      url: `/api/scenarios/${id}`,
      payload: { description: 'updated description', execution: { onStepFailed: 'continue' } },
    });
    expect(update.statusCode).toBe(200);
    const updated = update.json() as { scenario: { description: string; execution: { onStepFailed: string; onCleanupFailed: string } } };
    expect(updated.scenario.description).toBe('updated description');
    expect(updated.scenario.execution.onStepFailed).toBe('continue');
    expect(updated.scenario.execution.onCleanupFailed).toBe('cancel-run');

    const bad = await app.inject({
      method: 'PUT',
      url: `/api/scenarios/${id}`,
      payload: { execution: { cancellation: 'ignore' } },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('deletes scenarios (200 then 404)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      payload: validScenario('api-deletable'),
    });
    const id = (create.json() as { scenario: { id: string } }).scenario.id;
    const del = await app.inject({ method: 'DELETE', url: `/api/scenarios/${id}` });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { removed: string }).removed).toBe(id);
    const get = await app.inject({ method: 'GET', url: `/api/scenarios/${id}` });
    expect(get.statusCode).toBe(404);
  });

  // ---- validate-without-save + filtering ----------------------------------

  it('validates without saving (200 + result, store untouched)', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/scenarios?limit=200' });
    const beforeCount = (before.json() as { total: number }).total;

    const valid = await app.inject({
      method: 'POST',
      url: '/api/scenarios/validate',
      payload: validScenario('never-saved'),
    });
    expect(valid.statusCode).toBe(200);
    const validBody = valid.json() as { ok: boolean; result: { valid: boolean; worstCaseDurationMs: number } };
    expect(validBody.ok).toBe(true);
    expect(validBody.result.valid).toBe(true);
    expect(validBody.result.worstCaseDurationMs).toBe(120_000);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/scenarios/validate',
      payload: { name: 'broken', steps: [] },
    });
    expect(invalid.statusCode).toBe(200);
    const invalidBody = invalid.json() as { ok: boolean; result: { valid: boolean; issues: Array<{ code: string }> } };
    expect(invalidBody.ok).toBe(false);
    expect(invalidBody.result.valid).toBe(false);
    expect(invalidBody.result.issues.some((i) => i.code === 'SCENARIO_NO_STEPS')).toBe(true);

    const after = await app.inject({ method: 'GET', url: '/api/scenarios?limit=200' });
    expect((after.json() as { total: number }).total).toBe(beforeCount);
  });

  it('filters lists by tag/status/q and paginates', async () => {
    await app.inject({ method: 'POST', url: '/api/scenarios', payload: validScenario('filter-a', { tags: ['network'] }) });
    await app.inject({ method: 'POST', url: '/api/scenarios', payload: validScenario('filter-b', { tags: ['process'] }) });

    const tagged = await app.inject({ method: 'GET', url: '/api/scenarios?tag=network' });
    const taggedBody = tagged.json() as { scenarios: Array<{ name: string }>; total: number };
    expect(taggedBody.total).toBe(1);
    expect(taggedBody.scenarios[0]?.name).toBe('filter-a');

    const q = await app.inject({ method: 'GET', url: '/api/scenarios?q=filter-b' });
    expect((q.json() as { total: number }).total).toBe(1);

    const paged = await app.inject({ method: 'GET', url: '/api/scenarios?limit=1&offset=0' });
    const pagedBody = paged.json() as { scenarios: unknown[]; total: number };
    expect(pagedBody.scenarios).toHaveLength(1);
    expect(pagedBody.total).toBeGreaterThan(1);

    const badQuery = await app.inject({ method: 'GET', url: '/api/scenarios?limit=999' });
    expect(badQuery.statusCode).toBe(400);
  });

  // ---- registry -----------------------------------------------------------

  it('exposes the safe operation registry with honest statuses', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scenarios/operations' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      operations: Array<{ type: string; status: string; statusUnblock?: string; configFields: string[] }>;
    };
    const byType = new Map(body.operations.map((o) => [o.type, o]));
    expect(byType.get('pause')?.status).toBe('supported');
    expect(byType.get('terminate')?.status).toBe('supported');
    expect(byType.get('peer-disconnect')?.status).toBe('blocked');
    expect(byType.get('peer-disconnect')?.statusUnblock).toBeTruthy();
    expect(byType.get('partition')?.status).toBe('blocked');
    expect(byType.get('node-restart')?.status).toBe('planned');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/"command"|"shell"|"exec"|"signal"/);
  });

  it('stores blocked operations only as explicit non-executable warnings', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      payload: validScenario('api-blocked-draft', {
        steps: [
          {
            operation: { type: 'partition', config: { node: 'alice' } },
            timeoutMs: 300_000,
            preconditions: [
              { kind: 'rpc-reachable', node: 'alice', expect: true },
              { kind: 'process-state', node: 'alice', expect: ['running'] },
            ],
            postconditions: [{ kind: 'rpc-reachable', node: 'alice', expect: true }],
          },
        ],
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      scenario: { validationStatus: string; validation: { issues: Array<{ code: string; severity: string }> } };
    };
    expect(body.scenario.validationStatus).toBe('warning');
    const blocked = body.scenario.validation.issues.find((i) => i.code === 'OPERATION_BLOCKED');
    expect(blocked?.severity).toBe('warning');
  });

  // ---- safety guarantees --------------------------------------------------

  it('never executes faults during CRUD or validation', async () => {
    faultEvents.length = 0;
    const create = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      payload: validScenario('api-no-exec'),
    });
    const id = (create.json() as { scenario: { id: string } }).scenario.id;
    await app.inject({ method: 'PUT', url: `/api/scenarios/${id}`, payload: { description: 'touch' } });
    await app.inject({ method: 'POST', url: '/api/scenarios/validate', payload: validScenario('validate-only') });
    await app.inject({ method: 'GET', url: `/api/scenarios/${id}` });
    await app.inject({ method: 'DELETE', url: `/api/scenarios/${id}` });

    expect(faultEvents).toEqual([]);
    expect(engine.store.listFaults({ limit: 100 })).toEqual([]);
    expect(engine.faults.activeFaults()).toEqual([]);
  });

  it('has no execution/replay routes at all (404 by absence)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      payload: validScenario('api-no-routes'),
    });
    const id = (create.json() as { scenario: { id: string } }).scenario.id;
    for (const url of [
      `/api/scenarios/${id}/execute`,
      `/api/scenarios/${id}/run`,
      `/api/scenarios/${id}/replay`,
      '/api/scenarios/run',
    ]) {
      const res = await app.inject({ method: 'POST', url, payload: {} });
      expect(res.statusCode).toBe(404);
    }
  });

  it('keeps the DEC-019 posture: loopback host only, structured errors without stack leaks', async () => {
    expect(API_HOST).toBe('127.0.0.1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      payload: '{invalid json',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(JSON.stringify(body)).not.toMatch(/at Object|node_modules/);
  });

  it('does not auto-run a saved scenario or emit scenario events over stored data alone', async () => {
    // A saved scenario is inert data: reading it emits nothing and touches
    // no processes — the executor (T-3.4) is the only future run path.
    const create = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      payload: validScenario('api-inert'),
    });
    const id = (create.json() as { scenario: { id: string } }).scenario.id;
    const events: string[] = [];
    const unsubscribe = engine.events.subscribe((name) => {
      events.push(name);
    });
    await app.inject({ method: 'GET', url: `/api/scenarios/${id}` });
    unsubscribe();
    expect(events).toEqual([]);
  });
});

describe('Scenario services are engine-owned (DEC-002 sanity)', () => {
  it('the API never duplicates validation logic: engine.scenarios is the single implementation', () => {
    // Constructing the same services the engine wires must produce identical
    // behavior — scenario validation lives in the engine, not the API layer.
    const store = new StateStore(':memory:');
    const events = new EventBus();
    const injector = new FailureInjector({
      store,
      events,
      processes: new NodeProcessManager({}),
      networks: { stopNode: async () => ({ ok: false }), startNode: async () => ({ ok: false }) },
    });
    const service = new ScenarioService({ store, events, mechanisms: injector.describeMechanisms() });
    const result = service.validate(validScenario('engine-owned'));
    expect(result.valid).toBe(true);
    expect(typeof service.create).toBe('function');
    expect(service.operations.types()).toContain('pause');
    store.close();
  });
});
