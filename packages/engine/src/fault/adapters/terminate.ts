/**
 * Terminate adapter — controlled node termination + restore through the
 * engine's own lifecycle (R-22 D).
 *
 * Phase 3A envelope (VERIFIED, `t31-d.log`): `stopNode` (SIGTERM→SIGKILL)
 * makes the process exit and the health machine read `unhealthy`
 * ("process is not running") — a signature distinct from pause's
 * `unavailable`; `startNode` restores with a NEW pid, peers reconnect in
 * <1s, and the chain resumes from preserved genesis/identity. Unprivileged
 * (engine path only — no direct signals, no external commands).
 *
 * The fault's removal IS the restore: a terminated node that was running
 * before the fault is restarted via the engine and independently verified
 * (new pid, process alive, RPC answering again).
 */

import { KaizenError } from '../../errors';
import { NodeProcessManager } from '../../process/manager';
import {
  DEFAULT_ADAPTER_TIMEOUTS,
  pollBounded,
  reachableProbe,
  unreachableProbe,
  type FaultAdapter,
  type FaultAdapterContext,
  type AdapterPreflight,
} from '../adapter';
import type {
  FaultApplyResult,
  FaultRemoveResult,
} from '../adapter';
import type {
  FaultCheck,
  FaultEffectObservation,
  FaultPlanStep,
  FaultRecoveryObservation,
} from '../types';

function targetAlive(ctx: FaultAdapterContext): boolean {
  const node = ctx.reloadNode();
  return ctx.processes.isRunning(node.id) || NodeProcessManager.isExternalPidAlive(node.pid);
}

export const terminateAdapter: FaultAdapter = {
  type: 'terminate',
  mechanism: 'engine stopNode (SIGTERM→SIGKILL) with restore via engine startNode (R-22 D)',
  support: { status: 'supported' },
  privileges: 'none',
  reversible: false, // the process is gone; removal RESTORES a new process
  expectedEffect:
    'process exits (pid dead) and RPC stops answering — health reads unhealthy "process is not running", distinct from a pause',
  cleanupDescription:
    'engine startNode on the same node id (identity/genesis preserved), then process-alive + RPC reachability re-verified with the new pid recorded',
  timeoutBehavior:
    'stop/start run inside the engine lifecycle with bounded effect (15s) and recovery (60s) polls; a node that does not come back is reported as cleanup-failed, never assumed healthy',
  failureBehavior:
    'if the restore cannot be confirmed (process not alive or RPC not answering), the fault is marked cleanup-failed, the target stays quarantined, and a high-severity event is emitted',
  timeouts: {
    ...DEFAULT_ADAPTER_TIMEOUTS,
    applyMs: 30_000,
    verifyEffectMs: 15_000,
    removeMs: 150_000,
    verifyRecoveryMs: 60_000,
  },

  async preflight(ctx): Promise<AdapterPreflight> {
    const checks: FaultCheck[] = [];
    const alive = targetAlive(ctx);
    checks.push({
      id: 'terminate.process-alive',
      ok: alive,
      detail: alive
        ? `node ${ctx.node.name} process is alive (pid ${ctx.node.pid}) — termination has a real target`
        : `node ${ctx.node.name} is not running (status=${ctx.node.status}) — there is nothing to terminate`,
    });
    const obs = await ctx.observer.observe(ctx.node);
    checks.push({
      id: 'terminate.rpc-baseline-reachable',
      ok: obs.rpcReachable,
      detail: obs.rpcReachable
        ? `baseline RPC reachable — the exit effect can be independently proven`
        : `baseline RPC unreachable (${obs.rpcError ?? 'no error'}) — termination could not be distinguished from an already-dead node`,
    });
    // The mechanism itself is supported; target eligibility is decided by the
    // checks above (a failing check blocks the request with FAULT_NOT_ALLOWED).
    return { supported: true, checks };
  },

  plan(ctx): FaultPlanStep[] {
    const t = this.timeouts;
    return [
      {
        phase: 'apply',
        description: `engine stopNode on ${ctx.node.name} (SIGTERM→SIGKILL)`,
        timeoutMs: t.applyMs,
      },
      {
        phase: 'verify-effect',
        description: 'confirm the process is gone AND RPC stops answering',
        timeoutMs: t.verifyEffectMs,
      },
      {
        phase: 'remove',
        description: 'engine startNode on the same node id (restore to pre-fault running state)',
        timeoutMs: t.removeMs,
      },
      {
        phase: 'verify-recovery',
        description: 'confirm a NEW pid is alive and RPC answers again',
        timeoutMs: t.verifyRecoveryMs,
      },
    ];
  },

  async apply(ctx): Promise<FaultApplyResult> {
    const before = ctx.reloadNode();
    const result = await ctx.networks.stopNode(before.id);
    if (!result.ok) {
      throw new KaizenError(
        'FAULT_NOT_ALLOWED',
        `engine stopNode refused for ${before.name} — termination not applied`,
        { nodeId: before.id },
      );
    }
    return {
      at: new Date().toISOString(),
      how: `engine stopNode returned ok for ${before.name} (was pid ${before.pid ?? 'unknown'})`,
    };
  },

  async verifyEffect(ctx): Promise<FaultEffectObservation> {
    const { result, attempts } = await pollBounded(
      async () => {
        const obs = await ctx.observer.observe(ctx.node);
        if (targetAlive(ctx)) {
          return { stop: false, observation: obs, detail: 'process still alive' };
        }
        return unreachableProbe(obs);
      },
      { timeoutMs: this.timeouts.verifyEffectMs, intervalMs: 400, isCancelled: ctx.isCancelled },
    );
    const observed = !targetAlive(ctx) && !result.observation.rpcReachable;
    return {
      observed,
      attempts,
      detail: observed
        ? 'process dead and rpc unreachable — termination effect observed'
        : `effect not established: ${result.detail}`,
      observation: result.observation,
      at: new Date().toISOString(),
    };
  },

  async remove(ctx): Promise<FaultRemoveResult> {
    const result = await ctx.networks.startNode(ctx.node.id);
    if (!result.ok) {
      throw new KaizenError(
        'FAULT_NOT_ALLOWED',
        `engine startNode refused for ${ctx.node.name} — restore not applied`,
        { nodeId: ctx.node.id },
      );
    }
    const after = ctx.reloadNode();
    return {
      at: new Date().toISOString(),
      how: `engine startNode returned ok for ${ctx.node.name} (new pid ${after.pid ?? 'unknown'})`,
    };
  },

  async verifyRecovery(ctx): Promise<FaultRecoveryObservation> {
    const { result, attempts } = await pollBounded(
      async () => {
        const obs = await ctx.observer.observe(ctx.node);
        if (!targetAlive(ctx)) {
          return { stop: false, observation: obs, detail: 'process not alive yet' };
        }
        return reachableProbe(obs);
      },
      { timeoutMs: this.timeouts.verifyRecoveryMs, intervalMs: 500, isCancelled: () => false },
    );
    const node = ctx.reloadNode();
    const verified = targetAlive(ctx) && result.observation.rpcReachable;
    return {
      verified,
      attempts,
      detail: verified
        ? `new pid ${node.pid} alive and rpc answers — recovery verified (${result.detail})`
        : `recovery NOT verified: ${result.detail}`,
      observation: result.observation,
      newPid: node.pid,
      at: new Date().toISOString(),
    };
  },
};
