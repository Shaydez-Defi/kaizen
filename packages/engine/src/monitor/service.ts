/**
 * MonitoringService (T-2.4) — periodic real-RPC sampling of every node in a
 * network, with a per-node health state machine and typed events.
 *
 * Guarantees:
 *  - ONE polling job per network; a slow tick never overlaps the next one
 *    (in-flight guard), timers are unref'd so they never hold a process open
 *  - jobs stop automatically when their network stops (bus-driven) and via
 *    stop()/stopAll()/close()
 *  - RPC failures are contained: per-node, per-method; a failing node never
 *    breaks the loop or its siblings
 *  - every number in a sample comes from real RPC or real process state
 */

import { EventBus, type KaizenEventMap } from '../events/bus';
import { KaizenError } from '../errors';
import { NodeProcessManager } from '../process/manager';
import type { StateStore } from '../state/store';
import type {
  NetworkMonitorSnapshot,
  NodeHealthReport,
  NodeMonitorSample,
  NodeRecord,
} from '../types';
import {
  evaluateNodeHealth,
  type HealthEvalOptions,
} from './health';
import { createHttpSampler, type NodeSampler } from './sampler';

export interface MonitoringServiceOptions {
  store: StateStore;
  processes: NodeProcessManager;
  events: EventBus;
  /** Polling cadence per network. Default 2000ms. */
  intervalMs?: number;
  sampler?: NodeSampler;
  health?: Partial<HealthEvalOptions>;
}

interface NodeWatchState {
  report: NodeHealthReport | undefined;
  prevHeadNumber: number | undefined;
  lastHeadAdvanceAt: number | undefined;
  lastPeerCount: number | undefined;
  lastSample: NodeMonitorSample | undefined;
}

interface Job {
  networkId: string;
  timer: NodeJS.Timeout;
  inFlight: boolean;
  nodes: Map<string, NodeWatchState>;
}

const DEFAULT_INTERVAL_MS = 2_000;

export class MonitoringService {
  private readonly store: StateStore;
  private readonly processes: NodeProcessManager;
  private readonly events: EventBus;
  private readonly intervalMs: number;
  private readonly sampler: NodeSampler;
  private readonly healthOptions: Partial<HealthEvalOptions>;
  private readonly jobs = new Map<string, Job>();
  private readonly latest = new Map<string, NetworkMonitorSnapshot>();
  private readonly unsubscribe: () => void;

