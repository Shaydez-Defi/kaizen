/**
 * API client unit tests (mocked transport): success envelopes, structured
 * errors, timeouts, and network failures. No backend involved — the real
 * backend verification lives in test/integration/webclient.int.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import { ApiError, KaizenApiClient } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('KaizenApiClient', () => {
  it('parses successful responses', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ok: true, networks: [{ id: 'net_1', name: 'a', nodeCount: 2 }] }),
    );
    const client = new KaizenApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.listNetworks();
    expect(res.networks[0]?.nodeCount).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0]![0] as string).endsWith('/api/networks')).toBe(true);
  });

  it('translates structured error envelopes into ApiError with code + issues', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Invalid network creation request',
            details: { issues: [{ message: 'name must match ^[a-z0-9]…' }] },
          },
        },
        400,
      ),
    );
    const client = new KaizenApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await client.createNetwork({ name: 'X', preset: 'single-node' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('INVALID_INPUT');
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).issues[0]).toMatch(/name must match/);
  });

  it('falls back to HTTP_500 when a failure has no envelope', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const client = new KaizenApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = (await client.getNetwork('net_1').catch((e) => e)) as ApiError;
    expect(err.code).toBe('HTTP_500');
  });

  it('classifies non-JSON responses as BAD_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>', { status: 200 }));
    const client = new KaizenApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = (await client.listNetworks().catch((e) => e)) as ApiError;
    expect(err.code).toBe('BAD_RESPONSE');
  });

  it('times out hung requests with TIMEOUT', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const client = new KaizenApiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 25,
    });
    const err = (await client.listNetworks().catch((e) => e)) as ApiError;
    expect(err.code).toBe('TIMEOUT');
    expect(err.message).toMatch(/25ms/);
  });

  it('classifies transport failures as NETWORK_ERROR', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const client = new KaizenApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = (await client.health().catch((e) => e)) as ApiError;
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toMatch(/API unreachable/);
  });

  it('returns failed OperationResults as values (does not throw)', async () => {
    const result = {
      ok: false,
      operationId: 7,
      kind: 'network.start',
      startedAt: 'x',
      finishedAt: 'y',
      durationMs: 1,
      error: { code: 'BINARY_NOT_AVAILABLE', message: 'no binary' },
    };
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, result }));
    const client = new KaizenApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.startNetwork('net_1');
    expect(res.ok).toBe(false);
    expect(res.result.error?.code).toBe('BINARY_NOT_AVAILABLE');
  });
});

describe('KaizenApiClient scenario methods (T-3.3 contract)', () => {
  const scenarioInput = {
    name: 'client-drill',
    steps: [
      {
        operation: { type: 'pause', config: { node: 'alice' } },
        preconditions: [],
        postconditions: [],
      },
    ],
  };

  it('lists scenarios with query parameters', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ok: true, scenarios: [], malformed: [], total: 0, limit: 50, offset: 0 }),
    );
    const client = new KaizenApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.listScenarios({ tag: 'network', limit: 10 });
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain('/api/scenarios?');
    expect(url).toContain('tag=network');
    expect(url).toContain('limit=10');
  });

  it('validates without saving via POST /api/scenarios/validate', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ok: true, result: { valid: true, issues: [] } }),
    );
    const client = new KaizenApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.validateScenario(scenarioInput);
    expect(res.result.valid).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('/api/scenarios/validate');
    expect(init?.method).toBe('POST');
  });

  it('updates via PUT and deletes via DELETE', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      jsonResponse(
        init?.method === 'PUT'
          ? { ok: true, scenario: { id: 'scn_1' } }
          : { ok: true, removed: 'scn_1' },
      ),
    );
    const client = new KaizenApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const updated = await client.updateScenario('scn_1', { description: 'edited' });
    expect(updated.scenario.id).toBe('scn_1');
    expect(fetchImpl.mock.calls[0]![0]).toBe('/api/scenarios/scn_1');
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe('PUT');
    const removed = await client.deleteScenario('scn_1');
    expect(removed.removed).toBe('scn_1');
    expect(fetchImpl.mock.calls[1]![1]?.method).toBe('DELETE');
  });

  it('surfaces SCENARIO_INVALID errors with structured issues', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          ok: false,
          error: {
            code: 'SCENARIO_INVALID',
            message: 'Scenario validation failed with 1 error(s)',
            details: { issues: [{ code: 'SCENARIO_NO_STEPS', path: 'steps' }] },
          },
        },
        400,
      ),
    );
    const client = new KaizenApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = (await client.createScenario(scenarioInput).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('SCENARIO_INVALID');
    expect(err.status).toBe(400);
  });
});
