/**
 * Scenario model + validation unit tests (T-3.3).
 *
 * Pure tests: no processes, no ports, no clock inside validation. The
 * registry mirrors a REAL FailureInjector's describeMechanisms() (the
 * single source of truth); synthetic registries exercise the general rules.
 *
 * Covered: registry/injector mirroring, normalization + stable ids, ordering,
 * duplicate/missing step ids, unsupported/blocked/planned operations, config
 * validation, condition evaluability + contradictions, delay/timeout bounds,
 * worst-case duration, failure/cancellation policy validation, schema
 * version, deterministic serialization, secret rejection, structured issue
 * output, capability mismatch.
 */

import { describe, expect, it } from 'vitest';
import {
  EventBus,
  FailureInjector,
  NodeProcessManager,
  StateStore,
  buildOperationRegistry,
  prepareScenario,
  validateScenarioInput,
  SCENARIO_MAX_DURATION_MS,
  SCENARIO_PAUSE_HOLD_HEADROOM_MS,
  SCENARIO_SCHEMA_VERSION,
  type FaultMechanismInfo,
  type ScenarioInput,
  type ScenarioOperationRegistry,
  type ScenarioValidationIssue,
  type ScenarioValidationResult,
} from '@kaizen/engine';

// ---------------------------------------------------------------------------
// Helpers

