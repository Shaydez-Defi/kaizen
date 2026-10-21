/**
 * Pause adapter — SIGSTOP/SIGCONT on the verified managed process (R-22 A).
 *
 * Phase 3A envelope (VERIFIED, `t31-a-full.log`): SIGSTOP on the
 * engine-managed node PID keeps the process alive while its RPC answers time
 * out (health reaches `unavailable`, never `unhealthy`); the libp2p
 * connection survives the pause; SIGCONT restores RPC in <3s with no
 * restart. Unprivileged (same-user signal to a PID we own and re-verify).
 *
 * Identity discipline: the signal is only ever sent to the pid captured at
 * validation time, re-verified immediately before the signal (alive + the
 * node's kaizen-node.pid file, when present, still names that pid) — a
 * reused PID or an ambiguous process is refused, never signalled.
 */

import fs from 'node:fs';
import { KaizenError } from '../../errors';
import { NodeProcessManager, pidFileFor } from '../../process/manager';
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

const PID_FILE_MISMATCH = 'pid-file-mismatch';

function verifiedPid(ctx: FaultAdapterContext): number {
  const node = ctx.reloadNode();
  const pid = node.pid;
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    throw new KaizenError('FAULT_NOT_ALLOWED', `Pause target ${node.id} has no usable pid`, {
      nodeId: node.id,
    });
  }
  const pidFile = pidFileFor(node.baseDir);
  if (fs.existsSync(pidFile)) {
    const filePid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (filePid !== pid) {
      throw new KaizenError(
        'FAULT_NOT_ALLOWED',
        `Pause target ${node.id} identity is ambiguous: pid file names ${filePid}, record says ${pid}`,
        { nodeId: node.id, pid, pidFilePid: filePid, reason: PID_FILE_MISMATCH },
      );
    }
  }
  return pid;
}

/**
 * Cross-process-safe liveness of the target node process.
 *
 * Nodes are daemons and CLI processes are short-lived (DEC-004): a pause
 * driven from a process that did NOT spawn the node must still verify the
 * target honestly. In-memory manager state is used when this process manages
 * the node; otherwise the persisted record must say 'running' with an alive
 * pid — the exact predicate the injector's `target.engine-managed-running`
 * gate and the rest of the codebase (network service, monitor, terminate
 * adapter) already use. Signalling identity stays STRICTER than this check:
 * `verifiedPid()` re-verifies the pid + kaizen-node.pid agreement immediately
 * before every signal.
 */
function nodeAlive(ctx: FaultAdapterContext): boolean {
  if (ctx.processes.isRunning(ctx.node.id)) return true;
  const fresh = ctx.reloadNode();
  return fresh.status === 'running' && NodeProcessManager.isExternalPidAlive(fresh.pid);
}

