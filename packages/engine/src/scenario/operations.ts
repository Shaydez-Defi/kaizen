/**
 * Safe operation registry (T-3.3, Phase 3C) — DESCRIPTIVE ONLY.
 *
 * This registry is the single authoring-time view of which operations a
 * scenario may reference. It is built from the FailureInjector's actual
 * registered adapters (`describeMechanisms()`), so support status, blocked
 * reasons, and unblock paths are never re-declared or contradicted here.
 *
 * It must NEVER be used to bypass runtime safety: execution (T-3.4) still
 * goes through the FailureInjector's preflight/dry-run/gates (DEC-019,
 * DEC-008). A registry entry saying 'supported' means "the mechanism exists
 * in the engine today" — not "this scenario may run on any target".
 *
 * There is no arbitrary shell, signal, firewall, or executable-path surface:
 * configs are schema-validated objects targeting engine-managed nodes only.
 */

import { z } from 'zod';
import type { FaultMechanismInfo } from '../fault/adapter';
import type { FaultPrivileges } from '../fault/types';
import {
  BASE_SCENARIO_CAPABILITIES,
  SCENARIO_CONDITION_KINDS,
  SCENARIO_MAX_PAUSE_HOLD_MS,
  SCENARIO_MAX_STEP_TIMEOUT_MS,
  SCENARIO_MIN_STEP_TIMEOUT_MS,
  SCENARIO_NODE_LABEL_PATTERN,
  SCENARIO_PAUSE_HOLD_HEADROOM_MS,
  SCENARIO_DEFAULT_PAUSE_HOLD_MS,
  type ConditionEvaluability,
  type ScenarioCapability,
  type ScenarioConditionKind,
  type ScenarioOperationType,
} from './types';

// ---------------------------------------------------------------------------
// Condition definitions — evaluability of every KNOWN condition kind.
// 'planned' conditions are representable so authors get a precise structured
// error; validation rejects them so they are never pretended to be checkable.

export interface ConditionDefinition {
  kind: ScenarioConditionKind;
  evaluability: ConditionEvaluability;
  displayName: string;
  description: string;
  /** Only for 'planned' kinds: what to use instead today. */
  remediation?: string;
}

export const SCENARIO_CONDITION_DEFINITIONS: Record<
  ScenarioConditionKind,
  ConditionDefinition
> = {
  'rpc-reachable': {
    kind: 'rpc-reachable',
    evaluability: 'supported',
    displayName: 'RPC reachable',
    description: 'Node answers HTTP JSON-RPC (per-sample reachability from monitoring).',
  },
  'process-state': {
    kind: 'process-state',
    evaluability: 'supported',
    displayName: 'Process state',
    description: 'Engine process status (created/starting/running/stopping/stopped/crashed/stale).',
  },
  'health-state': {
    kind: 'health-state',
    evaluability: 'supported',
    displayName: 'Health state',
    description: 'Interpreted node health from the monitoring machine (T-2.4).',
  },
  peers: {
    kind: 'peers',
    evaluability: 'supported',
    displayName: 'Peer count',
    description: 'Observed connected-peer count (system_health / system_peers).',
  },
  syncing: {
    kind: 'syncing',
    evaluability: 'supported',
    displayName: 'Sync state',
    description: 'system_health isSyncing flag for the node.',
  },
  'chain-progress': {
    kind: 'chain-progress',
    evaluability: 'supported',
    displayName: 'Block production progress',
    description:
      'Best-head progression using the health machine stall detection (advancing vs stalled).',
  },
  'recovery-verified': {
    kind: 'recovery-verified',
    evaluability: 'supported',
    displayName: 'Recovery verified',
    description:
      'The most recent fault step on this node recorded a verified recovery claim (post-fault).',
  },
  'finality-progress': {
    kind: 'finality-progress',
    evaluability: 'planned',
    displayName: 'Finality progress (planned)',
    description:
      'Finalized-head progression. The monitor samples the finalized head each tick but does not track advancement, so this cannot be evaluated honestly yet.',
    remediation:
      'Use chain-progress (best head) or rpc-reachable today; finality-progress becomes evaluable once monitoring tracks finalized-head advancement.',
  },
  'runtime-event': {
    kind: 'runtime-event',
    evaluability: 'planned',
    displayName: 'Runtime event (planned)',
    description:
      'Chain runtime events (e.g. imOnline.SomeOffline) are Phase 5 incident-diagnostics work and are not observed by the engine yet.',
    remediation:
      'Use health-state or peers conditions today; runtime-event becomes evaluable with incident detection (Phase 5).',
  },
};

export const EVALUABLE_CONDITION_KINDS: readonly ScenarioConditionKind[] =
  SCENARIO_CONDITION_KINDS.filter(
    (k) => SCENARIO_CONDITION_DEFINITIONS[k].evaluability === 'supported',
  );

// ---------------------------------------------------------------------------
// Config schemas (strict: unknown fields are rejected — including anything
// secret-shaped by name, per FR-7)

const nodeLabel = z
  .string()
  .regex(SCENARIO_NODE_LABEL_PATTERN, `node label must match ${SCENARIO_NODE_LABEL_PATTERN}`);

