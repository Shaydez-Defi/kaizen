/**
 * Condition evaluation (T-3.4, Phase 3D) — typed, bounded, evidence-first.
 *
 * Preconditions and postconditions are evaluated against INDEPENDENT
 * observations (direct RPC observer reads, the monitoring machine, fresh
 * store reads) — never against the injector's own bookkeeping, with one
 * deliberate exception: the `recovery-verified` condition, whose semantics
 * ARE "the most recent fault on this node recorded a verified recovery
 * claim" (the injector's claims are themselves backed by independent
 * observations, T-3.2).
 *
 * Every condition kind has documented, honest semantics:
 *  - rpc-reachable   observed HTTP JSON-RPC reachability (conclusive)
 *  - process-state   persisted engine status; a 'running' expectation also
 *                    requires the pid to be alive (a dead pid with a
 *                    'running' record never satisfies it)
 *  - health-state    interpreted health from the monitoring machine; when
 *                    monitoring has no report yet, one on-demand snapshot is
 *                    attempted — still nothing ⇒ inconclusive, never a guess
 *  - peers / syncing observed via system_health; a node whose RPC is down
 *                    makes these INCONCLUSIVE (we cannot observe them)
 *  - chain-progress  best-head observation: 'advancing' needs a head increase
 *                    within the bounded wait; 'stalled' needs a documented
 *                    no-advancement window — a window shorter than that can
 *                    only ever be inconclusive
 *  - recovery-verified the latest executed fault record's recovery claim
 *
 * Nothing here executes anything, and no evaluation fabricates data:
 * "unknown" is returned as `inconclusive` and surfaces as a failed
 * precondition (fail-closed) or an inconclusive postcondition (explicit
 * policy), never as true or false.
 */

import { isPidAlive } from '../process/manager';
import type { MonitoringService } from '../monitor/service';
import type { StateStore } from '../state/store';
import type { FaultObserver } from '../fault/observer';
import { observationDetail } from '../fault/adapter';
import type { NetworkRecord, NodeRecord } from '../types';
import type { ScenarioCondition } from './types';

/** Poll cadence for condition waits (bounded by condition/step budgets). */
export const SCENARIO_CONDITION_POLL_MS = 1_000;

/** Documented observation window for a 'stalled' verdict (chain-progress). */
export const SCENARIO_STALL_WINDOW_MS = 15_000;

export interface ConditionContext {
  store: StateStore;
  monitoring: MonitoringService;
  observer: FaultObserver;
  network: NetworkRecord;
  isCancelled(): boolean;
}

export interface ConditionAttempt {
  satisfied: boolean;
  /** Present when the condition could NOT be truthfully evaluated. */
  inconclusive?: string;
  /** Observed facts explaining the verdict (no assumptions). */
  detail: string;
}

export interface ConditionEvaluator {
  attempt(): Promise<ConditionAttempt>;
}

/** Resolve a topology label ('alice') to the managed node record. */
export function resolveNodeLabel(
  store: StateStore,
  network: NetworkRecord,
  label: string,
): NodeRecord | undefined {
  return store
    .listNodes(network.id)
    .find((n) => n.name === `${network.name}-${label}`);
}

