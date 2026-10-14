/**
 * Scenario normalization + deterministic validation (T-3.3, Phase 3C).
 *
 * Pure and UI-independent: same input + same operation registry ⇒
 * byte-identical ScenarioValidationResult (no timestamps inside the result).
 * Two layers:
 *   1. Zod schema — structural input validation (strict objects: unknown
 *      fields, including secret-shaped keys, are rejected).
 *   2. Semantic rules — codes, bounds, ordering, registry status, condition
 *      evaluability/contradictions, safety, capabilities, duration.
 *
 * Validation NEVER executes anything: it reads only the declarative registry
 * and the (optional) topology preset definitions. Execution is T-3.4 and
 * re-validates at run time through the FailureInjector's own gates.
 */

import { z } from 'zod';
import { redactSecrets } from '../fault/redact';
import { resolveTopology, NETWORK_PRESETS } from '../network/topologies';
import type { NodeHealthState, NodeStatus } from '../types';
import {
  SCENARIO_CONDITION_DEFINITIONS,
  type ScenarioOperationRegistry,
  type OperationDefinition,
} from './operations';
import {
  BASE_SCENARIO_CAPABILITIES,
  DEFAULT_SCENARIO_EXECUTION_POLICY,
  SCENARIO_CAPABILITIES,
  SCENARIO_CONDITION_DEFAULT_TIMEOUT_MS,
  SCENARIO_CONDITION_KINDS,
  SCENARIO_MAX_CONDITION_TIMEOUT_MS,
  SCENARIO_MAX_CONDITIONS_PER_SIDE,
  SCENARIO_MAX_DELAY_MS,
  SCENARIO_MAX_DESCRIPTION_LENGTH,
  SCENARIO_MAX_DURATION_MS,
  SCENARIO_MAX_NAME_LENGTH,
  SCENARIO_MAX_STEPS,
  SCENARIO_MAX_TAGS,
  SCENARIO_MIN_STEP_TIMEOUT_MS,
  SCENARIO_MAX_STEP_TIMEOUT_MS,
  SCENARIO_MAX_PAUSE_HOLD_MS,
  SCENARIO_NAME_PATTERN,
  SCENARIO_NODE_LABEL_PATTERN,
  SCENARIO_PAUSE_HOLD_HEADROOM_MS,
  SCENARIO_SCHEMA_VERSION,
  SCENARIO_STEP_ID_PATTERN,
  SCENARIO_TAG_PATTERN,
  type ScenarioCapability,
  type ScenarioCondition,
  type ScenarioExecutionPolicy,
  type ScenarioInput,
  type ScenarioIssueCode,
  type ScenarioRecord,
  type ScenarioStep,
  type ScenarioStepInput,
  type ScenarioTargetRequirements,
  type ScenarioValidationIssue,
  type ScenarioValidationResult,
} from './types';

// ---------------------------------------------------------------------------
// Exhaustive enum keys (compile-time asserted against the TS unions)

const NODE_STATUS_VALUES = Object.keys({
  created: 1,
  starting: 1,
  running: 1,
  stopping: 1,
  stopped: 1,
  crashed: 1,
  stale: 1,
} satisfies Record<NodeStatus, number>) as [NodeStatus, ...NodeStatus[]];

const NODE_HEALTH_STATE_VALUES = Object.keys({
  unknown: 1,
  healthy: 1,
  unhealthy: 1,
  unavailable: 1,
  stale: 1,
} satisfies Record<NodeHealthState, number>) as [NodeHealthState, ...NodeHealthState[]];

// ---------------------------------------------------------------------------
// Schemas (structural layer)

const timeoutField = z.number().int();

const conditionBase = { node: z.string().min(1), timeoutMs: timeoutField.optional() };

const conditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rpc-reachable'), expect: z.boolean(), ...conditionBase }).strict(),
  z
    .object({
      kind: z.literal('process-state'),
      expect: z.array(z.enum(NODE_STATUS_VALUES)).min(1),
      ...conditionBase,
    })
    .strict(),
  z
    .object({
      kind: z.literal('health-state'),
      expect: z.array(z.enum(NODE_HEALTH_STATE_VALUES)).min(1),
      ...conditionBase,
    })
    .strict(),
  z
    .object({
      kind: z.literal('peers'),
      op: z.enum(['gte', 'lte', 'eq']),
      value: z.number().int(),
      ...conditionBase,
    })
    .strict(),
  z.object({ kind: z.literal('syncing'), expect: z.boolean(), ...conditionBase }).strict(),
  z
    .object({
      kind: z.literal('chain-progress'),
      expect: z.enum(['advancing', 'stalled']),
      ...conditionBase,
    })
    .strict(),
  z.object({ kind: z.literal('recovery-verified'), ...conditionBase }).strict(),
  z
    .object({
      kind: z.literal('finality-progress'),
      expect: z.enum(['advancing', 'stalled']),
      ...conditionBase,
    })
    .strict(),
  z
    .object({
      kind: z.literal('runtime-event'),
      event: z.string().min(1).max(64),
      expect: z.enum(['observed', 'not-observed']),
      ...conditionBase,
    })
    .strict(),
]);

const stepInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    order: z.number().int().optional(),
    description: z.string().optional(),
    operation: z
      .object({ type: z.string().min(1).max(32), config: z.record(z.string(), z.unknown()) })
      .strict(),
    delayBeforeMs: timeoutField.optional(),
    delayAfterMs: timeoutField.optional(),
    timeoutMs: timeoutField.optional(),
    preconditions: z.array(conditionSchema).max(SCENARIO_MAX_CONDITIONS_PER_SIDE).optional(),
    postconditions: z.array(conditionSchema).max(SCENARIO_MAX_CONDITIONS_PER_SIDE).optional(),
  })
  .strict();

/** Execution policy: only enumerated values are representable, ever. */
const executionPolicySchema = z
  .object({
    onPreconditionFailed: z.enum(['skip-step', 'abort-run', 'cancel-run']).optional(),
    onStepFailed: z.enum(['abort-run', 'continue', 'cancel-run']).optional(),
    onVerificationInconclusive: z.enum(['fail-step', 'warn-and-continue']).optional(),
    onStepTimeout: z.enum(['fail-step', 'cancel-run']).optional(),
    // Single legal values today — anything else is rejected at the schema.
    onCleanupFailed: z.literal('cancel-run').optional(),
    cancellation: z.literal('cleanup-then-stop').optional(),
  })
  .strict();

const requiresSchema = z
  .object({
    designatedTest: z.boolean().optional(),
    preset: z.enum(NETWORK_PRESETS as unknown as [string, ...string[]]).optional(),
    minNodes: z.number().int().min(1).max(64).optional(),
    capabilities: z.array(z.enum(SCENARIO_CAPABILITIES)).optional(),
  })
  .strict();

export const scenarioInputSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    execution: executionPolicySchema.optional(),
    requires: requiresSchema.optional(),
    steps: z.array(stepInputSchema),
    schemaVersion: z.number().int().optional(),
    createdBy: z.string().max(64).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Helpers

interface IssueSink {
  issues: ScenarioValidationIssue[];
}

function push(
  sink: IssueSink,
  code: ScenarioIssueCode,
  severity: 'error' | 'warning',
  path: string,
  message: string,
  remediation: string,
  stepId?: string,
): void {
  const issue: ScenarioValidationIssue = {
    code,
    severity,
    message,
    remediation,
    path,
  };
  if (stepId !== undefined) issue.stepId = stepId;
  sink.issues.push(issue);
}

/** Authoring-time severity: blocked/planned operations stay representable as
 *  warnings so authors can draft for future availability — but nothing about
 *  them may ever read as executable. Supported operations fail hard. */
function severityFor(def: OperationDefinition): 'error' | 'warning' {
  return def.status === 'supported' ? 'error' : 'warning';
}

function containsSecret(value: string): boolean {
  return redactSecrets(value) !== value;
}

function scanSecrets(sink: IssueSink, path: string, value: string): void {
  if (containsSecret(value)) {
    push(
      sink,
      'SECRET_CONTENT',
      'error',
      path,
      'Content matches a secret-shaped pattern (key material, password/credential assignment).',
      'Scenario definitions are never a place for secrets: remove the secret-shaped text (or reference it by file path outside the scenario). See FR-7.',
    );
  }
}

interface NormalizedCondition {
  raw: ScenarioCondition;
  path: string;
}

interface NormalizedStep {
  id: string;
  order: number;
  description?: string;
  type: string;
  config: Record<string, unknown>;
  delayBeforeMs: number;
  delayAfterMs: number;
  timeoutMs: number;
  preconditions: NormalizedCondition[];
  postconditions: NormalizedCondition[];
}

interface NormalizedScenario {
  name: string;
  description: string;
  tags: string[];
  execution: ScenarioExecutionPolicy;
  requires: ScenarioTargetRequirements;
  schemaVersion: number;
  steps: NormalizedStep[];
}

/**
 * Deterministic normalization: assigns missing step ids, forces order =
 * array index (explicit mismatching input `order` is reported, not silently
 * honored), applies per-operation timeout defaults, fills bounded defaults,
 * merges the execution policy over the safe defaults, and dedupes tags and
 * capabilities (first occurrence wins).
 */