export const pauseConfigSchema = z
  .object({
    node: nodeLabel,
    durationMs: z
      .number()
      .int()
      .min(0)
      .max(SCENARIO_MAX_PAUSE_HOLD_MS)
      .optional(),
  })
  .strict();

export const nodeTargetConfigSchema = z.object({ node: nodeLabel }).strict();

export type PauseConfig = z.infer<typeof pauseConfigSchema>;
export type NodeTargetConfig = z.infer<typeof nodeTargetConfigSchema>;

// ---------------------------------------------------------------------------
// Operation definitions

export type OperationSupportStatus = 'supported' | 'blocked' | 'planned';

export interface OperationDefinition {
  type: ScenarioOperationType;
  /** 'fault' = FailureInjector mechanism; 'lifecycle' = engine node lifecycle. */
  kind: 'fault' | 'lifecycle';
  displayName: string;
  description: string;
  /** Support status of the underlying engine mechanism TODAY. */
  status: OperationSupportStatus;
  /** Why it is blocked/planned (present when status !== 'supported'). */
  statusReason?: string;
  /** Concrete path to making it available (present when blocked). */
  statusUnblock?: string;
  /** Schema-validated operation config (strict object). */
  configSchema: z.ZodType;
  /** Config field names (for authoring UIs — no Zod over the wire). */
  configFields: string[];
  /** Capabilities the target must provide (checked at authoring + run time). */
  requiredCapabilities: ScenarioCapability[];
  safety: {
    /** DEC-008: only designated test networks (always enforced today). */
    designatedTestRequired: boolean;
    /** DEC-018: extra operator authorization needed beyond dry-run gates. */
    authorizationRequired: boolean;
    privileges: FaultPrivileges | 'none';
    reversible: boolean;
  };
  /** Step-timeout envelope (bounds are central; default is per-operation). */
  timeouts: { defaultMs: number; minMs: number; maxMs: number };
  /** True when the step timeout must also cover the configured hold (pause). */
  timeoutCoversHold: boolean;
  supportedPreconditions: ScenarioConditionKind[];
  supportedPostconditions: ScenarioConditionKind[];
  /** Provenance: derived from a registered injector adapter vs engine plan. */
  source: 'failure-injector' | 'engine';
  /** Mechanism description from the adapter (fault ops only). */
  mechanism?: string;
}

/** Pre/postconditions a fault/lifecycle step may be authored with today. */
const BASE_PRECONDITIONS: ScenarioConditionKind[] = [
  'rpc-reachable',
  'process-state',
  'health-state',
  'peers',
  'syncing',
  'chain-progress',
];
const BASE_POSTCONDITIONS: ScenarioConditionKind[] = [
  ...BASE_PRECONDITIONS,
  'recovery-verified',
];

const FAULT_DISPLAY: Record<string, { displayName: string; description: string }> = {
  pause: {
    displayName: 'Pause node process',
    description:
      'SIGSTOP/SIGCONT pause of the managed process: RPC stops answering while the process stays alive; cleanup SIGCONTs and verifies recovery.',
  },
  terminate: {
    displayName: 'Terminate node process',
    description:
      'Engine stopNode (SIGTERM→SIGKILL) with restore via engine startNode on the same node identity; cleanup restarts and re-verifies the node.',
  },
  'peer-disconnect': {
    displayName: 'Disconnect peer',
    description:
      'Remove a reservation-bound peer connection (system_removeReservedPeer on a --reserved-only target).',
  },
  partition: {
    displayName: 'Network partition',
    description:
      'Controlled topology rewiring (unprivileged) or authorized kernel-level isolation (privileged).',
  },
};

const FAULT_CAPABILITIES: Record<string, ScenarioCapability[]> = {
  pause: [...BASE_SCENARIO_CAPABILITIES],
  terminate: [...BASE_SCENARIO_CAPABILITIES],
  'peer-disconnect': [...BASE_SCENARIO_CAPABILITIES, 'reserved-only-topology'],
  partition: [...BASE_SCENARIO_CAPABILITIES, 'reserved-only-topology'],
};

/** Per-operation default step budget (min/max are the central bounds). */
const FAULT_STEP_DEFAULTS: Record<string, number> = {
  pause: 120_000,
  terminate: 300_000,
  'peer-disconnect': 120_000,
  partition: 300_000,
};

/** Planned, non-fault operations (never implied to be implemented). */
const PLANNED_OPERATIONS: OperationDefinition[] = [
  {
    type: 'node-restart',
    kind: 'lifecycle',
    displayName: 'Restart node process',
    description:
      'Graceful stop + start of one node as a first-class step, with its own verification envelope.',
    status: 'planned',
    statusReason:
      'Engine stop/start primitives exist (NetworkService.stopNode/startNode, also used for terminate restore), but a scenario-level restart operation with a defined verification envelope is not implemented. Planned with scenario execution/recovery work (T-3.4, T-4.4).',
    configSchema: nodeTargetConfigSchema,
    configFields: ['node'],
    requiredCapabilities: [...BASE_SCENARIO_CAPABILITIES],
    safety: {
      designatedTestRequired: true,
      authorizationRequired: false,
      privileges: 'none',
      reversible: true,
    },
    timeouts: { defaultMs: 300_000, minMs: SCENARIO_MIN_STEP_TIMEOUT_MS, maxMs: SCENARIO_MAX_STEP_TIMEOUT_MS },
    timeoutCoversHold: false,
    supportedPreconditions: [...BASE_PRECONDITIONS],
    supportedPostconditions: [...BASE_POSTCONDITIONS],
    source: 'engine',
  },
];

