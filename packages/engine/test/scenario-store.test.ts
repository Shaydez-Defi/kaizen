/**
 * Scenario persistence tests (T-3.3) — SQLite CRUD, restart reload,
 * duplicates, malformed/version-mismatched rows, filters, atomic updates,
 * and authoring events. Real stores only (file-backed where restart
 * behavior matters); no portaldot, no fault execution anywhere.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EventBus,
  FailureInjector,
  KaizenError,
  NodeProcessManager,
  ScenarioService,
  StateStore,
  type FaultMechanismInfo,
  type KaizenEventName,
} from '@kaizen/engine';

// ---------------------------------------------------------------------------

function mechanismsFor(store: StateStore): FaultMechanismInfo[] {
  const injector = new FailureInjector({
    store,
    events: new EventBus(),
    processes: new NodeProcessManager({}),
    networks: {
      stopNode: async () => ({ ok: false }),
      startNode: async () => ({ ok: false }),
    },
  });
  return injector.describeMechanisms();
}

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-scenario-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  store: StateStore;
  service: ScenarioService;
  events: EventBus;
  seen: Array<{ name: KaizenEventName; payload: unknown }>;
}

function harness(dbPath = ':memory:'): Harness {
  const store = new StateStore(dbPath);
  const events = new EventBus();
  const seen: Array<{ name: KaizenEventName; payload: unknown }> = [];
  events.subscribe((name, payload) => {
    seen.push({ name, payload });
  });
  const service = new ScenarioService({ store, events, mechanisms: mechanismsFor(store) });
  return { store, service, events, seen };
}

function validScenario(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
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

// ---------------------------------------------------------------------------

describe('scenario persistence', () => {
  it('round-trips a created scenario through get/list with stable ids and timestamps', () => {
    const { service } = harness();
    const record = service.create(validScenario('round-trip'), 'tester');
    expect(record.id).toMatch(/^scn-[a-z0-9]+-[a-f0-9]{8}$/);
    expect(record.createdBy).toBe('tester');
    expect(record.validationStatus).toBe('valid');

    const fetched = service.get(record.id);
    expect(JSON.stringify(fetched)).toBe(JSON.stringify(record));

    const page = service.list();
    expect(page.total).toBe(1);
    expect(page.scenarios[0]?.id).toBe(record.id);
    expect(page.malformed).toEqual([]);
  });

  it('reloads scenarios after a full service/database restart', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'kaizen.db');
    const first = harness(dbPath);
    const record = first.service.create(validScenario('restart-me'), 'author');
    first.store.close();

    const second = harness(dbPath);
    const reloaded = second.service.get(record.id);
    expect(JSON.stringify(reloaded)).toBe(JSON.stringify(record));
    second.store.close();
  });

  it('rejects duplicate names on create and update (409-class typed error)', () => {
    const { service } = harness();
    service.create(validScenario('taken'));
    try {
      service.create(validScenario('taken'));
      expect.unreachable('second create should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(KaizenError);
      expect((e as KaizenError).code).toBe('SCENARIO_ALREADY_EXISTS');
    }

    const other = service.create(validScenario('other-name'));
    try {
      service.update(other.id, { name: 'taken' });
      expect.unreachable('rename onto a taken name should have thrown');
    } catch (e) {
      expect((e as KaizenError).code).toBe('SCENARIO_ALREADY_EXISTS');
    }
  });

  it('rejects duplicate ids at the store layer', () => {
    const { service, store } = harness();
    const record = service.create(validScenario('id-dup'));
    expect(() => store.insertScenario(record)).toThrow(KaizenError);
    try {
      store.insertScenario(record);
    } catch (e) {
      expect((e as KaizenError).code).toBe('SCENARIO_ALREADY_EXISTS');
    }
  });

  it('answers NOT_FOUND for unknown ids on get/update/delete', () => {
    const { service } = harness();
    for (const run of [
      () => service.get('scn-missing'),
      () => service.update('scn-missing', { name: 'x' }),
      () => service.remove('scn-missing'),
    ]) {
      try {
        run();
        expect.unreachable('should have thrown NOT_FOUND');
      } catch (e) {
        expect((e as KaizenError).code).toBe('SCENARIO_NOT_FOUND');
      }
    }
  });

  it('updates atomically: a rejected update changes nothing; a good update writes everything', () => {
    const { service } = harness();
    const record = service.create(validScenario('atomic'), 'author');
    const before = JSON.stringify(service.get(record.id));

    try {
      service.update(record.id, {
        name: 'renamed',
        description: 'this update must not land',
        execution: { onStepFailed: 'explode' },
      });
      expect.unreachable('invalid update should have thrown');
    } catch (e) {
      expect((e as KaizenError).code).toBe('SCENARIO_INVALID');
    }
    expect(JSON.stringify(service.get(record.id))).toBe(before);

    const updated = service.update(
      record.id,
      { name: 'atomic-renamed', tags: ['updated'], execution: { onStepFailed: 'continue' } },
      'editor',
    );
    expect(updated.name).toBe('atomic-renamed');
    expect(updated.tags).toEqual(['updated']);
    expect(updated.execution.onStepFailed).toBe('continue');
    expect(updated.createdBy).toBe('author'); // provenance preserved
    expect(updated.updatedBy).toBe('editor');
    const stored = service.get(record.id);
    expect(stored.name).toBe('atomic-renamed');
    expect(JSON.parse(JSON.stringify(stored))).toEqual(JSON.parse(JSON.stringify(updated)));
  });

  it('lists with q/tag/status filters, pagination, and stable totals', () => {
    const { service } = harness();
    const a = service.create(validScenario('alpha drill', { tags: ['network'] }));
    service.create(validScenario('beta drill', { tags: ['process'] }));
    const warned = service.create(
      validScenario('gamma drill', {
        tags: ['network'],
        requires: { designatedTest: true, preset: 'custom' },
        steps: [
          {
            operation: { type: 'pause', config: { node: 'victim', durationMs: 5_000 } },
            timeoutMs: 120_000,
            preconditions: [
              { kind: 'rpc-reachable', node: 'victim', expect: true },
              { kind: 'process-state', node: 'victim', expect: ['running'] },
            ],
            postconditions: [{ kind: 'recovery-verified', node: 'victim' }],
          },
        ],
      }),
    );
    expect(warned.validationStatus).toBe('warning');

    expect(service.list({ tag: 'network' }).total).toBe(2);
    expect(service.list({ q: 'beta' }).total).toBe(1);
    expect(service.list({ status: 'warning' }).total).toBe(1);
    expect(service.list({ q: 'drill', limit: 2 }).scenarios).toHaveLength(2);
    expect(service.list({ q: 'drill', limit: 2 }).total).toBe(3);
    expect(service.list({ q: 'drill', limit: 2, offset: 2 }).scenarios).toHaveLength(1);
    expect(service.list({ limit: 200 }).total).toBe(3);
    // newest updated first — created order here
    const ids = service.list().scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(3);
    expect(service.get(a.id).id).toBe(a.id);
  });

  it('surfaces malformed and unsupported-version rows instead of dropping them', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'kaizen.db');
    const { service, store } = harness(dbPath);
    const good = service.create(validScenario('good-row'));
    const bad = service.create(validScenario('bad-row'));
    const old = service.create(validScenario('old-row'));

    // Corrupt one row's JSON; bump another's schema version — raw SQL, as a
    // downgrade/corruption scenario would actually look on disk.
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE scenarios SET steps = ? WHERE id = ?').run('{not json', bad.id);
    db.prepare('UPDATE scenarios SET schema_version = ? WHERE id = ?').run(99, old.id);
    db.close();

    try {
      service.get(bad.id);
      expect.unreachable('malformed row should throw');
    } catch (e) {
      expect((e as KaizenError).code).toBe('SCENARIO_MALFORMED');
    }
    try {
      service.get(old.id);
      expect.unreachable('future-version row should throw');
    } catch (e) {
      expect((e as KaizenError).code).toBe('SCENARIO_VERSION_UNSUPPORTED');
    }

    const page = service.list();
    expect(page.scenarios.map((s) => s.id)).toEqual([good.id]); // parseable rows still served
    expect(page.malformed.map((m) => m.id).sort()).toEqual([bad.id, old.id].sort());
    const byId = new Map(page.malformed.map((m) => [m.id, m]));
    expect(byId.get(bad.id)?.code).toBe('SCENARIO_MALFORMED');
    expect(byId.get(old.id)?.code).toBe('SCENARIO_VERSION_UNSUPPORTED');
    store.close();
  });

  it('validate() never persists and never executes anything', () => {
    const { service, store, seen } = harness();
    const result = service.validate(validScenario('not-saved'));
    expect(result.valid).toBe(true);
    expect(service.list().total).toBe(0);
    expect(store.listFaults()).toEqual([]);
    expect(seen.filter((e) => e.name.startsWith('scenario.'))).toEqual([]);
    expect(seen.filter((e) => e.name.startsWith('fault.'))).toEqual([]);
  });

  it('CRUD emits authoring audit events and no fault events', () => {
    const { service, store, seen } = harness();
    const record = service.create(validScenario('evented'), 'author');
    service.update(record.id, { description: 'edited' }, 'editor');
    service.remove(record.id, 'author');

    const names = seen.map((e) => e.name);
    expect(names.filter((n) => n.startsWith('scenario.')).sort()).toEqual([
      'scenario.created',
      'scenario.deleted',
      'scenario.updated',
    ]);
    expect(names.filter((n) => n.startsWith('fault.'))).toEqual([]);
    // Creating/updating/deleting scenarios never produced a fault record.
    expect(store.listFaults()).toEqual([]);
    const created = seen.find((e) => e.name === 'scenario.created')?.payload as {
      actor: string;
      steps: number;
    };
    expect(created.actor).toBe('author');
    expect(created.steps).toBe(1);
  });

  it('removes scenarios and reports deletion honestly', () => {
    const { service } = harness();
    const record = service.create(validScenario('removable'));
    service.remove(record.id);
    expect(service.list().total).toBe(0);
    try {
      service.get(record.id);
      expect.unreachable('deleted scenario should be gone');
    } catch (e) {
      expect((e as KaizenError).code).toBe('SCENARIO_NOT_FOUND');
    }
  });
});