function normalize(input: ScenarioInput, registry: ScenarioOperationRegistry): NormalizedScenario {
  // Safe default: scenarios run only on designated test networks (DEC-008).
  // An explicit `false` is rejected by validation, so a prepared record only
  // ever carries designatedTest: true.
  const requires = {
    designatedTest: input.requires?.designatedTest !== false,
  } as ScenarioTargetRequirements;
  if (input.requires?.preset !== undefined) requires.preset = input.requires.preset;
  if (input.requires?.minNodes !== undefined) requires.minNodes = input.requires.minNodes;
  if (input.requires?.capabilities !== undefined) {
    requires.capabilities = [...new Set(input.requires.capabilities)];
  }

  const tags = input.tags !== undefined ? [...new Set(input.tags)] : [];

  const execution: ScenarioExecutionPolicy = {
    ...DEFAULT_SCENARIO_EXECUTION_POLICY,
    ...(input.execution ?? {}),
  } as ScenarioExecutionPolicy;

  const steps: NormalizedStep[] = input.steps.map((step, index) => {
    const def = registry.get(step.operation.type);
    const pauseDuration =
      step.operation.type === 'pause' &&
      typeof step.operation.config['durationMs'] === 'number'
        ? step.operation.config['durationMs']
        : undefined;

    let timeoutMs: number;
    if (step.timeoutMs !== undefined) {
      timeoutMs = step.timeoutMs;
    } else {
      const defaultMs = def?.timeouts.defaultMs ?? 120_000;
      // A pause step's default budget must cover its hold + cleanup/recovery.
      timeoutMs =
        pauseDuration !== undefined
          ? Math.max(defaultMs, pauseDuration + SCENARIO_PAUSE_HOLD_HEADROOM_MS)
          : defaultMs;
    }

    const normalized: NormalizedStep = {
      id: step.id ?? `step-${index + 1}`,
      order: index,
      type: step.operation.type,
      config: step.operation.config,
      delayBeforeMs: step.delayBeforeMs ?? 0,
      delayAfterMs: step.delayAfterMs ?? 0,
      timeoutMs,
      preconditions: (step.preconditions ?? []).map((raw, ci) => ({
        raw,
        path: `steps[${index}].preconditions[${ci}]`,
      })),
      postconditions: (step.postconditions ?? []).map((raw, ci) => ({
        raw,
        path: `steps[${index}].postconditions[${ci}]`,
      })),
    };
    if (step.description !== undefined) normalized.description = step.description;
    return normalized;
  });

  const normalized: NormalizedScenario = {
    name: input.name,
    description: input.description ?? '',
    tags,
    execution,
    requires,
    schemaVersion: input.schemaVersion ?? SCENARIO_SCHEMA_VERSION,
    steps,
  };
  return normalized;
}

// ---------------------------------------------------------------------------
// Condition semantic checks

function checkConditionNode(
  sink: IssueSink,
  cond: NormalizedCondition,
  stepId: string,
): boolean {
  if (!SCENARIO_NODE_LABEL_PATTERN.test(cond.raw.node)) {
    push(
      sink,
      'CONDITION_NODE_INVALID',
      'error',
      `${cond.path}.node`,
      `Condition node label "${cond.raw.node}" does not match ${SCENARIO_NODE_LABEL_PATTERN}.`,
      "Use the node's label within the topology (the part after \"<networkName>-\", e.g. 'alice').",
      stepId,
    );
    return false;
  }
  return true;
}

function checkConditionCommon(
  sink: IssueSink,
  cond: NormalizedCondition,
  stepId: string,
  def: OperationDefinition,
  side: 'preconditions' | 'postconditions',
): void {
  if (cond.raw.timeoutMs !== undefined) {
    if (cond.raw.timeoutMs < 0 || cond.raw.timeoutMs > SCENARIO_MAX_CONDITION_TIMEOUT_MS) {
      push(
        sink,
        'CONDITION_TIMEOUT_OUT_OF_BOUNDS',
        'error',
        `${cond.path}.timeoutMs`,
        `Condition evaluation timeout ${cond.raw.timeoutMs}ms is outside 0..${SCENARIO_MAX_CONDITION_TIMEOUT_MS}ms.`,
        `Use a bounded evaluation wait within 0..${SCENARIO_MAX_CONDITION_TIMEOUT_MS}ms (default ${SCENARIO_CONDITION_DEFAULT_TIMEOUT_MS}ms when omitted).`,
        stepId,
      );
    }
  }

  const definition = SCENARIO_CONDITION_DEFINITIONS[cond.raw.kind];
  if (!definition) {
    push(
      sink,
      'CONDITION_NOT_EVALUABLE',
      'error',
      `${cond.path}.kind`,
      `Unknown condition kind "${String(cond.raw.kind)}".`,
      `Known kinds: ${SCENARIO_CONDITION_KINDS.join(', ')}.`,
      stepId,
    );
    return;
  }
  if (definition.evaluability !== 'supported') {
    push(
      sink,
      'CONDITION_NOT_EVALUABLE',
      'error',
      `${cond.path}.kind`,
      `Condition kind "${cond.raw.kind}" is known but NOT evaluable by the current architecture — validation refuses to pretend it can be checked.`,
      definition.remediation ?? 'Use a supported condition kind instead.',
      stepId,
    );
    return;
  }

  const supportedList =
    side === 'preconditions' ? def.supportedPreconditions : def.supportedPostconditions;
  if (!supportedList.includes(cond.raw.kind)) {
    push(
      sink,
      'CONDITION_UNSUPPORTED_FOR_OPERATION',
      severityFor(def),
      `${cond.path}.kind`,
      `Operation "${def.type}" does not support "${cond.raw.kind}" as ${side.slice(0, -1)}.`,
      `Supported ${side} for "${def.type}": ${supportedList.join(', ') || '(none)'}.`,
      stepId,
    );
  }
}

