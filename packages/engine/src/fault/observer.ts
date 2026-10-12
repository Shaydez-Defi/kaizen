/**
 * FaultObserver — the injector's independent observation channel (T-3.2).
 *
 * Verification must never rely on the mechanism's own bookkeeping: "a signal
 * was sent" is not "the fault took effect" (T-3.1 evidence, R-22). The
 * observer answers, with bounded timeouts, the only questions that matter:
 * does the node's RPC answer, what does system_health say, where is the head.
 * Injected like the monitor's NodeSampler so unit tests can substitute it.
 */

import { httpUrlForPort } from '../process/args';
import type { NodeRecord } from '../types';
import type { FaultObservation } from './types';

export interface FaultObserver {
  observe(node: NodeRecord): Promise<FaultObservation>;
}

export interface RpcObserverOptions {
  /** Per-RPC bound. Default 3000ms — a paused node must fail fast, not hang. */
  rpcTimeoutMs?: number;
}

interface HealthResult {
  isSyncing: boolean;
  peers: number;
  shouldHavePeers: boolean;
}
interface HeaderResult {
  hash: string;
  number: string;
}

/** One bounded HTTP JSON-RPC call (argv-free, loopback-only by construction). */
async function rpcPost(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (body.error) {
    throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`);
  }
  return body.result;
}

/**
 * Default observer: real HTTP JSON-RPC against the node's loopback RPC port.
 * Reachability = system_health answered within the bound; head is a separate,
 * independently-tolerated read (a reachable node that fails chain_getHeader
 * is still reported reachable, with the head absent — never invented).
 */
export function createRpcObserver(options: RpcObserverOptions = {}): FaultObserver {
  const rpcTimeoutMs = options.rpcTimeoutMs ?? 3_000;
  return {
    async observe(node: NodeRecord): Promise<FaultObservation> {
      const url = httpUrlForPort(node.ports.rpc);
      const at = new Date().toISOString();
      try {
        const health = (await rpcPost(
          url,
          'system_health',
          [],
          rpcTimeoutMs,
        )) as HealthResult;
        const observation: FaultObservation = {
          at,
          rpcReachable: true,
          health: { peers: health.peers, isSyncing: health.isSyncing },
        };
        try {
          const header = (await rpcPost(
            url,
            'chain_getHeader',
            [],
            rpcTimeoutMs,
          )) as HeaderResult;
          const decimal = Number.parseInt(header.number, 16);
          observation.head = {
            hash: header.hash,
            number: Number.isFinite(decimal) ? decimal : 0,
          };
        } catch {
          // head read is best-effort; reachability was already established
        }
        return observation;
      } catch (e) {
        return {
          at,
          rpcReachable: false,
          rpcError: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}
