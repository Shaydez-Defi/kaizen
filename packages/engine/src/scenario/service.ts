/**
 * ScenarioService (T-3.3, Phase 3C) — CRUD + validation for scenario
 * definitions, over the shared SQLite store (DEC-005/DEC-002).
 *
 * This service is deliberately NARROW: it validates, persists, lists, and
 * deletes scenario data, and it emits authoring audit events. It has NO
 * execution path — no fault is applied, no process touched, no network
 * targeted. Execution (T-3.4 ScenarioEngine) re-validates through the
 * FailureInjector's own gates at run time; saving a scenario NEVER runs it.
 *
 * The operation registry is built from the FailureInjector's registered
 * mechanisms (`describeMechanisms()`), so this service can never disagree
 * with what the injector actually supports — blocked mechanisms (peer
 * disconnect, partition) stay blocked and are never executable.
 */

import { randomBytes } from 'node:crypto';
import type { FaultMechanismInfo } from '../fault/adapter';
import { KaizenError } from '../errors';
import type { EventBus } from '../events/bus';
import type { StateStore } from '../state/store';
import {
  buildOperationRegistry,
  serializeOperationDefinition,
  type ScenarioOperationRegistry,
  type SerializedOperationDefinition,
} from './operations';
import {
  prepareScenario,
  scenarioInputSchema,
  validateScenarioInput,
} from './validate';
import type {
  ScenarioListResult,
  ScenarioRecord,
  ScenarioValidationResult,
} from './types';

export interface ScenarioServiceOptions {
  store: StateStore;
  events?: EventBus;
  /**
   * Mechanisms from the live FailureInjector (`injector.describeMechanisms()`).
   * The registry is derived from this — never from a duplicated static list.
   */
  mechanisms: FaultMechanismInfo[];
}

export interface ScenarioListFilter {
  q?: string;
  tag?: string;
  status?: 'valid' | 'warning';
  limit?: number;
  offset?: number;
}

export interface ScenarioPage extends ScenarioListResult {
  total: number;
  limit: number;
  offset: number;
}

function invalidScenarioError(result: ScenarioValidationResult): KaizenError {
  return new KaizenError(
    'SCENARIO_INVALID',
    `Scenario validation failed with ${result.errorCount} error(s) and ${result.warningCount} warning(s)`,
    { issues: result.issues, errorCount: result.errorCount, warningCount: result.warningCount },
  );
}

function alreadyExistsError(name: string): KaizenError {
  return new KaizenError(
    'SCENARIO_ALREADY_EXISTS',
    `A scenario named "${name}" already exists`,
    { name },
  );
}

/** Convert a persisted step back into authoring-input shape (for merges). */
function stepToInput(step: ScenarioRecord['steps'][number]): Record<string, unknown> {
  return {
    id: step.id,
    order: step.order,
    description: step.description,
    operation: { type: step.operation.type, config: { ...step.operation.config } },
    delayBeforeMs: step.delayBeforeMs,
    delayAfterMs: step.delayAfterMs,
    timeoutMs: step.timeoutMs,
    preconditions: step.preconditions.map((c) => ({ ...c })),
    postconditions: step.postconditions.map((c) => ({ ...c })),
  };
}

/**
 * Merge a patch over an existing record into one authoring input, then run it
 * through the SAME validation pipeline as create — updates are re-validated
 * as a whole, so a patch can never smuggle in an invalid end state.
 */
function mergePatch(
  existing: ScenarioRecord,
  patchRaw: unknown,
): unknown {
  const parsed = scenarioInputSchema.partial().safeParse(patchRaw);
  if (!parsed.success) {
    // Pass the raw patch through the main validator so the caller gets the
    // same structured issue format as any other invalid input.
    return patchRaw;
  }
  const patch = parsed.data;
  return {
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    tags: patch.tags ?? existing.tags,
    execution: patch.execution !== undefined
      ? { ...existing.execution, ...patch.execution }
      : existing.execution,
    requires: patch.requires !== undefined
      ? { ...existing.requires, ...patch.requires }
      : existing.requires,
    steps: patch.steps ?? existing.steps.map(stepToInput),
    schemaVersion: patch.schemaVersion,
  };
}

export class ScenarioService {
  readonly operations: ScenarioOperationRegistry;
  private readonly store: StateStore;
  private readonly events?: EventBus;

  constructor(options: ScenarioServiceOptions) {
    this.store = options.store;
    this.events = options.events;
    this.operations = buildOperationRegistry(options.mechanisms);
  }

  /** JSON-safe registry view for authoring clients (statuses + limits). */
  describeOperations(): SerializedOperationDefinition[] {
    return this.operations.all().map(serializeOperationDefinition);
  }

  list(filter: ScenarioListFilter = {}): ScenarioPage {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const result = this.store.listScenarios({
      ...(filter.q !== undefined ? { q: filter.q } : {}),
      ...(filter.tag !== undefined ? { tag: filter.tag } : {}),
      ...(filter.status !== undefined ? { status: filter.status } : {}),
      limit,
      offset,
    });
    const total = this.store.countScenarios({
      ...(filter.q !== undefined ? { q: filter.q } : {}),
      ...(filter.tag !== undefined ? { tag: filter.tag } : {}),
      ...(filter.status !== undefined ? { status: filter.status } : {}),
    });
    return { ...result, total, limit, offset };
  }

  get(id: string): ScenarioRecord {
    return this.store.getScenario(id);
  }

  /** Validate WITHOUT saving or executing anything. Deterministic. */
  validate(input: unknown): ScenarioValidationResult {
    return validateScenarioInput(input, this.operations);
  }

  create(input: unknown, actor?: string): ScenarioRecord {
    const now = new Date().toISOString();
    const { result, record } = prepareScenario(input, this.operations, {
      id: `scn-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
      now,
      ...(actor !== undefined ? { actor } : {}),
    });
    if (!record) throw invalidScenarioError(result);
    if (this.store.scenarioNameExists(record.name)) {
      throw alreadyExistsError(record.name);
    }
    this.store.insertScenario(record);
    this.events?.emit('scenario.created', {
      scenarioId: record.id,
      name: record.name,
      validationStatus: record.validationStatus,
      steps: record.steps.length,
      actor: record.createdBy,
      at: now,
    });
    return record;
  }

  update(id: string, patch: unknown, actor?: string): ScenarioRecord {
    const existing = this.store.getScenario(id);
    const now = new Date().toISOString();
    const merged = mergePatch(existing, patch);
    const { result, record } = prepareScenario(merged, this.operations, {
      id,
      now,
      actor: actor ?? existing.updatedBy ?? 'engine',
    });
    if (!record) throw invalidScenarioError(result);
    if (this.store.scenarioNameExists(record.name, id)) {
      throw alreadyExistsError(record.name);
    }
    const finalRecord: ScenarioRecord = {
      ...record,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
    this.store.updateScenario(finalRecord);
    this.events?.emit('scenario.updated', {
      scenarioId: id,
      name: finalRecord.name,
      validationStatus: finalRecord.validationStatus,
      steps: finalRecord.steps.length,
      actor: finalRecord.updatedBy,
      at: now,
    });
    return finalRecord;
  }

  remove(id: string, actor?: string): void {
    const existing = this.store.getScenario(id);
    this.store.deleteScenario(id);
    this.events?.emit('scenario.deleted', {
      scenarioId: id,
      name: existing.name,
      actor: actor ?? existing.updatedBy ?? 'engine',
      at: new Date().toISOString(),
    });
  }
}