/** Direct-opposition / impossibility checks WITHIN one phase (pre or post). */
function checkConditionsCoherent(
  sink: IssueSink,
  conditions: NormalizedCondition[],
  stepId: string,
  phasePath: string,
): void {
  for (let i = 0; i < conditions.length; i += 1) {
    const a = conditions[i];
    if (!a) continue;
    for (let j = i + 1; j < conditions.length; j += 1) {
      const b = conditions[j];
      if (!b) continue;
      if (a.raw.node !== b.raw.node) continue;
      const path = `${phasePath}[${i}]`;
      const pair = `${phasePath}[${i}] vs ${phasePath}[${j}]`;

      // --- boolean expectations -------------------------------------------
      if (a.raw.kind === 'rpc-reachable' && b.raw.kind === 'rpc-reachable') {
        if (a.raw.expect !== b.raw.expect) {
          push(sink, 'CONDITION_CONTRADICTORY', 'error', path,
            `Contradictory expectations for rpc-reachable on "${a.raw.node}" (${pair}).`,
            'Keep one rpc-reachable expectation per node per phase.', stepId);
        }
        continue;
      }
      if (a.raw.kind === 'syncing' && b.raw.kind === 'syncing') {
        if (a.raw.expect !== b.raw.expect) {
          push(sink, 'CONDITION_CONTRADICTORY', 'error', path,
            `Contradictory expectations for syncing on "${a.raw.node}" (${pair}).`,
            'Keep one syncing expectation per node per phase.', stepId);
        }
        continue;
      }
      if (
        (a.raw.kind === 'chain-progress' || a.raw.kind === 'finality-progress') &&
        a.raw.kind === b.raw.kind &&
        a.raw.expect !== b.raw.expect
      ) {
        push(sink, 'CONDITION_CONTRADICTORY', 'error', path,
          `Contradictory expectations for ${a.raw.kind} on "${a.raw.node}" (${pair}).`,
          'Keep one progress expectation per node per phase.', stepId);
        continue;
      }

      // --- set-based expectations -----------------------------------------
      if (a.raw.kind === 'process-state' && b.raw.kind === 'process-state') {
        const bExpect = b.raw.expect;
        const overlap = a.raw.expect.some((s) => bExpect.includes(s));
        if (!overlap) {
          push(sink, 'CONDITION_CONTRADICTORY', 'error', path,
            `Process-state expectations do not overlap on "${a.raw.node}" (${a.raw.expect.join('|')} vs ${b.raw.expect.join('|')}) (${pair}).`,
            'Merge into one process-state condition whose expectations can hold together.', stepId);
        }
        continue;
      }
      if (a.raw.kind === 'health-state' && b.raw.kind === 'health-state') {
        const bExpect = b.raw.expect;
        const overlap = a.raw.expect.some((s) => bExpect.includes(s));
        if (!overlap) {
          push(sink, 'CONDITION_CONTRADICTORY', 'error', path,
            `Health-state expectations do not overlap on "${a.raw.node}" (${a.raw.expect.join('|')} vs ${b.raw.expect.join('|')}) (${pair}).`,
            'Merge into one health-state condition whose expectations can hold together.', stepId);
        }
        continue;
      }

      // --- peer-count constraints -----------------------------------------
      if (a.raw.kind === 'peers' && b.raw.kind === 'peers') {
        const peersIssue = comparePeerConstraints(a.raw, b.raw, pair);
        if (peersIssue) {
          push(sink, peersIssue.code, 'error', path, peersIssue.message,
            peersIssue.remediation, stepId);
        }
        continue;
      }

      // --- cross-kind impossibilities --------------------------------------
      if (a.raw.kind === 'rpc-reachable' || b.raw.kind === 'rpc-reachable') {
        const reach = a.raw.kind === 'rpc-reachable' ? a : b;
        const other = a.raw.kind === 'rpc-reachable' ? b : a;
        if (reach.raw.kind === 'rpc-reachable' && reach.raw.expect === true) {
          if (
            other.raw.kind === 'process-state' &&
            other.raw.expect.length > 0 &&
            other.raw.expect.every((s) => s === 'stopped' || s === 'crashed')
          ) {
            push(sink, 'CONDITION_UNPOSSIBLE', 'error', path,
              `Impossible combination: a process in ${other.raw.expect.join('/')} cannot answer RPC on "${reach.raw.node}" (${pair}).`,
              'Drop the rpc-reachable expectation or expect a live process state.', stepId);
            continue;
          }
          if (
            other.raw.kind === 'health-state' &&
            other.raw.expect.length > 0 &&
            other.raw.expect.every((s) => s === 'unavailable')
          ) {
            push(sink, 'CONDITION_UNPOSSIBLE', 'error', path,
              `Impossible combination: 'unavailable' health means RPC is failing, but rpc-reachable expects true on "${reach.raw.node}" (${pair}).`,
              'Use rpc-reachable:false, or expect a state that allows RPC to answer.', stepId);
            continue;
          }
        }
        if (reach.raw.kind === 'rpc-reachable' && reach.raw.expect === false) {
          if (other.raw.kind === 'recovery-verified') {
            push(sink, 'CONDITION_CONTRADICTORY', 'error', path,
              `recovery-verified implies the node is back, contradicting rpc-reachable:false on "${reach.raw.node}" (${pair}).`,
              'Keep recovery-verified and rpc-reachable:false in different phases.', stepId);
            continue;
          }
        }
      }
      if (
        (a.raw.kind === 'recovery-verified' || b.raw.kind === 'recovery-verified') &&
        a.raw.kind !== b.raw.kind
      ) {
        const rec = a.raw.kind === 'recovery-verified' ? a : b;
        const other = a.raw.kind === 'recovery-verified' ? b : a;
        if (
          other.raw.kind === 'process-state' &&
          other.raw.expect.every((s) => s === 'stopped' || s === 'crashed')
        ) {
          push(sink, 'CONDITION_CONTRADICTORY', 'error', path,
            `recovery-verified contradicts process-state ${other.raw.expect.join('/')} on "${rec.raw.node}" (${pair}).`,
            'Recovery means a live, running process — expect running instead.', stepId);
          continue;
        }
      }
    }
  }
}