function injectorMechanisms(): FaultMechanismInfo[] {
  const store = new StateStore(':memory:');
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

const registry: ScenarioOperationRegistry = buildOperationRegistry(injectorMechanisms());

function validPauseScenario(overrides: Partial<ScenarioInput> = {}): Record<string, unknown> {
  return {
    name: 'alice-pause-drill',
    description: 'Pause alice briefly and verify recovery',
    tags: ['recovery-drill'],
    requires: { designatedTest: true, preset: 'two-node', minNodes: 2 },
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

function codes(result: ScenarioValidationResult): string[] {
  return result.issues.map((i) => i.code);
}

function findIssue(
  result: ScenarioValidationResult,
  code: string,
): ScenarioValidationIssue | undefined {
  return result.issues.find((i) => i.code === code);
}

// ---------------------------------------------------------------------------

describe('operation registry (derived from the FailureInjector)', () => {
  it('mirrors the actual adapters: pause/terminate supported, peer-disconnect/partition blocked, node-restart planned', () => {
    expect(registry.types()).toEqual([
      'pause',
      'terminate',
      'peer-disconnect',
      'partition',
      'node-restart',
    ]);
    expect(registry.get('pause')?.status).toBe('supported');
    expect(registry.get('terminate')?.status).toBe('supported');
    for (const blocked of ['peer-disconnect', 'partition']) {
      const def = registry.get(blocked);
      expect(def?.status).toBe('blocked');
      expect((def?.statusReason ?? '').length).toBeGreaterThan(50);
      expect((def?.statusUnblock ?? '').length).toBeGreaterThan(50);
    }
    expect(registry.get('node-restart')?.status).toBe('planned');
    expect(registry.get('node-restart')?.statusReason).toContain('not implemented');
  });

  it('blocked statuses match the injector mechanisms verbatim (single source of truth)', () => {
    const mechanisms = new Map(injectorMechanisms().map((m) => [m.type, m.support]));
    for (const def of registry.all()) {
      const support = mechanisms.get(def.type);
      if (support) expect(def.status).toBe(support.status);
    }
    expect(registry.get('peer-disconnect')?.statusUnblock).toBe(
      mechanisms.get('peer-disconnect')?.status === 'blocked'
        ? mechanisms.get('peer-disconnect').unblock
        : undefined,
    );
  });

  it('exposes no arbitrary execution surface (no shell/command/signal/exec fields)', () => {
    for (const def of registry.all()) {
      // Configs are strict objects: parse rejects unknown keys (incl. secret
      // shaped ones) — no passthrough of commands, env, paths, or signals.
      expect(def.configSchema.safeParse({ node: 'alice', command: 'rm -rf /' }).success).toBe(false);
      expect(def.configSchema.safeParse({ node: 'alice', env: { KEY: 'v' } }).success).toBe(false);
      expect(def.source === 'failure-injector' || def.source === 'engine').toBe(true);
    }
    // partition needs privileged authorization (DEC-018)
    expect(registry.get('partition')?.safety.authorizationRequired).toBe(true);
    expect(registry.get('pause')?.safety.authorizationRequired).toBe(false);
    for (const def of registry.all()) expect(def.safety.designatedTestRequired).toBe(true);
  });

  it('marks only architecturally evaluable conditions as supported', () => {
    const supported = registry.all().flatMap((d) => d.supportedPostconditions);
    expect(supported).toContain('rpc-reachable');
    expect(supported).toContain('recovery-verified');
    const pause = registry.get('pause');
    expect(pause?.supportedPreconditions).not.toContain('finality-progress');
    expect(pause?.supportedPreconditions).not.toContain('runtime-event');
  });
});

describe('scenario validation — normal form and determinism', () => {
  it('accepts a valid scenario and computes worst-case duration', () => {
    const result = validateScenarioInput(validPauseScenario(), registry);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.errorCount).toBe(0);
    expect(result.worstCaseDurationMs).toBe(120_000);
    expect(result.stepCount).toBe(1);
    expect(result.schemaVersion).toBe(SCENARIO_SCHEMA_VERSION);
  });

  it('is deterministic: identical input yields byte-identical results', () => {
    const input = validPauseScenario();
    const a = validateScenarioInput(input, registry);
    const b = validateScenarioInput(input, registry);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('prepareScenario is deterministic given the same id/timestamp and assigns stable ids/defaults', () => {
    const opts = { id: 'scn-test', now: '2026-10-14T00:00:00.000Z', actor: 'tester' };
    const p1 = prepareScenario(validPauseScenario(), registry, opts);
    const p2 = prepareScenario(validPauseScenario(), registry, opts);
    expect(p1.record).not.toBeNull();
    expect(JSON.stringify(p1.record)).toBe(JSON.stringify(p2.record));
    const record = p1.record!;
    expect(record.id).toBe('scn-test');
    expect(record.createdBy).toBe('tester');
    expect(record.validationStatus).toBe('valid');
    expect(record.requires.designatedTest).toBe(true);
    expect(record.steps[0]!.order).toBe(0);
    expect(record.steps[0]!.delayBeforeMs).toBe(0);
    expect(record.steps[0]!.delayAfterMs).toBe(0);
  });

  it('assigns missing step ids (step-N) and normalizes explicit order = position', () => {
    const input = validPauseScenario();
    const steps = (input['steps'] as Array<Record<string, unknown>>)[0]!;
    delete steps['id'];
    const result = prepareScenario(input, registry, { id: 'scn-x', now: '2026-10-14T00:00:00.000Z' });
    expect(result.record?.steps[0]?.id).toBe('step-1');
  });

  it('flags explicit order that contradicts position (array position is authoritative)', () => {
    const input = validPauseScenario();
    const steps = input['steps'] as Array<Record<string, unknown>>;
    steps[0]!['order'] = 3;
    const result = validateScenarioInput(input, registry);
    expect(result.valid).toBe(false);
    expect(findIssue(result, 'STEP_ORDER_MISMATCH')?.path).toBe('steps[0].order');
  });

  it('rejects duplicate and malformed step ids', () => {
    const dup = validPauseScenario();
    const steps = dup['steps'] as Array<Record<string, unknown>>;
    steps.push({ ...steps[0]!, order: 1 });
    const dupResult = validateScenarioInput(dup, registry);
    expect(codes(dupResult)).toContain('STEP_ID_DUPLICATE');

    const bad = validPauseScenario();
    ((bad['steps'] as Array<Record<string, unknown>>)[0]!)['id'] = 'Not Valid!';
    expect(codes(validateScenarioInput(bad, registry))).toContain('STEP_ID_INVALID');
  });

  it('rejects unknown schemaVersion', () => {
    const result = validateScenarioInput(validPauseScenario({ schemaVersion: 99 }), registry);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('SCHEMA_VERSION_UNSUPPORTED');
  });
});

describe('scenario validation — operations', () => {
  it('rejects unknown operation types with the known list', () => {
    const input = validPauseScenario();
    const steps = input['steps'] as Array<Record<string, unknown>>;
    (steps[0]!['operation'] as Record<string, unknown>)['type'] = 'explode-node';
    const result = validateScenarioInput(input, registry);
    expect(result.valid).toBe(false);
    const issue = findIssue(result, 'OPERATION_UNKNOWN');
    expect(issue?.severity).toBe('error');
    expect(issue?.remediation).toContain('pause');
    expect(issue?.path).toBe('steps[0].operation.type');
  });

  it('keeps blocked operations representable but NEVER executable (warning + unblock path)', () => {
    const input = validPauseScenario();
    const steps = input['steps'] as Array<Record<string, unknown>>;
    steps[0]!['operation'] = { type: 'peer-disconnect', config: { node: 'alice' } };
    delete steps[0]!['timeoutMs'];
    const result = validateScenarioInput(input, registry);
    // Warnings only: authors may draft for future availability.
    expect(result.valid).toBe(true);
    expect(result.warningCount).toBeGreaterThan(0);
    const blocked = findIssue(result, 'OPERATION_BLOCKED');
    expect(blocked?.severity).toBe('warning');
    expect(blocked?.remediation).toContain('reserved-only');
    // and the capability gap is reported too
    expect(codes(result)).toContain('TARGET_CAPABILITY_MISSING');
    const record = prepareScenario(input, registry, { id: 'scn-b', now: '2026-10-14T00:00:00.000Z' }).record;
    expect(record?.validationStatus).toBe('warning');
  });

  it('marks planned operations explicitly (warning, never executable)', () => {
    const input = validPauseScenario();
    const steps = input['steps'] as Array<Record<string, unknown>>;
    steps[0]!['operation'] = { type: 'node-restart', config: { node: 'alice' } };
    delete steps[0]!['timeoutMs'];
    const result = validateScenarioInput(input, registry);
    expect(result.valid).toBe(true);
    expect(findIssue(result, 'OPERATION_PLANNED')?.severity).toBe('warning');
  });

  it('validates operation config against the strict per-operation schema', () => {
    const missingNode = validPauseScenario();
    const steps = missingNode['steps'] as Array<Record<string, unknown>>;
    (steps[0]!['operation'] as Record<string, unknown>)['config'] = { durationMs: 1000 };
    expect(codes(validateScenarioInput(missingNode, registry))).toContain('OPERATION_CONFIG_INVALID');

    const badHold = validPauseScenario();
    const s2 = badHold['steps'] as Array<Record<string, unknown>>;
    (s2[0]!['operation'] as Record<string, unknown>)['config'] = { node: 'alice', durationMs: 600_001 };
    expect(codes(validateScenarioInput(badHold, registry))).toContain('OPERATION_CONFIG_INVALID');

    const unknownKey = validPauseScenario();
    const s3 = unknownKey['steps'] as Array<Record<string, unknown>>;
    (s3[0]!['operation'] as Record<string, unknown>)['config'] = { node: 'alice', command: 'boom' };
    expect(codes(validateScenarioInput(unknownKey, registry))).toContain('OPERATION_CONFIG_INVALID');
  });

  it('requires explicit fault preconditions and warns on missing postconditions', () => {
    const input = validPauseScenario();
    const steps = input['steps'] as Array<Record<string, unknown>>;
    steps[0]!['preconditions'] = [];
    const result = validateScenarioInput(input, registry);
    expect(result.valid).toBe(false);
    const issue = findIssue(result, 'PRECONDITION_MISSING');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('rpc-reachable');
    expect(issue?.message).toContain('process-state');

    const noPost = validPauseScenario();
    (noPost['steps'] as Array<Record<string, unknown>>)[0]!['postconditions'] = [];
    const postResult = validateScenarioInput(noPost, registry);
    expect(postResult.valid).toBe(true);
    expect(findIssue(postResult, 'POSTCONDITION_MISSING')?.severity).toBe('warning');
  });
});

describe('scenario validation — conditions', () => {
  function withConditions(
    pre: unknown[],
    post: unknown[] = [
      { kind: 'recovery-verified', node: 'alice' },
    ],
  ): Record<string, unknown> {
    const input = validPauseScenario();
    const steps = input['steps'] as Array<Record<string, unknown>>;
    steps[0]!['preconditions'] = pre;
    steps[0]!['postconditions'] = post;
    return input;
  }

  it('rejects conditions the architecture cannot evaluate (planned kinds)', () => {
    const input = withConditions([
      { kind: 'rpc-reachable', node: 'alice', expect: true },
      { kind: 'process-state', node: 'alice', expect: ['running'] },
      { kind: 'finality-progress', node: 'alice', expect: 'advancing' },
    ]);
    const result = validateScenarioInput(input, registry);
    expect(result.valid).toBe(false);
    const issue = findIssue(result, 'CONDITION_NOT_EVALUABLE');
    expect(issue?.path).toBe('steps[0].preconditions[2].kind');

    const runtime = withConditions([
      { kind: 'rpc-reachable', node: 'alice', expect: true },
      { kind: 'process-state', node: 'alice', expect: ['running'] },
      { kind: 'runtime-event', node: 'alice', event: 'imOnline.SomeOffline', expect: 'observed' },
    ]);
    expect(codes(validateScenarioInput(runtime, registry))).toContain('CONDITION_NOT_EVALUABLE');
  });

  it('detects contradictory and impossible conditions', () => {
    const opposite = withConditions([
      { kind: 'rpc-reachable', node: 'alice', expect: true },
      { kind: 'rpc-reachable', node: 'alice', expect: false },
      { kind: 'process-state', node: 'alice', expect: ['running'] },
    ]);
    expect(codes(validateScenarioInput(opposite, registry))).toContain('CONDITION_CONTRADICTORY');

    const impossible = withConditions([
      { kind: 'process-state', node: 'alice', expect: ['stopped'] },
      { kind: 'rpc-reachable', node: 'alice', expect: true },
    ]);
    expect(codes(validateScenarioInput(impossible, registry))).toContain('CONDITION_UNPOSSIBLE');

    const peerGte = 3;
    const peerRange = withConditions([
      { kind: 'peers', node: 'alice', op: 'gte', value: peerGte },
      { kind: 'peers', node: 'alice', op: 'lte', value: 1 },
    ]);
    expect(codes(validateScenarioInput(peerRange, registry))).toContain('CONDITION_UNPOSSIBLE');

    const peerEq = withConditions([
      { kind: 'peers', node: 'alice', op: 'eq', value: 2 },
      { kind: 'peers', node: 'alice', op: 'eq', value: 5 },
    ]);
    expect(codes(validateScenarioInput(peerEq, registry))).toContain('CONDITION_CONTRADICTORY');

    const sets = withConditions([
      { kind: 'health-state', node: 'alice', expect: ['healthy'] },
      { kind: 'health-state', node: 'alice', expect: ['unavailable'] },
      { kind: 'process-state', node: 'alice', expect: ['running'] },
    ]);
    expect(codes(validateScenarioInput(sets, registry))).toContain('CONDITION_CONTRADICTORY');

    const recoveredButDown = withConditions(
      [{ kind: 'rpc-reachable', node: 'alice', expect: true }, { kind: 'process-state', node: 'alice', expect: ['running'] }],
      [
        { kind: 'recovery-verified', node: 'alice' },
        { kind: 'rpc-reachable', node: 'alice', expect: false },
      ],
    );
    expect(codes(validateScenarioInput(recoveredButDown, registry))).toContain('CONDITION_CONTRADICTORY');
  });

  it('bounds condition timeouts and node labels', () => {
    const timeout = withConditions([
      { kind: 'rpc-reachable', node: 'alice', expect: true, timeoutMs: 60_001 },
      { kind: 'process-state', node: 'alice', expect: ['running'] },
    ]);
    expect(codes(validateScenarioInput(timeout, registry))).toContain('CONDITION_TIMEOUT_OUT_OF_BOUNDS');

    const label = withConditions([
      { kind: 'rpc-reachable', node: 'Alice!', expect: true },
      { kind: 'process-state', node: 'alice', expect: ['running'] },
    ]);
    expect(codes(validateScenarioInput(label, registry))).toContain('CONDITION_NODE_INVALID');
  });
});

describe('scenario validation — timing, duration, safety', () => {
  it('bounds delays and step timeouts', () => {
    const delay = validPauseScenario();
    (delay['steps'] as Array<Record<string, unknown>>)[0]!['delayBeforeMs'] = 300_001;
    expect(codes(validateScenarioInput(delay, registry))).toContain('DELAY_OUT_OF_BOUNDS');

    const timeout = validPauseScenario();
    (timeout['steps'] as Array<Record<string, unknown>>)[0]!['timeoutMs'] = 4_999;
    expect(codes(validateScenarioInput(timeout, registry))).toContain('TIMEOUT_OUT_OF_BOUNDS');

    const high = validPauseScenario();
    (high['steps'] as Array<Record<string, unknown>>)[0]!['timeoutMs'] = 900_001;
    expect(codes(validateScenarioInput(high, registry))).toContain('TIMEOUT_OUT_OF_BOUNDS');
  });

  it('requires the step timeout to cover a pause hold plus cleanup headroom', () => {
    const input = validPauseScenario();
    const steps = input['steps'] as Array<Record<string, unknown>>;
    steps[0]!['timeoutMs'] = 30_000; // hold 10s + 60s headroom = 90s minimum
    const result = validateScenarioInput(input, registry);
    expect(result.valid).toBe(false);
    const issue = findIssue(result, 'TIMEOUT_TOO_SHORT_FOR_HOLD');
    expect(issue?.message).toContain('60000ms cleanup/recovery headroom');
  });

  it('defaults a pause step timeout to hold + headroom when omitted', () => {
    const input = validPauseScenario();
    const steps = input['steps'] as Array<Record<string, unknown>>;
    delete steps[0]!['timeoutMs'];
    (steps[0]!['operation'] as Record<string, unknown>)['config'] = { node: 'alice', durationMs: 60_000 };
    const record = prepareScenario(input, registry, { id: 'scn-d', now: '2026-10-14T00:00:00.000Z' }).record;
    expect(record?.steps[0]?.timeoutMs).toBe(60_000 + SCENARIO_PAUSE_HOLD_HEADROOM_MS);
  });

  it('enforces the worst-case scenario duration cap', () => {
    const input = validPauseScenario();
    const steps = input['steps'] as Array<Record<string, unknown>>;
    steps[0]!['delayBeforeMs'] = SCENARIO_MAX_DURATION_MS;
    const result = validateScenarioInput(input, registry);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('DURATION_EXCEEDS_MAX');
  });

  it('always requires designated-test targets (DEC-008)', () => {
    const result = validateScenarioInput(
      validPauseScenario({ requires: { designatedTest: false, preset: 'two-node' } }),
      registry,
    );
    expect(result.valid).toBe(false);
    const issue = findIssue(result, 'SAFETY_DESIGNATED_TEST_REQUIRED');
    expect(issue?.severity).toBe('error');
    expect(issue?.path).toBe('requires.designatedTest');
  });

  it('validates step node labels against the declared preset', () => {
    const input = validPauseScenario();
    const steps = input['steps'] as Array<Record<string, unknown>>;
    (steps[0]!['operation'] as Record<string, unknown>)['config'] = { node: 'dave', durationMs: 10_000 };
    const result = validateScenarioInput(input, registry);
    expect(result.valid).toBe(false);
    expect(findIssue(result, 'TARGET_NODE_NOT_IN_PRESET')?.message).toContain('alice');

    const custom = validPauseScenario({
      requires: { designatedTest: true, preset: 'custom' },
    });
    const csteps = custom['steps'] as Array<Record<string, unknown>>;
    (csteps[0]!['operation'] as Record<string, unknown>)['config'] = { node: 'victim', durationMs: 10_000 };
    csteps[0]!['preconditions'] = [
      { kind: 'rpc-reachable', node: 'victim', expect: true },
      { kind: 'process-state', node: 'victim', expect: ['running'] },
    ];
    csteps[0]!['postconditions'] = [
      { kind: 'recovery-verified', node: 'victim' },
      { kind: 'rpc-reachable', node: 'victim', expect: true },
    ];
    const customResult = validateScenarioInput(custom, registry);
    expect(customResult.valid).toBe(true);
    expect(findIssue(customResult, 'TARGET_NODE_UNVERIFIABLE')?.severity).toBe('warning');
  });
});

describe('scenario validation — policy, names, tags, secrets, structure', () => {
  it('persists only enumerated failure/cancellation policy values', () => {
    const bad = validPauseScenario({ execution: { onStepFailed: 'explode' } as never });
    const badResult = validateScenarioInput(bad, registry);
    expect(badResult.valid).toBe(false);
    expect(codes(badResult)).toContain('INPUT_INVALID');

    const cleanup = validPauseScenario({ execution: { onCleanupFailed: 'ignore' } as never });
    expect(codes(validateScenarioInput(cleanup, registry))).toContain('INPUT_INVALID');

    const good = validPauseScenario({
      execution: { onPreconditionFailed: 'skip-step', onVerificationInconclusive: 'warn-and-continue' },
    });
    const goodResult = validateScenarioInput(good, registry);
    expect(goodResult.valid).toBe(true);
    const record = prepareScenario(good, registry, { id: 'scn-p', now: '2026-10-14T00:00:00.000Z' }).record;
    expect(record?.execution.onPreconditionFailed).toBe('skip-step');
    expect(record?.execution.onCleanupFailed).toBe('cancel-run');
    expect(record?.execution.cancellation).toBe('cleanup-then-stop');
  });

  it('validates names, tags, step counts and description length', () => {
    const name = validPauseScenario({ name: 'bad name!!' });
    expect(codes(validateScenarioInput(name, registry))).toContain('SCENARIO_NAME_INVALID');

    const tags = validPauseScenario({ tags: ['ok', 'BAD TAG'] });
    expect(codes(validateScenarioInput(tags, registry))).toContain('TAG_INVALID');

    const dupTag = validPauseScenario({ tags: ['drill', 'drill'] });
    const dupResult = validateScenarioInput(dupTag, registry);
    expect(dupResult.valid).toBe(true);
    expect(findIssue(dupResult, 'TAG_DUPLICATE')?.severity).toBe('warning');

    const long = validPauseScenario({ description: 'x'.repeat(1001) });
    expect(codes(validateScenarioInput(long, registry))).toContain('SCENARIO_DESCRIPTION_TOO_LONG');

    const noSteps = validPauseScenario();
    (noSteps as Record<string, unknown>)['steps'] = [];
    expect(codes(validateScenarioInput(noSteps, registry))).toContain('SCENARIO_NO_STEPS');

    const manySteps = validPauseScenario();
    const base = (validPauseScenario()['steps'] as Array<Record<string, unknown>>)[0]!;
    const steps: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 51; i += 1) {
      steps.push({ ...base, id: `s-${i}` });
    }
    (manySteps as Record<string, unknown>)['steps'] = steps;
    expect(codes(validateScenarioInput(manySteps, registry))).toContain('SCENARIO_TOO_MANY_STEPS');
  });

  it('rejects secret-shaped content anywhere it would be persisted', () => {
    const desc = validPauseScenario({ description: 'set db password: hunter2 for the drill' });
    const descResult = validateScenarioInput(desc, registry);
    expect(descResult.valid).toBe(false);
    const issue = findIssue(descResult, 'SECRET_CONTENT');
    expect(issue?.path).toBe('description');

    const pem = validPauseScenario();
    const steps = pem['steps'] as Array<Record<string, unknown>>;
    steps[0]!['description'] = 'key: -----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----';
    expect(codes(validateScenarioInput(pem, registry))).toContain('SECRET_CONTENT');
  });

  it('emits structured issues with stable code/severity/path/message/remediation', () => {
    const input = validPauseScenario();
    (input['steps'] as Array<Record<string, unknown>>)[0]!['preconditions'] = [];
    const result = validateScenarioInput(input, registry);
    for (const issue of result.issues) {
      expect(Object.keys(issue).sort()).toEqual(
        ['code', 'message', 'path', 'remediation', 'severity', 'stepId'].filter(
          (k) => k === 'stepId' ? issue.stepId !== undefined : true,
        ).sort(),
      );
      expect(['error', 'warning']).toContain(issue.severity);
      expect(issue.message.length).toBeGreaterThan(10);
      expect(issue.remediation.length).toBeGreaterThan(10);
    }
  });

  it('rejects non-object and schema-invalid input without throwing', () => {
    expect(validateScenarioInput(null, registry).valid).toBe(false);
    expect(validateScenarioInput('nope', registry).valid).toBe(false);
    expect(validateScenarioInput({ name: 'x' }, registry).valid).toBe(false);
    const unknownField = validPauseScenario() as Record<string, unknown>;
    unknownField['surprise'] = 1;
    expect(codes(validateScenarioInput(unknownField, registry))).toContain('INPUT_INVALID');
  });
});

describe('scenario validation — target capability rules', () => {
  // Synthetic registry: same shape as production, one supported operation
  // requiring a capability no Kaizen target guarantees by default.
  const synthetic: ScenarioOperationRegistry = {
    ...registry,
    get: (type) => {
      const def = registry.get(type);
      if (def && type === 'pause') {
        return {
          ...def,
          requiredCapabilities: ['managed-process', 'rpc-baseline', 'privileged-host'],
        };
      }
      return def;
    },
  };

  it('errors when a supported operation needs a capability the target does not provide', () => {
    const result = validateScenarioInput(validPauseScenario(), synthetic);
    expect(result.valid).toBe(false);
    const issue = findIssue(result, 'TARGET_CAPABILITY_MISSING');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('privileged-host');
  });

  it('accepts the capability when the author declares it in requires.capabilities', () => {
    const input = validPauseScenario({
      requires: { designatedTest: true, preset: 'two-node', capabilities: ['privileged-host'] },
    });
    expect(validateScenarioInput(input, synthetic).valid).toBe(true);
  });
});