export const pauseAdapter: FaultAdapter = {
  type: 'pause',
  mechanism: 'SIGSTOP/SIGCONT on the verified managed node PID (R-22 A)',
  support: { status: 'supported' },
  privileges: 'none',
  reversible: true,
  expectedEffect:
    'process stays alive while node RPC stops answering (health would read unavailable, not unhealthy)',
  cleanupDescription: 'SIGCONT to the same verified PID, then RPC reachability re-verified',
  timeoutBehavior:
    'effect and recovery are bounded polls (15s each); a paused node that never answers RPC is reported, never waited on indefinitely',
  failureBehavior:
    'if SIGCONT cannot be confirmed to restore RPC, the fault is marked cleanup-failed, the target stays quarantined, and a high-severity event is emitted',
  timeouts: {
    ...DEFAULT_ADAPTER_TIMEOUTS,
    applyMs: 5_000,
    verifyEffectMs: 15_000,
    removeMs: 5_000,
    verifyRecoveryMs: 15_000,
  },

  async preflight(ctx): Promise<AdapterPreflight> {
    const checks: FaultCheck[] = [];
    const pid = ctx.node.pid;
    const alive = nodeAlive(ctx);
    checks.push({
      id: 'pause.process-managed-alive',
      ok: alive,
      detail: alive
        ? `node ${ctx.node.name} is running under the engine (pid ${pid})`
        : `node ${ctx.node.name} is not a running engine-managed process (status=${ctx.node.status})`,
    });
    const obs = await ctx.observer.observe(ctx.node);
    checks.push({
      id: 'pause.rpc-baseline-reachable',
      ok: obs.rpcReachable,
      detail: obs.rpcReachable
        ? `baseline RPC reachable (${obs.health?.peers ?? '?'} peers) — the effect can be independently proven`
        : `baseline RPC unreachable (${obs.rpcError ?? 'no error'}) — the pause effect could not be distinguished from an already-broken node`,
    });
    // The mechanism itself is supported; target eligibility is decided by the
    // checks above (a failing check blocks the request with FAULT_NOT_ALLOWED).
    return { supported: true, checks };
  },

  plan(ctx): FaultPlanStep[] {
    const t = this.timeouts;
    return [
      { phase: 'apply', description: `SIGSTOP the verified PID of ${ctx.node.name}`, timeoutMs: t.applyMs },
      {
        phase: 'verify-effect',
        description: 'poll until RPC is unreachable while the process is still alive',
        timeoutMs: t.verifyEffectMs,
      },
      { phase: 'hold', description: `hold the pause for ${ctx.holdMs}ms (cancellable)`, timeoutMs: ctx.holdMs },
      { phase: 'remove', description: 'SIGCONT the same verified PID', timeoutMs: t.removeMs },
      {
        phase: 'verify-recovery',
        description: 'poll until RPC answers again with the process still alive',
        timeoutMs: t.verifyRecoveryMs,
      },
    ];
  },

  async apply(ctx): Promise<FaultApplyResult> {
    const pid = verifiedPid(ctx);
    try {
      process.kill(pid, 'SIGSTOP');
    } catch (e) {
      throw new KaizenError(
        'FAULT_NOT_ALLOWED',
        `SIGSTOP failed for ${ctx.node.name} (pid ${pid}): ${e instanceof Error ? e.message : String(e)}`,
        { nodeId: ctx.node.id, pid },
      );
    }
    return { at: new Date().toISOString(), how: `SIGSTOP delivered to verified pid ${pid}` };
  },

  async verifyEffect(ctx): Promise<FaultEffectObservation> {
    const pid = ctx.node.pid!;
    const { result, attempts } = await pollBounded(
      async () => {
        const obs = await ctx.observer.observe(ctx.node);
        const processAlive = nodeAlive(ctx);
        if (!processAlive) {
          return {
            stop: true,
            observation: obs,
            detail: 'target process died during the pause — effect NOT as designed',
          };
        }
        return unreachableProbe(obs);
      },
      { timeoutMs: this.timeouts.verifyEffectMs, intervalMs: 400, isCancelled: ctx.isCancelled },
    );
    const processAlive = nodeAlive(ctx);
    const observed = !result.observation.rpcReachable && processAlive;
    return {
      observed,
      attempts,
      detail: observed
        ? `rpc unreachable while pid ${pid} is alive — pause effect observed`
        : `effect not established: ${result.detail}`,
      observation: result.observation,
      at: new Date().toISOString(),
    };
  },

  async remove(ctx): Promise<FaultRemoveResult> {
    const pid = verifiedPid(ctx);
    try {
      process.kill(pid, 'SIGCONT');
    } catch (e) {
      throw new KaizenError(
        'FAULT_NOT_ALLOWED',
        `SIGCONT failed for ${ctx.node.name} (pid ${pid}): ${e instanceof Error ? e.message : String(e)}`,
        { nodeId: ctx.node.id, pid },
      );
    }
    return { at: new Date().toISOString(), how: `SIGCONT delivered to verified pid ${pid}` };
  },

  async verifyRecovery(ctx): Promise<FaultRecoveryObservation> {
    const { result, attempts } = await pollBounded(
      async () => {
        const obs = await ctx.observer.observe(ctx.node);
        const processAlive = nodeAlive(ctx);
        if (!processAlive) {
          return {
            stop: true,
            observation: obs,
            detail: 'target process is not alive after SIGCONT',
          };
        }
        return reachableProbe(obs);
      },
      { timeoutMs: this.timeouts.verifyRecoveryMs, intervalMs: 400, isCancelled: () => false },
    );
    const verified = result.observation.rpcReachable && nodeAlive(ctx);
    return {
      verified,
      attempts,
      detail: verified
        ? `rpc answers again — recovery verified (${result.detail})`
        : `recovery NOT verified: ${result.detail}`,
      observation: result.observation,
      at: new Date().toISOString(),
    };
  },
};