function comparePeerConstraints(
  a: Extract<ScenarioCondition, { kind: 'peers' }>,
  b: Extract<ScenarioCondition, { kind: 'peers' }>,
  pair: string,
): { code: ScenarioIssueCode; message: string; remediation: string } | undefined {
  const { op: op1, value: v1 } = a;
  const { op: op2, value: v2 } = b;
  if (v1 < 0 || v2 < 0) {
    return {
      code: 'CONDITION_UNPOSSIBLE',
      message: `Negative peer count is impossible (${pair}).`,
      remediation: 'Peer counts are >= 0.',
    };
  }
  if (op1 === 'eq' && op2 === 'eq' && v1 !== v2) {
    return {
      code: 'CONDITION_CONTRADICTORY',
      message: `Peer count cannot equal both ${v1} and ${v2} (${pair}).`,
      remediation: 'Use one peers condition per node per phase.',
    };
  }
  if (op1 === 'gte' && op2 === 'lte' && v1 > v2) {
    return { code: 'CONDITION_UNPOSSIBLE', message: `No peer count satisfies gte ${v1} and lte ${v2} (${pair}).`, remediation: 'Relax one of the bounds.' };
  }
  if (op1 === 'lte' && op2 === 'gte' && v2 > v1) {
    return { code: 'CONDITION_UNPOSSIBLE', message: `No peer count satisfies gte ${v2} and lte ${v1} (${pair}).`, remediation: 'Relax one of the bounds.' };
  }
  if (op1 === 'gte' && op2 === 'eq' && v2 < v1) {
    return { code: 'CONDITION_CONTRADICTORY', message: `Peer count ${v2} violates gte ${v1} (${pair}).`, remediation: 'Align the exact count with the lower bound.' };
  }
  if (op1 === 'eq' && op2 === 'gte' && v1 < v2) {
    return { code: 'CONDITION_CONTRADICTORY', message: `Peer count ${v1} violates gte ${v2} (${pair}).`, remediation: 'Align the exact count with the lower bound.' };
  }
  if (op1 === 'lte' && op2 === 'eq' && v2 > v1) {
    return { code: 'CONDITION_CONTRADICTORY', message: `Peer count ${v2} violates lte ${v1} (${pair}).`, remediation: 'Align the exact count with the upper bound.' };
  }
  if (op1 === 'eq' && op2 === 'lte' && v1 > v2) {
    return { code: 'CONDITION_CONTRADICTORY', message: `Peer count ${v1} violates lte ${v2} (${pair}).`, remediation: 'Align the exact count with the upper bound.' };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main entry points

function zodIssuesToStructured(sink: IssueSink, error: z.ZodError): void {
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    push(
      sink,
      'INPUT_INVALID',
      'error',
      path,
      issue.message,
      'Fix the field so it matches the scenario schema (strict objects — unknown fields are rejected).',
    );
  }
}

/**
 * Deterministic validation of a raw authoring input against the operation
 * registry. Pure: touches no store, no processes, no clock.
 */
export function validateScenarioInput(
  rawInput: unknown,
  registry: ScenarioOperationRegistry,
): ScenarioValidationResult {
  const sink: IssueSink = { issues: [] };
  let stepCount = 0;
  let worstCaseDurationMs = 0;

  const parsed = scenarioInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    zodIssuesToStructured(sink, parsed.error);
    return finalize(sink, worstCaseDurationMs, stepCount);
  }
  const input = parsed.data as ScenarioInput;
  const normalized = normalize(input, registry);
  stepCount = normalized.steps.length;

  // ---- scenario-level ----------------------------------------------------
  if (normalized.schemaVersion !== SCENARIO_SCHEMA_VERSION) {
    push(sink, 'SCHEMA_VERSION_UNSUPPORTED', 'error', 'schemaVersion',
      `Scenario schemaVersion ${normalized.schemaVersion} is not supported (this build writes/reads v${SCENARIO_SCHEMA_VERSION}).`,
      `Send schemaVersion ${SCENARIO_SCHEMA_VERSION} or omit it to default to the current version.`);
  }
  if (!SCENARIO_NAME_PATTERN.test(normalized.name) || normalized.name.length > SCENARIO_MAX_NAME_LENGTH) {
    push(sink, 'SCENARIO_NAME_INVALID', 'error', 'name',
      `Name "${normalized.name}" must be 1..${SCENARIO_MAX_NAME_LENGTH} chars matching ${SCENARIO_NAME_PATTERN}.`,
      'Use a short descriptive name (letters, digits, space, _ . -).');
  }
  if (normalized.description.length > SCENARIO_MAX_DESCRIPTION_LENGTH) {
    push(sink, 'SCENARIO_DESCRIPTION_TOO_LONG', 'error', 'description',
      `Description is ${normalized.description.length} chars (max ${SCENARIO_MAX_DESCRIPTION_LENGTH}).`,
      'Shorten the description.');
  }
  if (input.tags !== undefined) {
    if (input.tags.length > SCENARIO_MAX_TAGS) {
      push(sink, 'TAG_INVALID', 'error', 'tags',
        `${input.tags.length} tags (max ${SCENARIO_MAX_TAGS}).`,
        `Keep at most ${SCENARIO_MAX_TAGS} tags.`);
    }
    input.tags.forEach((tag, ti) => {
      if (!SCENARIO_TAG_PATTERN.test(tag)) {
        push(sink, 'TAG_INVALID', 'error', `tags[${ti}]`,
          `Tag "${tag}" must match ${SCENARIO_TAG_PATTERN}.`,
          'Tags are lowercase slug-like labels (e.g. "recovery-drill").');
      } else if (normalized.tags.indexOf(tag) !== ti) {
        push(sink, 'TAG_DUPLICATE', 'warning', `tags[${ti}]`,
          `Duplicate tag "${tag}" (kept once).`,
          'Remove the duplicate.');
      }
    });
  }
  scanSecrets(sink, 'name', normalized.name);
  if (input.description !== undefined) scanSecrets(sink, 'description', input.description);
  (input.tags ?? []).forEach((tag, ti) => scanSecrets(sink, `tags[${ti}]`, tag));

  if (normalized.steps.length === 0) {
    push(sink, 'SCENARIO_NO_STEPS', 'error', 'steps',
      'A scenario needs at least one step.',
      'Add an ordered step (operation + preconditions).');
  }
  if (normalized.steps.length > SCENARIO_MAX_STEPS) {
    push(sink, 'SCENARIO_TOO_MANY_STEPS', 'error', 'steps',
      `${normalized.steps.length} steps (max ${SCENARIO_MAX_STEPS}).`,
      `Split the scenario or keep at most ${SCENARIO_MAX_STEPS} steps.`);
  }
  if (!normalized.requires.designatedTest) {
    push(sink, 'SAFETY_DESIGNATED_TEST_REQUIRED', 'error', 'requires.designatedTest',
      'requires.designatedTest=false is never allowed: scenario operations run only on designated test networks (DEC-008).',
      'Set requires.designatedTest=true (the default) and target a designated test network.');
  }

  // ---- per-step ----------------------------------------------------------
  const seenIds = new Map<string, number>();
  input.steps.forEach((rawStep: ScenarioStepInput, index: number) => {
    const step = normalized.steps[index];
    if (!step) return;
    const prefix = `steps[${index}]`;
    const def = registry.get(step.type);

    if (!SCENARIO_STEP_ID_PATTERN.test(step.id)) {
      push(sink, 'STEP_ID_INVALID', 'error', `${prefix}.id`,
        `Step id "${step.id}" must match ${SCENARIO_STEP_ID_PATTERN}.`,
        'Use a short stable slug (e.g. "pause-alice").', step.id);
    }
    if (seenIds.has(step.id)) {
      push(sink, 'STEP_ID_DUPLICATE', 'error', `${prefix}.id`,
        `Duplicate step id "${step.id}" (first at steps[${seenIds.get(step.id)}]).`,
        'Give every step a unique stable id.', step.id);
    } else {
      seenIds.set(step.id, index);
    }
    if (rawStep.order !== undefined && rawStep.order !== index) {
      push(sink, 'STEP_ORDER_MISMATCH', 'error', `${prefix}.order`,
        `Explicit order ${rawStep.order} does not match position ${index} — array position is authoritative.`,
        'Remove the order field or send steps in the order you mean (position defines sequence).', step.id);
    }
    for (const [field, value] of [
      ['delayBeforeMs', step.delayBeforeMs],
      ['delayAfterMs', step.delayAfterMs],
    ] as const) {
      if (value < 0 || value > SCENARIO_MAX_DELAY_MS) {
        push(sink, 'DELAY_OUT_OF_BOUNDS', 'error', `${prefix}.${field}`,
          `${field} ${value}ms is outside 0..${SCENARIO_MAX_DELAY_MS}ms.`,
          `Use a bounded delay within 0..${SCENARIO_MAX_DELAY_MS}ms (0 when no delay is needed).`, step.id);
      }
    }
    if (step.timeoutMs < SCENARIO_MIN_STEP_TIMEOUT_MS || step.timeoutMs > SCENARIO_MAX_STEP_TIMEOUT_MS) {
      push(sink, 'TIMEOUT_OUT_OF_BOUNDS', 'error', `${prefix}.timeoutMs`,
        `Step timeout ${step.timeoutMs}ms is outside ${SCENARIO_MIN_STEP_TIMEOUT_MS}..${SCENARIO_MAX_STEP_TIMEOUT_MS}ms.`,
        `Use a bounded step timeout within the central limits (${SCENARIO_MIN_STEP_TIMEOUT_MS}..${SCENARIO_MAX_STEP_TIMEOUT_MS}ms).`, step.id);
    }

    if (rawStep.description !== undefined) {
      scanSecrets(sink, `${prefix}.description`, rawStep.description);
    }
    for (const [key, value] of Object.entries(step.config)) {
      if (typeof value === 'string') scanSecrets(sink, `${prefix}.operation.config.${key}`, value);
    }

    worstCaseDurationMs += step.delayBeforeMs + step.delayAfterMs + step.timeoutMs;

    if (!def) {
      push(sink, 'OPERATION_UNKNOWN', 'error', `${prefix}.operation.type`,
        `Unknown operation type "${step.type}" — it is not in the safe operation registry.`,
        `Known operation types: ${registry.types().join(', ')}. Operations are engine-defined; arbitrary actions are never allowed.`);
      return;
    }

    const severity = severityFor(def);

    // config schema (strict: unknown/secret-shaped keys rejected by schema)
    const configParsed = def.configSchema.safeParse(step.config);
    if (!configParsed.success) {
      for (const issue of configParsed.error.issues) {
        const fieldPath = `${prefix}.operation.config${issue.path.length > 0 ? `.${issue.path.join('.')}` : ''}`;
        push(sink, 'OPERATION_CONFIG_INVALID', severity, fieldPath,
          `Invalid config for "${def.type}": ${issue.message}`,
          `Config fields for "${def.type}": ${def.configFields.join(', ') || '(none)'}.`, step.id);
      }
    }

    if (def.status === 'blocked') {
      push(sink, 'OPERATION_BLOCKED', 'warning', `${prefix}.operation.type`,
        `Operation "${def.type}" is registered but BLOCKED today — it can never be shown or run as executable. ${def.statusReason ?? ''}`.trim(),
        def.statusUnblock ?? 'See the operation registry for the unblock path.', step.id);
    } else if (def.status === 'planned') {
      push(sink, 'OPERATION_PLANNED', 'warning', `${prefix}.operation.type`,
        `Operation "${def.type}" is planned but NOT implemented yet. ${def.statusReason ?? ''}`.trim(),
        'Do not rely on this step until the implementation lands (T-3.4/T-4.x).', step.id);
    }

    // target capabilities (authoring-time view; runtime gates still apply)
    const provided = new Set<ScenarioCapability>([
      ...BASE_SCENARIO_CAPABILITIES,
      ...(normalized.requires.capabilities ?? []),
    ]);
    for (const capability of def.requiredCapabilities) {
      if (!provided.has(capability)) {
        push(sink, 'TARGET_CAPABILITY_MISSING', severity, `${prefix}.operation.type`,
          `Operation "${def.type}" requires target capability "${capability}", which this scenario's target requirements do not provide.`,
          `Declare it in requires.capabilities when the target genuinely provides it, or remove the step (capabilities: ${def.requiredCapabilities.join(', ')}).`, step.id);
      }
    }

    // preset ↔ node label check
    const nodeLabel = typeof step.config['node'] === 'string' ? step.config['node'] : undefined;
    if (nodeLabel !== undefined && SCENARIO_NODE_LABEL_PATTERN.test(nodeLabel)) {
      if (normalized.requires.preset === 'custom') {
        push(sink, 'TARGET_NODE_UNVERIFIABLE', 'warning', `${prefix}.operation.config.node`,
          `Node label "${nodeLabel}" cannot be verified: custom topologies are defined at network-creation time.`,
          'Declare a concrete preset (or accept run-time resolution when the scenario executes).', step.id);
      } else if (normalized.requires.preset !== undefined) {
        const plan = resolveTopology(normalized.requires.preset);
        const labels = plan.nodes.map((n) => n.nameSuffix);
        if (!labels.includes(nodeLabel)) {
          push(sink, 'TARGET_NODE_NOT_IN_PRESET', severity, `${prefix}.operation.config.node`,
            `Node label "${nodeLabel}" does not exist in preset "${normalized.requires.preset}" (labels: ${labels.join(', ')}).`,
            `Use one of: ${labels.join(', ')}, or drop requires.preset to target any network.`, step.id);
        }
      }
    }

    // pause hold must fit inside the step budget
    if (def.timeoutCoversHold && typeof step.config['durationMs'] === 'number') {
      const hold = step.config['durationMs'];
      if (hold > SCENARIO_MAX_PAUSE_HOLD_MS) {
        push(sink, 'OPERATION_CONFIG_INVALID', severity, `${prefix}.operation.config.durationMs`,
          `Pause hold ${hold}ms exceeds the maximum ${SCENARIO_MAX_PAUSE_HOLD_MS}ms.`,
          `Use a hold within 0..${SCENARIO_MAX_PAUSE_HOLD_MS}ms.`, step.id);
      } else if (step.timeoutMs < hold + SCENARIO_PAUSE_HOLD_HEADROOM_MS) {
        push(sink, 'TIMEOUT_TOO_SHORT_FOR_HOLD', severity, `${prefix}.timeoutMs`,
          `Step timeout ${step.timeoutMs}ms cannot cover a ${hold}ms pause hold plus ${SCENARIO_PAUSE_HOLD_HEADROOM_MS}ms cleanup/recovery headroom.`,
          `Raise timeoutMs to at least ${hold + SCENARIO_PAUSE_HOLD_HEADROOM_MS}ms.`, step.id);
      }
    }

    // precondition rules (fault steps require explicit baseline)
    if (def.kind === 'fault') {
      const node = nodeLabel;
      const hasRpcBaseline = step.preconditions.some(
        (c) => c.raw.kind === 'rpc-reachable' && c.raw.expect === true && c.raw.node === node,
      );
      const hasProcessBaseline = step.preconditions.some(
        (c) => c.raw.kind === 'process-state' && c.raw.expect.includes('running') && c.raw.node === node,
      );
      if (!hasRpcBaseline || !hasProcessBaseline) {
        const missing = [
          !hasRpcBaseline ? "rpc-reachable{expect:true}" : undefined,
          !hasProcessBaseline ? "process-state{expect:['running']}" : undefined,
        ].filter(Boolean);
        push(sink, 'PRECONDITION_MISSING', severity, `${prefix}.preconditions`,
          `Fault step "${step.type}" is missing required precondition(s) for its target node: ${missing.join(' and ')}.`,
          `Add ${missing.join(' and ')} conditions for node "${String(node)}" so the fault never applies to a dead or unreachable target.`, step.id);
      }
      if (step.postconditions.length === 0) {
        push(sink, 'POSTCONDITION_MISSING', 'warning', `${prefix}.postconditions`,
          'Fault step has no postconditions — recovery/effect verification would be unrecorded.',
          'Add at least one postcondition (e.g. recovery-verified or rpc-reachable) so the outcome is checked explicitly.', step.id);
      }
    }

    for (const cond of [...step.preconditions, ...step.postconditions]) {
      checkConditionNode(sink, cond, step.id);
    }
    for (const cond of step.preconditions) {
      checkConditionCommon(sink, cond, step.id, def, 'preconditions');
    }
    for (const cond of step.postconditions) {
      checkConditionCommon(sink, cond, step.id, def, 'postconditions');
    }
    checkConditionsCoherent(sink, step.preconditions, step.id, `${prefix}.preconditions`);
    checkConditionsCoherent(sink, step.postconditions, step.id, `${prefix}.postconditions`);
  });

  // ---- scenario-level (post) --------------------------------------------
  if (worstCaseDurationMs > SCENARIO_MAX_DURATION_MS) {
    push(sink, 'DURATION_EXCEEDS_MAX', 'error', 'steps',
      `Worst-case duration ${worstCaseDurationMs}ms exceeds the ${SCENARIO_MAX_DURATION_MS}ms scenario cap (Σ delays + step timeouts).`,
      `Shorten delays/timeouts so the worst case stays within ${SCENARIO_MAX_DURATION_MS}ms.`);
  }

  return finalize(sink, worstCaseDurationMs, stepCount);
}

