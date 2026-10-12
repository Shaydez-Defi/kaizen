/**
 * FailureInjector — guarded fault operations against designated test
 * networks only (T-3.2, DEC-008/DEC-018).
 *
 * Safety model:
 *  - every request is gated on the target network being designatedTest with
 *    a local/development chain (DEC-008); the gate is re-evaluated with
 *    FRESH reads at execute time, not only when the request was created
 *  - targets must be engine-managed, running processes with a stable
 *    identity (pid + startedAt + kaizen-node.pid agreement) — a reused PID
 *    or ambiguous process is refused, never signalled
 *  - dry-run is the default surface; execute() is a separate explicit call
 *    that revalidates the whole boundary
 *  - one active fault per node; concurrent/duplicate faults are refused
 *  - unverified cleanup ⇒ cleanup-failed: the target is quarantined until
 *    reconcile() proves the effect is gone; a high-severity event is emitted
 *  - every state transition is asserted against the lifecycle machine,
 *    persisted to SQLite, and emitted as a typed event
 *  - evidence is structured observed facts (timestamps, pids, RPC reads) —
 *    never assumptions; claims are never collapsed into one success flag
 *
 * Mechanisms are the Phase 3A-verified ones only (R-22): pause (SIGSTOP/
 * SIGCONT) and terminate (engine stop/start). peer-disconnect and partition
 * are registered as explicit BLOCKED adapters — typed unsupported results
 * with precise unblock paths, never silent substitutions.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import {
  KaizenError,
  toErrorJson,
  type KaizenErrorCode,
  type KaizenErrorJson,
} from '../errors';
import type { EventBus } from '../events/bus';
import { pidFileFor, NodeProcessManager, isPidAlive } from '../process/manager';
import type { StateStore } from '../state/store';
import type { NetworkRecord, NodeRecord } from '../types';
import { pauseAdapter } from './adapters/pause';
import { terminateAdapter } from './adapters/terminate';
import { partitionAdapter, peerDisconnectAdapter } from './adapters/blocked';
import { sleep, type FaultAdapter, type FaultAdapterContext, type FaultNetworkOps } from './adapter';
import { assertTransition, canTransition } from './lifecycle';
import { createRpcObserver, type FaultObserver } from './observer';
import { redactDeep } from './redact';
import type {
  FaultCheck,
  FaultEvidence,
  FaultExecutionResult,
  FaultMode,
  FaultOutcome,
  FaultPlanStep,
  FaultPreflight,
  FaultRecord,
  FaultRequest,
  FaultRunClaims,
  FaultState,
  FaultType,
} from './types';

export interface FailureInjectorOptions {
  store: StateStore;
  events: EventBus;
  processes: NodeProcessManager;
  /** Engine network operations used by the terminate adapter. */
  networks: FaultNetworkOps;
  observer?: FaultObserver;
  /** Override/extend the adapter registry (tests inject fakes). */
  adapters?: FaultAdapter[];
  defaultHoldMs?: number;
  maxHoldMs?: number;
}

interface Validated {
  report: FaultPreflight;
  adapter: FaultAdapter;
  network: NetworkRecord;
  node: NodeRecord;
  holdMs: number;
}

interface ActiveFault {
  faultId: string;
  networkId: string;
  nodeId: string;
  nodeName: string;
  type: FaultType;
  cancelRequested: boolean;
  run: Promise<FaultExecutionResult>;
}

const DEFAULT_HOLD_MS = 10_000;
const MAX_HOLD_MS = 600_000;

export class FailureInjector {
  private readonly store: StateStore;
  private readonly events: EventBus;
  private readonly processes: NodeProcessManager;
  private readonly networks: FaultNetworkOps;
  private readonly observer: FaultObserver;
  private readonly adapters = new Map<FaultType, FaultAdapter>();
  private readonly defaultHoldMs: number;
  private readonly maxHoldMs: number;
  private readonly active = new Map<string, ActiveFault>();
  private closed = false;