  constructor(options: MonitoringServiceOptions) {
    this.store = options.store;
    this.processes = options.processes;
    this.events = options.events;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.sampler = options.sampler ?? createHttpSampler();
    this.healthOptions = options.health ?? {};

    // Auto lifecycle: monitor running networks, stop watching stopped ones.
    this.unsubscribe = this.events.subscribe((name, payload) => {
      const event = payload as KaizenEventMap[typeof name];
      if (name === 'network.status') {
        const p = event as KaizenEventMap['network.status'];
        if (p.status === 'running') this.start(p.networkId);
        else if (p.status === 'stopping' || p.status === 'stopped' || p.status === 'error') {
          this.stop(p.networkId);
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // Job control

  isRunning(networkId: string): boolean {
    return this.jobs.has(networkId);
  }

  /** Start polling a network. Idempotent; safe to call from event handlers. */
  start(networkId: string): void {
    if (this.jobs.has(networkId)) return;
    if (!this.store.tryGetNetwork(networkId)) return;
    const job: Job = {
      networkId,
      inFlight: false,
      nodes: new Map(),
      timer: setInterval(() => {
        void this.tick(job);
      }, this.intervalMs),
    };
    // Never keep the process alive just for monitoring (short-lived CLI).
    job.timer.unref?.();
    this.jobs.set(networkId, job);
  }

  /** Stop polling a network and drop its transient state. */
  stop(networkId: string): void {
    const job = this.jobs.get(networkId);
    if (!job) return;
    clearInterval(job.timer);
    this.jobs.delete(networkId);
    this.latest.delete(networkId);
  }

  stopAll(): void {
    for (const networkId of [...this.jobs.keys()]) this.stop(networkId);
    this.unsubscribe();
  }

  /** Last loop-produced snapshot (null when not monitoring). */
  getLatest(networkId: string): NetworkMonitorSnapshot | null {
    return this.latest.get(networkId) ?? null;
  }

  /**
   * On-demand snapshot: sample every node now, evaluate health against the
   * loop's stored reports, emit nothing. Used by CLI and the API when no
   * polling job is active (or to force a fresh read).
   */
  async snapshotNow(networkIdOrName: string): Promise<NetworkMonitorSnapshot> {
    const network = this.store.tryGetNetwork(networkIdOrName);
    if (!network) {
      throw new KaizenError('NETWORK_NOT_FOUND', `No network with id or name "${networkIdOrName}"`, {
        idOrName: networkIdOrName,
      });
    }
    const job = this.jobs.get(network.id);
    const nodes = this.store.listNodes(network.id);
    const now = Date.now();

    const samples: NodeMonitorSample[] = [];
    const health: NodeHealthReport[] = [];
    for (const node of nodes) {
      const state = job?.nodes.get(node.id);
      const sample = await this.sampleNode(node);
      samples.push(sample);
      const { report } = evaluateNodeHealth({
        nodeId: node.id,
        prev: state?.report,
        prevHeadNumber: state?.prevHeadNumber,
        lastHeadAdvanceAt: state?.lastHeadAdvanceAt,
        sample,
        processAlive: this.isProcessAlive(node),
        now,
        options: this.healthOptions,
      });
      health.push(report);
    }
    return {
      networkId: network.id,
      name: network.name,
      at: new Date(now).toISOString(),
      intervalMs: this.intervalMs,
      samples,
      health,
    };
  }

  // -------------------------------------------------------------------------
  // Polling

  private async tick(job: Job): Promise<void> {
    // Overlap prevention: skip the tick entirely if the previous one is still
    // sampling (e.g. a node is slow to answer).
    if (job.inFlight) return;
    job.inFlight = true;
    try {
      const network = this.store.tryGetNetwork(job.networkId);
      if (!network) {
        this.stop(job.networkId);
        return;
      }
      const nodes = this.store.listNodes(job.networkId);
      if (nodes.length === 0) return;
      const now = Date.now();

      const samples: NodeMonitorSample[] = [];
      const health: NodeHealthReport[] = [];

      for (const node of nodes) {
        const watch = this.watchState(job, node.id);
        const processAlive = this.isProcessAlive(node);
        const sample = await this.sampleNode(node);
        samples.push(sample);

        const evalOut = evaluateNodeHealth({
          nodeId: node.id,
          prev: watch.report,
          prevHeadNumber: watch.prevHeadNumber,
          lastHeadAdvanceAt: watch.lastHeadAdvanceAt,
          sample,
          processAlive,
          now,
          options: this.healthOptions,
        });

        // Health transition event.
        const from = watch.report?.state ?? 'unknown';
        if (from !== evalOut.report.state) {
          this.events.emit('monitor.health', {
            networkId: job.networkId,
            nodeId: node.id,
            name: node.name,
            from,
            to: evalOut.report.state,
            reasons: evalOut.report.reasons,
            at: sample.at,
          });
        }

        // Peer-count change event (only meaningful when observed).
        const peerCount = sample.peers?.count;
        if (peerCount !== undefined && watch.lastPeerCount !== undefined && peerCount !== watch.lastPeerCount) {
          this.events.emit('monitor.peers', {
            networkId: job.networkId,
            nodeId: node.id,
            name: node.name,
            from: watch.lastPeerCount,
            to: peerCount,
            expected: sample.peers?.expected ?? 0,
            at: sample.at,
          });
        }

        watch.report = evalOut.report;
        watch.prevHeadNumber = sample.head?.number ?? watch.prevHeadNumber;
        watch.lastHeadAdvanceAt = evalOut.lastHeadAdvanceAt;
        watch.lastPeerCount = peerCount ?? watch.lastPeerCount;
        watch.lastSample = sample;
        health.push(evalOut.report);
      }

      const snapshot: NetworkMonitorSnapshot = {
        networkId: job.networkId,
        name: network.name,
        at: new Date(now).toISOString(),
        intervalMs: this.intervalMs,
        samples,
        health,
      };
      this.latest.set(job.networkId, snapshot);
      this.events.emit('monitor.sample', {
        networkId: job.networkId,
        at: snapshot.at,
        snapshot,
      });
    } catch (e) {
      // The loop must survive anything: report and continue next tick.
      this.events.emit('monitor.error', {
        networkId: job.networkId,
        message: e instanceof Error ? e.message : String(e),
        at: new Date().toISOString(),
      });
    } finally {
      job.inFlight = false;
    }
  }

  private watchState(job: Job, nodeId: string): NodeWatchState {
    let state = job.nodes.get(nodeId);
    if (!state) {
      state = {
        report: undefined,
        prevHeadNumber: undefined,
        lastHeadAdvanceAt: undefined,
        lastPeerCount: undefined,
        lastSample: undefined,
      };
      job.nodes.set(nodeId, state);
    }
    return state;
  }

  private isProcessAlive(node: NodeRecord): boolean {
    return this.processes.isRunning(node.id) || NodeProcessManager.isExternalPidAlive(node.pid);
  }

  /** Sample one node; sampler failures become honest unreachable samples. */
  private async sampleNode(node: NodeRecord): Promise<NodeMonitorSample> {
    const alive = this.isProcessAlive(node);
    const status = alive ? ('running' as const) : node.status;
    let sample: NodeMonitorSample;
    try {
      const observation = await this.sampler(node);
      sample = {
        networkId: node.networkId,
        nodeId: node.id,
        name: node.name,
        at: observation.at,
        process: { status, pid: node.pid, startedAt: node.startedAt },
        rpc: observation.rpc,
        health: observation.health,
        peers: observation.peers
          ? { count: observation.peers.count, expected: node.expectedPeers ?? 0, list: observation.peers.list }
          : null,
        head: observation.head,
        finalized: observation.finalized,
        genesisHash: observation.genesisHash,
        sync: observation.sync,
        uptimeMs: node.startedAt ? Date.now() - Date.parse(node.startedAt) : null,
        warnings: observation.warnings,
      };
    } catch (e) {
      sample = {
        networkId: node.networkId,
        nodeId: node.id,
        name: node.name,
        at: new Date().toISOString(),
        process: { status, pid: node.pid, startedAt: node.startedAt },
        rpc: { reachable: false, error: e instanceof Error ? e.message : String(e) },
        health: null,
        peers: null,
        head: null,
        finalized: null,
        genesisHash: null,
        sync: null,
        uptimeMs: node.startedAt ? Date.now() - Date.parse(node.startedAt) : null,
        warnings: [],
      };
    }
    return sample;
  }
}