function finalize(
  sink: IssueSink,
  worstCaseDurationMs: number,
  stepCount: number,
): ScenarioValidationResult {
  const errorCount = sink.issues.filter((i) => i.severity === 'error').length;
  const warningCount = sink.issues.filter((i) => i.severity === 'warning').length;
  return {
    valid: errorCount === 0,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    issues: sink.issues,
    errorCount,
    warningCount,
    worstCaseDurationMs,
    stepCount,
  };
}

// ---------------------------------------------------------------------------
// Preparation: normalize + validate + (when valid) build the record

export interface PrepareOptions {
  /** Stable id for the record (creation) or the existing id (update). */
  id: string;
  /** ISO timestamp supplied by the caller (keeps prepare pure/testable). */
  now: string;
  /** Audit actor (defaults to input.createdBy, else 'engine'). */
  actor?: string;
}

export interface PrepareResult {
  result: ScenarioValidationResult;
  /** Non-null iff the scenario has zero errors (warnings allowed). */
  record: ScenarioRecord | null;
}

/**
 * Full authoring pipeline: parse → normalize → validate → build record.
 * Record construction only happens when validation found no errors, so an
 * invalid scenario can never be persisted in any shape.
 */
export function prepareScenario(
  rawInput: unknown,
  registry: ScenarioOperationRegistry,
  options: PrepareOptions,
): PrepareResult {
  const result = validateScenarioInput(rawInput, registry);
  if (!result.valid || result.stepCount === 0) {
    return { result, record: null };
  }

  const parsed = scenarioInputSchema.safeParse(rawInput);
  if (!parsed.success) return { result, record: null };
  const input = parsed.data as ScenarioInput;
  const normalized = normalize(input, registry);

  const steps: ScenarioStep[] = normalized.steps.map((step) => {
    // Config was schema-validated against the registry's per-operation schema
    // (errors above would have aborted record construction), so it narrows to
    // the typed operation union.
    const operation = { type: step.type, config: step.config } as unknown as ScenarioStep['operation'];
    const outStep: ScenarioStep = {
      id: step.id,
      order: step.order,
      operation,
      delayBeforeMs: step.delayBeforeMs,
      delayAfterMs: step.delayAfterMs,
      timeoutMs: step.timeoutMs,
      preconditions: step.preconditions.map((c) => c.raw),
      postconditions: step.postconditions.map((c) => c.raw),
    };
    if (step.description !== undefined) outStep.description = step.description;
    return outStep;
  });

  const createdBy = options.actor ?? input.createdBy ?? 'engine';
  const record: ScenarioRecord = {
    id: options.id,
    name: normalized.name,
    description: normalized.description,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    tags: normalized.tags,
    requires: normalized.requires,
    steps,
    execution: normalized.execution,
    validation: result,
    validationStatus: result.warningCount > 0 ? 'warning' : 'valid',
    createdBy,
    updatedBy: createdBy,
    createdAt: options.now,
    updatedAt: options.now,
  };
  return { result, record };
}