  constructor(options: FailureInjectorOptions) {
    this.store = options.store;
    this.events = options.events;
    this.processes = options.processes;
    this.networks = options.networks;
    this.observer = options.observer ?? createRpcObserver();
    this.defaultHoldMs = options.defaultHoldMs ?? DEFAULT_HOLD_MS;
    this.maxHoldMs = options.maxHoldMs ?? MAX_HOLD_MS;
    for (const adapter of [
      pauseAdapter,
      terminateAdapter,
      peerDisconnectAdapter,
      partitionAdapter,
      ...(options.adapters ?? []),
    ]) {
      this.adapters.set(adapter.type, adapter);
    }
  }

  /** Fault types the injector knows about (implemented or explicitly blocked). */
  get supportedTypes(): FaultType[] {
    return [...this.adapters.keys()];
  }

  /** Currently active (executing/verifying/cleaning-up) faults in this process. */
  activeFaults(): Array<{ faultId: string; networkId: string; nodeId: string; type: FaultType; state: FaultState }> {
    return [...this.active.values()].map((a) => {
      const record = this.mustGet(a.faultId);
      return { faultId: a.faultId, networkId: a.networkId, nodeId: a.nodeId, type: a.type, state: record.state };
    });
  }

  // -------------------------------------------------------------------------
  // Queries

  get(faultId: string): FaultRecord {
    return redactDeep(this.mustGet(faultId));
  }

  private mustGet(faultId: string): FaultRecord {
    const record = this.store.tryGetFault(faultId);
    if (!record) {
      throw new KaizenError('FAULT_NOT_FOUND', `No fault ${faultId}`, { faultId });
    }
    return record;
  }

  list(filter: { networkId?: string; nodeId?: string; limit?: number } = {}): FaultRecord[] {
    return redactDeep(this.store.listFaults(filter));
  }

  // -------------------------------------------------------------------------
  // Preflight & dry-run

  /**
   * Read-only safety/capability report for a fault request. No side
   * effects, nothing persisted — the request surfaces themselves (dry-run,
   * execute) are what get recorded.
   */
  async preflight(request: FaultRequest): Promise<FaultPreflight> {
    const validated = await this.evaluate(request);
    return validated.report;
  }