export function createConditionEvaluator(
  cond: ScenarioCondition,
  ctx: ConditionContext,
): ConditionEvaluator {
  const node = resolveNodeLabel(ctx.store, ctx.network, cond.node);
  if (!node) {
    const detail = `node label "${cond.node}" does not resolve to a managed node in network ${ctx.network.name}`;
    return { attempt: async () => ({ satisfied: false, inconclusive: detail, detail }) };
  }
  switch (cond.kind) {
    case 'rpc-reachable':
      return simpleEvaluator(async () => {
        const obs = await ctx.observer.observe(node);
        return {
          satisfied: obs.rpcReachable === cond.expect,
          detail: `rpc-reachable=${obs.rpcReachable} (expect ${cond.expect}): ${observationDetail(obs)}`,
        };
      });

    case 'process-state':
      return simpleEvaluator(async () => {
        const fresh = ctx.store.tryGetNode(node.id) ?? node;
        const alive = typeof fresh.pid === 'number' && isPidAlive(fresh.pid);
        // A 'running' expectation literally means an engine-managed, alive
        // process — a stale 'running' record with a dead pid never satisfies it.
        const satisfied =
          cond.expect.includes(fresh.status) && (fresh.status !== 'running' || alive);
        const staleNote =
          fresh.status === 'running' && !alive
            ? ' (record says running but the pid is not alive — stale process record)'
            : '';
        return {
          satisfied,
          detail: `process status=${fresh.status}${fresh.pid !== undefined ? ` pid=${fresh.pid} alive=${alive}` : ''}${staleNote}; expect [${cond.expect.join(', ')}]`,
        };
      });

    case 'health-state':
      return simpleEvaluator(async () => {
        let snapshot = ctx.monitoring.getLatest(ctx.network.id);
        if (!snapshot) {
          try {
            snapshot = await ctx.monitoring.snapshotNow(ctx.network.id);
          } catch (e) {
            const detail = `monitoring has no report for ${node.name} and an on-demand snapshot failed: ${e instanceof Error ? e.message : String(e)}`;
            return { satisfied: false, inconclusive: detail, detail };
          }
        }
        const report = snapshot.health.find((h) => h.nodeId === node.id);
        if (!report) {
          const detail = `monitoring has no health report for ${node.name} (snapshot at ${snapshot.at})`;
          return { satisfied: false, inconclusive: detail, detail };
        }
        return {
          satisfied: cond.expect.includes(report.state),
          detail: `health=${report.state} (expect [${cond.expect.join(', ')}])${report.reasons.length > 0 ? ` — ${report.reasons.join('; ')}` : ''}`,
        };
      });

    case 'peers':
      return simpleEvaluator(async () => {
        const obs = await ctx.observer.observe(node);
        if (!obs.rpcReachable) {
          const detail = `peer count cannot be observed: RPC unreachable (${obs.rpcError ?? 'no error'})`;
          return { satisfied: false, inconclusive: detail, detail };
        }
        const peers = obs.health?.peers;
        if (peers === undefined) {
          const detail = 'peer count cannot be observed: system_health returned no peer count';
          return { satisfied: false, inconclusive: detail, detail };
        }
        const satisfied =
          cond.op === 'gte' ? peers >= cond.value : cond.op === 'lte' ? peers <= cond.value : peers === cond.value;
        return { satisfied, detail: `peers=${peers} (${cond.op} ${cond.value})` };
      });

    case 'syncing':
      return simpleEvaluator(async () => {
        const obs = await ctx.observer.observe(node);
        if (!obs.rpcReachable || obs.health === undefined) {
          const detail = `sync state cannot be observed: RPC unreachable or system_health unavailable (${obs.rpcError ?? 'no error'})`;
          return { satisfied: false, inconclusive: detail, detail };
        }
        return {
          satisfied: obs.health.isSyncing === cond.expect,
          detail: `isSyncing=${obs.health.isSyncing} (expect ${cond.expect})`,
        };
      });

    case 'chain-progress':
      return chainProgressEvaluator(cond, node, ctx);

    case 'recovery-verified':
      return simpleEvaluator(async () => {
        const latest = ctx.store
          .listFaults({ nodeId: node.id, limit: 20 })
          .find((f) => f.mode === 'execute');
        if (!latest) {
          return {
            satisfied: false,
            detail: 'no executed fault is recorded for this node — no verified recovery claim exists',
          };
        }
        const verified = latest.result?.claims.recoveryVerified === true;
        return {
          satisfied: verified,
          detail: `latest fault ${latest.id} (${latest.type}, state=${latest.state}) recoveryVerified=${verified}`,
        };
      });

    default:
      // finality-progress / runtime-event: validation refuses these at
      // authoring AND run time; the defensive fallback stays inconclusive.
      return simpleEvaluator(async () => {
        const detail = `condition kind "${String((cond as { kind: string }).kind)}" cannot be evaluated by this build`;
        return { satisfied: false, inconclusive: detail, detail };
      });
  }
}

function simpleEvaluator(run: () => Promise<ConditionAttempt>): ConditionEvaluator {
  return { attempt: run };
}

/**
 * Chain-progress with observation memory:
 *  - 'advancing' is satisfied when the observed head number INCREASES.
 *  - 'stalled' is satisfied only after an unchanged head across the
 *    documented window (SCENARIO_STALL_WINDOW_MS); when the available
 *    budget is shorter than the window, the honest verdict is inconclusive.
 */
function chainProgressEvaluator(
  cond: Extract<ScenarioCondition, { kind: 'chain-progress' }>,
  node: NodeRecord,
  ctx: ConditionContext,
): ConditionEvaluator {
  let lastHead: number | null = null;
  let windowStart: number | null = null;
  return {
    attempt: async () => {
      const obs = await ctx.observer.observe(node);
      if (!obs.rpcReachable) {
        lastHead = null;
        windowStart = null;
        const detail = `chain progress cannot be observed: RPC unreachable (${obs.rpcError ?? 'no error'})`;
        return { satisfied: false, inconclusive: detail, detail };
      }
      if (obs.head === undefined) {
        lastHead = null;
        windowStart = null;
        const detail = 'chain progress cannot be observed: chain_getHeader returned no head';
        return { satisfied: false, inconclusive: detail, detail };
      }
      const head = obs.head.number;
      if (cond.expect === 'advancing') {
        if (lastHead !== null && head > lastHead) {
          return { satisfied: true, detail: `head advanced #${lastHead} → #${head}` };
        }
        if (lastHead === null || head > lastHead) {
          lastHead = head;
        }
        return {
          satisfied: false,
          detail: `head=#${head}${lastHead !== null && lastHead !== head ? ` (previous #${lastHead})` : ''} — no advancement observed yet within the bounded wait`,
        };
      }
      // expect === 'stalled'
      if (lastHead === null || head !== lastHead) {
        lastHead = head;
        windowStart = Date.now();
        const detail = `head=#${head} — observing for a ${SCENARIO_STALL_WINDOW_MS}ms no-advancement window (stall not yet established)`;
        return { satisfied: false, inconclusive: detail, detail };
      }
      const elapsed = Date.now() - (windowStart ?? Date.now());
      if (elapsed >= SCENARIO_STALL_WINDOW_MS) {
        return {
          satisfied: true,
          detail: `head unchanged at #${head} for ${elapsed}ms (≥ ${SCENARIO_STALL_WINDOW_MS}ms window) — observed stall`,
        };
      }
      const detail = `head=#${head} unchanged for ${elapsed}ms of the ${SCENARIO_STALL_WINDOW_MS}ms stall window`;
      return { satisfied: false, inconclusive: detail, detail };
    },
  };
}