/** Serializable operation definition for API/CLI clients (no Zod over the wire). */
export interface SerializedOperationDefinition {
  type: ScenarioOperationType;
  kind: 'fault' | 'lifecycle';
  displayName: string;
  description: string;
  status: OperationSupportStatus;
  statusReason?: string;
  statusUnblock?: string;
  configFields: string[];
  requiredCapabilities: ScenarioCapability[];
  safety: OperationDefinition['safety'];
  timeouts: OperationDefinition['timeouts'];
  timeoutCoversHold: boolean;
  supportedPreconditions: ScenarioConditionKind[];
  supportedPostconditions: ScenarioConditionKind[];
  source: OperationDefinition['source'];
  mechanism?: string;
}

export function serializeOperationDefinition(
  def: OperationDefinition,
): SerializedOperationDefinition {
  const out: SerializedOperationDefinition = {
    type: def.type,
    kind: def.kind,
    displayName: def.displayName,
    description: def.description,
    status: def.status,
    configFields: def.configFields,
    requiredCapabilities: def.requiredCapabilities,
    safety: def.safety,
    timeouts: def.timeouts,
    timeoutCoversHold: def.timeoutCoversHold,
    supportedPreconditions: def.supportedPreconditions,
    supportedPostconditions: def.supportedPostconditions,
    source: def.source,
  };
  if (def.statusReason !== undefined) out.statusReason = def.statusReason;
  if (def.statusUnblock !== undefined) out.statusUnblock = def.statusUnblock;
  if (def.mechanism !== undefined) out.mechanism = def.mechanism;
  return out;
}

// ---------------------------------------------------------------------------
// Registry

export interface ScenarioOperationRegistry {
  get(type: string): OperationDefinition | undefined;
  has(type: string): boolean;
  /** Deterministic order: injector registration order, then planned ops. */
  all(): OperationDefinition[];
  types(): ScenarioOperationType[];
}

/**
 * Build the registry from the injector's ACTUAL registered mechanisms.
 * Blocked mechanisms stay 'blocked' (mirroring their adapters' static
 * support) and must never be shown as executable.
 */
export function buildOperationRegistry(
  mechanisms: FaultMechanismInfo[],
): ScenarioOperationRegistry {
  const defs: OperationDefinition[] = mechanisms.map((m) => {
    const display = FAULT_DISPLAY[m.type] ?? {
      displayName: m.type,
      description: m.mechanism,
    };
    const isPause = m.type === 'pause';
    const def: OperationDefinition = {
      type: m.type,
      kind: 'fault',
      displayName: display.displayName,
      description: display.description,
      status: m.support.status,
      configSchema: isPause ? pauseConfigSchema : nodeTargetConfigSchema,
      configFields: isPause ? ['node', 'durationMs'] : ['node'],
      requiredCapabilities: FAULT_CAPABILITIES[m.type] ?? [...BASE_SCENARIO_CAPABILITIES],
      safety: {
        designatedTestRequired: true,
        // DEC-018: privileged mechanisms need explicit operator authorization.
        authorizationRequired: m.privileges === 'privileged-sudo',
        privileges: m.privileges,
        reversible: m.reversible,
      },
      timeouts: {
        defaultMs: FAULT_STEP_DEFAULTS[m.type] ?? 120_000,
        minMs: SCENARIO_MIN_STEP_TIMEOUT_MS,
        maxMs: SCENARIO_MAX_STEP_TIMEOUT_MS,
      },
      timeoutCoversHold: isPause,
      supportedPreconditions: [...BASE_PRECONDITIONS],
      supportedPostconditions: [...BASE_POSTCONDITIONS],
      source: 'failure-injector',
      mechanism: m.mechanism,
    };
    if (m.support.status === 'blocked') {
      def.statusReason = m.support.reason;
      def.statusUnblock = m.support.unblock;
    }
    return def;
  });

  for (const planned of PLANNED_OPERATIONS) defs.push(planned);

  const byType = new Map<string, OperationDefinition>(defs.map((d) => [d.type, d]));
  return {
    get: (type) => byType.get(type),
    has: (type) => byType.has(type),
    all: () => [...defs],
    types: () => defs.map((d) => d.type),
  };
}

/** Default pause hold used when a pause step omits durationMs. */
export const PAUSE_DEFAULT_HOLD_MS = SCENARIO_DEFAULT_PAUSE_HOLD_MS;
/** Hold → step-timeout headroom (cleanup + recovery verification budget). */
export const PAUSE_TIMEOUT_HEADROOM_MS = SCENARIO_PAUSE_HOLD_HEADROOM_MS;