  /**
   * Dry-run preview (the DEFAULT fault surface): full preflight + the plan
   * that execution WOULD run. Persisted with an auditable record; nothing is
   * applied to the target.
   */
  async dryRun(request: FaultRequest): Promise<{
    faultId: string;
    state: FaultState;
    preflight: FaultPreflight;
    plan: FaultPlanStep[];
    expectedEffect: string;
    cleanup: string;
    holdDurationMs: number;
  }> {
    const record = this.newRecord(request, 'dry-run');
    try {
      this.transition(record, 'validating');
      const validated = await this.evaluate(request);
      record.preflight = validated.report;
      record.holdDurationMs = validated.holdMs;
      if (!validated.report.ok) {
        record.error = {
          code: this.rejectionCode(validated.report),
          message: validated.report.blockingReasons.join('; ') || 'preflight rejected the request',
        };
        this.transition(record, 'rejected');
        this.finishRecord(record);
        return this.previewOf(record, validated);
      }
      const plan = validated.adapter.plan(this.buildCtx(validated, () => false));
      record.plan = plan;
      this.transition(record, 'ready');
      this.persist(record);
      return this.previewOf(record, validated);
    } catch (e) {
      this.failRecord(record, e);
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Execution

  /**
   * Execute an authorized fault. This is the separate explicit action after
   * dry-run: it revalidates the ENTIRE safety boundary with fresh reads
   * (designatedTest, chain, node ownership, running state, identity,
   * conflicts, quarantine) and only then applies the mechanism.
   *
   * Throws only for gate/conflict/resource rejections (persisted as a
   * rejected record first). An accepted request always resolves with a
   * structured result — verified, failed, or inconclusive — never a bare
   * success flag.
   */
  async execute(request: FaultRequest): Promise<FaultExecutionResult> {
    if (this.closed) {
      throw new KaizenError('FAULT_NOT_ALLOWED', 'FailureInjector is shut down');
    }
    const record = this.newRecord(request, 'execute');
    const opId = this.store.startOperation('fault.execute', undefined, request.nodeId);
    try {
      this.transition(record, 'validating');
      // Full revalidation with fresh reads (not the caller's preflight).
      const validated = await this.evaluate(request);
      record.preflight = validated.report;
      record.holdDurationMs = validated.holdMs;
      this.store.attachOperationToNetwork(opId, validated.report.networkId);
      if (!validated.report.ok) {
        const code = this.rejectionCode(validated.report);
        record.error = {
          code,
          message: validated.report.blockingReasons.join('; ') || 'preflight rejected the request',
        };
        this.transition(record, 'rejected');
        this.finishRecord(record);
        this.store.finishOperation(opId, {
          status: 'error',
          errorCode: code,
          errorMessage: record.error.message,
          detail: { faultId: record.id },
        });
        throw new KaizenError(
          code,
          `Fault refused for node ${validated.report.nodeName}: ${record.error.message}`,
          { faultId: record.id, blockingReasons: validated.report.blockingReasons },
        );
      }
      // Authoritative conflict gate: JS single-threaded — check + reserve in
      // one synchronous block so two executions can never interleave here.
      if (this.active.has(validated.node.id)) {
        const existing = this.active.get(validated.node.id)!;
        throw new KaizenError(
          'FAULT_CONFLICT',
          `Fault ${existing.faultId} (${existing.type}) is still active on node ${validated.node.id} — concurrent faults on one target are refused`,
          { faultId: record.id, activeFaultId: existing.faultId, nodeId: validated.node.id },
        );
      }
      return this.runFault(record, validated, opId);
    } catch (e) {
      if (record.state === 'validating') {
        // Resource/lookup failures (unknown network/node) — audit the rejection.
        this.failRecord(record, e);
        this.store.finishOperation(opId, {
          status: 'error',
          errorCode: isKaizenCode(e) ? e.code : 'INTERNAL',
          errorMessage: e instanceof Error ? e.message : String(e),
          detail: { faultId: record.id },
        });
      }
      throw e;
    }
  }

  private runFault(
    record: FaultRecord,
    validated: Validated,
    opId: number,
  ): Promise<FaultExecutionResult> {
    const run = this.executeSteps(record, validated, opId);
    const active: ActiveFault = {
      faultId: record.id,
      networkId: record.networkId,
      nodeId: record.nodeId,
      nodeName: record.nodeName,
      type: record.type,
      cancelRequested: false,
      run,
    };
    this.active.set(record.nodeId, active);
    return run;
  }

  private async executeSteps(
    record: FaultRecord,
    validated: Validated,
    opId: number,
  ): Promise<FaultExecutionResult> {
    const { adapter, network, node, holdMs } = validated;
    const ctx = this.buildCtx(validated, () => this.active.get(node.id)?.cancelRequested ?? false);
    const startedAt = Date.now();
    const evidence: FaultEvidence = {
      before: null,
      applied: null,
      effect: null,
      removed: null,
      recovery: null,
      notes: [],
    };
    const claims: FaultRunClaims = {
      applied: false,
      effectObserved: false,
      faultRemoved: false,
      recovered: false,
      recoveryVerified: false,
    };
    let cancelled = false;
    let cleanupFailed = false;
    let terminal: FaultState = 'failed';

    try {
      this.transition(record, 'ready');
      this.persist(record);

      evidence.before = await this.observer.observe(node);

      this.transition(record, 'executing');
      this.persist(record);
      evidence.applied = await withTimeout(
        adapter.apply(ctx),
        backstop(adapter.timeouts.applyMs),
        `${record.type}.apply`,
      );
      claims.applied = true;

      this.transition(record, 'verifying');
      this.persist(record);
      const effect = await withTimeout(
        adapter.verifyEffect(ctx),
        backstop(adapter.timeouts.verifyEffectMs),
        `${record.type}.verify-effect`,
      );
      evidence.effect = effect;
      claims.effectObserved = effect.observed;

      if (effect.observed && adapter.reversible && holdMs > 0) {
        const holdResult = await this.hold(record, holdMs);
        cancelled = holdResult === 'cancelled';
        if (cancelled) evidence.notes.push(`cancelled by request after ${Date.now() - startedAt}ms`);
      }

      this.transition(record, 'cleaning-up');
      this.persist(record);
      const removeResult = await withTimeout(
        adapter.remove(ctx),
        backstop(adapter.timeouts.removeMs),
        `${record.type}.remove`,
      );
      evidence.removed = removeResult;
      claims.faultRemoved = true;

      const recovery = await withTimeout(
        adapter.verifyRecovery(ctx),
        backstop(adapter.timeouts.verifyRecoveryMs),
        `${record.type}.verify-recovery`,
      );
      evidence.recovery = recovery;
      claims.recovered = recovery.verified;
      claims.recoveryVerified = recovery.verified;

      if (!recovery.verified) {
        cleanupFailed = true;
        terminal = 'cleanup-failed';
        evidence.notes.push(`cleanup unverified: ${recovery.detail}`);
      } else if (cancelled) {
        terminal = 'cancelled';
      } else if (effect.observed) {
        terminal = 'completed';
      } else {
        terminal = 'failed';
        evidence.notes.push('mechanism applied but the expected effect was never observed');
      }
    } catch (e) {
      const error: KaizenErrorJson = toErrorJson(e);
      record.error = error;
      evidence.notes.push(`step failed: ${error.code}: ${error.message}`);
      // Rollback: if the mechanism may be active, cleanup still runs.
      if (claims.applied && !claims.faultRemoved) {
        try {
          const removeResult = await withTimeout(
            adapter.remove(ctx),
            backstop(adapter.timeouts.removeMs),
            `${record.type}.remove (cleanup path)`,
          );
          evidence.removed = removeResult;
          claims.faultRemoved = true;
          const recovery = await withTimeout(
            adapter.verifyRecovery(ctx),
            backstop(adapter.timeouts.verifyRecoveryMs),
            `${record.type}.verify-recovery (cleanup path)`,
          );
          evidence.recovery = recovery;
          claims.recovered = recovery.verified;
          claims.recoveryVerified = recovery.verified;
        } catch (ce) {
          cleanupFailed = true;
          evidence.notes.push(
            `cleanup attempt failed: ${ce instanceof Error ? ce.message : String(ce)}`,
          );
        }
      }
      if (cleanupFailed || (claims.applied && !claims.recoveryVerified)) {
        terminal = 'cleanup-failed';
        cleanupFailed = true;
      } else {
        terminal = 'failed';
      }
    } finally {
      this.active.delete(node.id);
    }

    record.evidence = evidence;
    let outcome: FaultOutcome;
    if (terminal === 'completed') outcome = 'verified';
    else if (terminal === 'cleanup-failed' || terminal === 'cancelled') outcome = 'inconclusive';
    else outcome = 'failed';
    const result: FaultExecutionResult = {
      ok: terminal === 'completed',
      outcome,
      faultId: record.id,
      state: terminal,
      networkId: network.id,
      nodeId: node.id,
      type: record.type,
      claims,
      evidence,
      durationMs: Date.now() - startedAt,
      error: record.error,
    };
    record.result = result;

    // Terminal outcomes always belong to the cleanup phase — including error
    // paths that jumped here directly (e.g. apply failed before cleanup ran).
    if (record.state !== 'cleaning-up' && canTransition(record.state, 'cleaning-up')) {
      this.transition(record, 'cleaning-up');
    }

    if (terminal === 'cleanup-failed') {
      this.transition(record, 'cleanup-failed');
      this.finishRecord(record);
      const message = `Fault ${record.type} on ${node.name} (${node.id}) could not be confirmed cleaned up — target quarantined until reconcile`;
      this.events.emit('fault.cleanup-failed', {
        faultId: record.id,
        networkId: network.id,
        nodeId: node.id,
        nodeName: node.name,
        type: record.type,
        severity: 'high',
        message,
        at: new Date().toISOString(),
      });
      this.store.finishOperation(opId, {
        status: 'error',
        errorCode: 'FAULT_CLEANUP_UNVERIFIED',
        errorMessage: message,
        detail: { faultId: record.id, outcome, claims },
      });
    } else {
      this.transition(record, terminal);
      this.finishRecord(record);
      this.store.finishOperation(opId, {
        status: result.ok ? 'ok' : 'error',
        errorCode: result.ok ? undefined : 'FAULT_NOT_VERIFIED',
        errorMessage: result.ok ? undefined : evidence.notes.join('; ') || undefined,
        detail: { faultId: record.id, outcome, claims },
      });
    }
    return redactDeep(result);
  }

  // -------------------------------------------------------------------------
  // Cancellation & reconciliation

  /**
   * Cancel an in-flight fault (bounded hold or verification polls exit
   * promptly; cleanup still runs). A timeout or cancellation NEVER reports
   * success while a fault remains active: terminal state is `cancelled`
   * only after recovery is verified, otherwise `cleanup-failed`.
   */
  async cancel(faultId: string): Promise<FaultRecord> {
    const record = this.mustGet(faultId);
    const active = this.active.get(record.nodeId);
    if (active && active.faultId === faultId) {
      active.cancelRequested = true;
      await active.run;
      return this.get(faultId);
    }
    if (active) {
      throw new KaizenError(
        'FAULT_CONFLICT',
        `Node ${record.nodeId} has a different active fault (${active.faultId})`,
        { faultId, activeFaultId: active.faultId },
      );
    }
    if (record.state === 'ready') {
      this.transition(record, 'cancelled');
      this.finishRecord(record);
      return this.get(faultId);
    }
    throw new KaizenError(
      'FAULT_CONFLICT',
      `Fault ${faultId} is not cancellable (state=${record.state}); it is terminal or executing in another process`,
      { faultId, state: record.state },
    );
  }

  /**
   * Reconcile a cleanup-failed fault: re-check reality (process liveness +
   * RPC reachability) and release the quarantine only when the fault's
   * effect is provably gone. Never reconciles on assumption.
   */
  async reconcile(faultId: string): Promise<FaultRecord> {
    const record = this.mustGet(faultId);
    if (record.state !== 'cleanup-failed') {
      throw new KaizenError(
        'FAULT_CONFLICT',
        `Only cleanup-failed faults can be reconciled (fault ${faultId} is ${record.state})`,
        { faultId, state: record.state },
      );
    }
    const node = this.store.tryGetNode(record.nodeId);
    if (!node) {
      throw new KaizenError('NODE_NOT_FOUND', `Node ${record.nodeId} no longer exists`, {
        nodeId: record.nodeId,
      });
    }
    const alive = NodeProcessManager.isExternalPidAlive(node.pid);
    const obs = await this.observer.observe(node);
    const effectGone = !alive || obs.rpcReachable;
    if (!effectGone) {
      record.evidence = record.evidence ?? {
        before: null, applied: null, effect: null, removed: null, recovery: null, notes: [],
      };
      record.evidence.notes.push(
        `reconcile ${new Date().toISOString()}: process ${node.pid} is alive and RPC is still unreachable — the fault may still be active; quarantine kept`,
      );
      this.persist(record);
      return redactDeep(record);
    }
    record.reconciled = true;
    record.evidence = record.evidence ?? {
      before: null, applied: null, effect: null, removed: null, recovery: null, notes: [],
    };
    record.evidence.notes.push(
      `reconcile ${new Date().toISOString()}: effect provably gone (processAlive=${alive}, rpcReachable=${obs.rpcReachable}) — quarantine released`,
    );
    this.persist(record);
    return redactDeep(record);
  }

  /**
   * Engine shutdown: every in-flight fault is cancelled and rolled back;
   * a best-effort SIGCONT sweep guarantees no paused node outlives the
   * engine. Unconfirmed rollbacks are honestly marked cleanup-failed.
   */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const active of this.active.values()) active.cancelRequested = true;
    await Promise.allSettled([...this.active.values()].map((a) => a.run));
    // Belt-and-braces: no paused process may leak past the engine. SIGCONT is
    // a no-op on a running process, so non-terminal and cleanup-failed pause
    // records all get a best-effort resume sweep.
    for (const record of this.store.listFaults({ limit: 200 })) {
      if (record.type !== 'pause') continue;
      const inFlightPause =
        record.state === 'executing' || record.state === 'verifying' || record.state === 'cleaning-up';
      if (!inFlightPause && record.state !== 'cleanup-failed') continue;
      const node = this.store.tryGetNode(record.nodeId);
      if (!node?.pid || !isPidAlive(node.pid)) continue;
      try {
        process.kill(node.pid, 'SIGCONT');
      } catch {
        /* already gone */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals

  /**
   * Precise rejection code for a failed preflight: conflicting active fault
   * → FAULT_CONFLICT; blocked mechanism → FAULT_NOT_SUPPORTED; otherwise a
   * safety/capability gate refusal → FAULT_NOT_ALLOWED.
   */
  private rejectionCode(report: FaultPreflight): KaizenErrorCode {
    if (report.checks.some((c) => c.id === 'target.no-active-fault' && !c.ok)) {
      return 'FAULT_CONFLICT';
    }
    if (!report.supported) return 'FAULT_NOT_SUPPORTED';
    return 'FAULT_NOT_ALLOWED';
  }

  private newRecord(request: FaultRequest, mode: FaultMode): FaultRecord {
    const node = this.store.tryGetNode(request.nodeId);
    const network = this.store.tryGetNetwork(request.networkIdOrName);
    const now = new Date().toISOString();
    const record: FaultRecord = {
      id: `flt-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
      networkId: network?.id ?? request.networkIdOrName,
      nodeId: request.nodeId,
      nodeName: node?.name ?? request.nodeId,
      type: request.type,
      mode,
      state: 'requested',
      requestedBy: request.requestedBy ?? 'engine',
      requestedAt: now,
      updatedAt: now,
    };
    this.store.insertFault(record);
    return record;
  }

  private transition(record: FaultRecord, to: FaultState): void {
    const from = record.state;
    assertTransition(from, to);
    record.state = to;
    record.updatedAt = new Date().toISOString();
    this.persist(record);
    this.events.emit('fault.state', {
      faultId: record.id,
      networkId: record.networkId,
      nodeId: record.nodeId,
      nodeName: record.nodeName,
      type: record.type,
      from,
      to,
      at: record.updatedAt,
    });
  }

  private persist(record: FaultRecord): void {
    this.store.updateFault(record.id, {
      state: record.state,
      preflight: record.preflight,
      plan: record.plan,
      evidence: record.evidence,
      result: record.result,
      error: record.error,
      holdDurationMs: record.holdDurationMs,
      reconciled: record.reconciled,
      updatedAt: record.updatedAt,
    });
  }

  private finishRecord(record: FaultRecord): void {
    record.finishedAt = new Date().toISOString();
    record.updatedAt = record.finishedAt;
    this.persist(record);
  }

  private failRecord(record: FaultRecord, e: unknown): void {
    record.error = toErrorJson(e);
    // Legal only on the pre-execution path; the run path owns its own
    // terminal transitions. Route through the state machine for emits.
    if (record.state === 'requested') this.transition(record, 'validating');
    if (record.state === 'validating') this.transition(record, 'rejected');
    this.finishRecord(record);
  }

  private previewOf(record: FaultRecord, validated: Validated) {
    return {
      faultId: record.id,
      state: record.state,
      preflight: validated.report,
      plan: record.plan ?? validated.adapter.plan(this.buildCtx(validated, () => false)),
      expectedEffect: validated.adapter.expectedEffect,
      cleanup: validated.adapter.cleanupDescription,
      holdDurationMs: validated.holdMs,
    };
  }

  private resolveHold(request: FaultRequest): number {
    const adapter = this.adapters.get(request.type);
    if (!adapter) {
      throw new KaizenError(
        'FAULT_NOT_SUPPORTED',
        `Unknown fault type "${request.type}" — supported: ${this.supportedTypes.join(', ')}`,
        { type: request.type },
      );
    }
    if (!adapter.reversible) return 0;
    const requested = request.options?.durationMs;
    if (requested === undefined) return this.defaultHoldMs;
    if (!Number.isInteger(requested) || requested < 0 || requested > this.maxHoldMs) {
      throw new KaizenError(
        'INVALID_INPUT',
        `durationMs must be an integer between 0 and ${this.maxHoldMs} (got ${requested})`,
        { durationMs: requested, maxHoldMs: this.maxHoldMs },
      );
    }
    return requested;
  }

  /**
   * The full safety evaluation with fresh reads. Resource lookups throw
   * (typed not-found); every SAFETY/capability failure is reported as a
   * check so the caller sees the complete picture.
   */
  private async evaluate(request: FaultRequest): Promise<Validated> {
    const adapterType = request.type;
    const adapter = this.adapters.get(adapterType);
    if (!adapter) {
      throw new KaizenError(
        'FAULT_NOT_SUPPORTED',
        `Unknown fault type "${String(adapterType)}" — supported: ${this.supportedTypes.join(', ')}`,
        { type: String(adapterType) },
      );
    }
    const holdMs = this.resolveHold(request);

    const network = this.store.tryGetNetwork(request.networkIdOrName);
    if (!network) {
      throw new KaizenError('NETWORK_NOT_FOUND', `No network ${request.networkIdOrName}`, {
        idOrName: request.networkIdOrName,
      });
    }
    const node = this.store.tryGetNode(request.nodeId);
    if (!node) {
      throw new KaizenError('NODE_NOT_FOUND', `No node ${request.nodeId}`, {
        nodeId: request.nodeId,
      });
    }
    if (node.networkId !== network.id) {
      throw new KaizenError(
        'NODE_NOT_FOUND',
        `Node ${request.nodeId} belongs to network ${node.networkId}, not ${network.id}`,
        { nodeId: request.nodeId, networkId: network.id, actualNetworkId: node.networkId },
      );
    }

    const checks: FaultCheck[] = [];
    const blockingReasons: string[] = [];
    const push = (id: string, ok: boolean, detail: string): void => {
      checks.push({ id, ok, detail });
      if (!ok) blockingReasons.push(`${id}: ${detail}`);
    };

    // DEC-008 blast-radius gate — fail closed.
    push(
      'gate.designated-test',
      network.designatedTest === true,
      network.designatedTest === true
        ? `network ${network.name} is designatedTest`
        : `network ${network.name} is not a designated test network — failure injection is refused (DEC-008)`,
    );
    push(
      'gate.chain-local',
      network.chain === 'dev' || network.chain === 'local-spec',
      network.chain === 'dev' || network.chain === 'local-spec'
        ? `chain scope is local (${network.chain})`
        : `chain scope "${network.chain}" is not a local/development chain — refused (DEC-008)`,
    );

    // Managed-process identity — never a reused PID alone.
    const pid = node.pid;
    const running =
      node.status === 'running' && NodeProcessManager.isExternalPidAlive(pid);
    push(
      'target.engine-managed-running',
      running,
      running
        ? `node ${node.name} is engine-managed and running (pid ${pid})`
        : `node ${node.name} is not an engine-managed running process (status=${node.status}, pid=${pid ?? 'none'})`,
    );
    let pidFilePid: number | null = null;
    if (running && typeof pid === 'number') {
      const pidFile = pidFileFor(node.baseDir);
      if (fs.existsSync(pidFile)) {
        pidFilePid = Number(fs.readFileSync(pidFile, 'utf8').trim()) || null;
      }
      push(
        'target.identity-stable',
        pidFilePid === null || pidFilePid === pid,
        pidFilePid === null || pidFilePid === pid
          ? `pid ${pid} agrees with ${pidFile === undefined ? 'the process table' : 'kaizen-node.pid'}`
          : `ambiguous ownership: pid file names ${pidFilePid}, record says ${pid} — refused`,
      );
    }

    // Conflicts: one active fault per node; cleanup-failed targets stay
    // quarantined until reconcile proves the effect is gone.
    const activeOnNode = this.active.get(node.id);
    push(
      'target.no-active-fault',
      activeOnNode === undefined,
      activeOnNode === undefined
        ? `no active fault on ${node.name}`
        : `fault ${activeOnNode.faultId} (${activeOnNode.type}) is still active on ${node.name} — concurrent faults are refused`,
    );
    const quarantined = this.store
      .listFaults({ nodeId: node.id, limit: 50 })
      .find((f) => f.state === 'cleanup-failed' && f.reconciled !== true);
    push(
      'target.not-quarantined',
      quarantined === undefined,
      quarantined === undefined
        ? `${node.name} has no unresolved cleanup failure`
        : `fault ${quarantined.id} on ${node.name} ended cleanup-failed and is quarantined until reconcile()`,
    );

    const ctx = this.buildCtx({ adapter, network, node, holdMs }, () => false);
    const adapterPreflight = await adapter.preflight(ctx);
    for (const check of adapterPreflight.checks) {
      checks.push(check);
      if (!check.ok) blockingReasons.push(`${check.id}: ${check.detail}`);
    }
    if (!adapterPreflight.supported) {
      blockingReasons.push(
        adapterPreflight.reason ?? `${adapter.type} is not supported for this target`,
      );
    }

    const report: FaultPreflight = {
      networkId: network.id,
      networkName: network.name,
      nodeId: node.id,
      nodeName: node.name,
      type: adapterType,
      ok: blockingReasons.length === 0,
      supported: adapterPreflight.supported,
      checks,
      blockingReasons,
      unblock: adapterPreflight.unblock,
      target: {
        designatedTest: network.designatedTest,
        chain: network.chain,
        networkStatus: network.status,
        nodeStatus: node.status,
        identity: running && typeof pid === 'number' ? { pid, startedAt: node.startedAt, pidFilePid } : null,
        processAlive: NodeProcessManager.isExternalPidAlive(pid),
      },
      checkedAt: new Date().toISOString(),
    };
    return { report, adapter, network, node, holdMs };
  }

  private buildCtx(validated: Pick<Validated, 'adapter' | 'network' | 'node' | 'holdMs'>, isCancelled: () => boolean): FaultAdapterContext {
    const { network, node, holdMs } = validated;
    return {
      network,
      node,
      reloadNode: () => {
        const fresh = this.store.tryGetNode(node.id);
        if (!fresh) {
          throw new KaizenError('NODE_NOT_FOUND', `Node ${node.id} no longer exists`, {
            nodeId: node.id,
          });
        }
        return fresh;
      },
      observer: this.observer,
      processes: this.processes,
      networks: this.networks,
      holdMs,
      isCancelled,
    };
  }

  private async hold(record: FaultRecord, holdMs: number): Promise<'completed' | 'cancelled'> {
    const deadline = Date.now() + holdMs;
    while (Date.now() < deadline) {
      const active = this.active.get(record.nodeId);
      if (active?.cancelRequested) return 'cancelled';
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    }
    return this.active.get(record.nodeId)?.cancelRequested ? 'cancelled' : 'completed';
  }
}

/**
 * Safety-net budget: each adapter bounds its own steps; the wrap only catches
 * hung adapters, so it always sits ABOVE the adapter's declared bound.
 */
function backstop(ms: number): number {
  return ms + 3_000;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new KaizenError('OPERATION_TIMEOUT', `${label} exceeded ${ms}ms`, { label, ms })),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isKaizenCode(e: unknown): e is KaizenError {
  return e instanceof KaizenError;
}
