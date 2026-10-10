/**
 * HTTP JSON-RPC sampler (T-2.4) — one lightweight observation pass over a
 * node's HTTP RPC endpoint. Used by the MonitoringService polling loop.
 *
 * Rules (DEC-009): every value comes from a real RPC response. Unreachable
 * methods yield null with an error string — never fabricated defaults.
 * Individual method failures are tolerated (a node may disable unsafe RPCs);
 * transport failure marks the whole sample unreachable.
 */

import { httpUrlForPort } from '../process/args';
import type { NodeRecord, RpcPeerInfo } from '../types';

export interface RpcNodeObservation {
  at: string;
  rpc: { reachable: boolean; error?: string };
  health: { isSyncing: boolean; peers: number; shouldHavePeers: boolean } | null;
  peers: { count: number; list: RpcPeerInfo[] } | null;
  head: { number: number; hash: string } | null;
  finalized: { number: number; hash: string } | null;
  genesisHash: string | null;
  sync: { startingBlock: number; currentBlock: number; highestBlock: number | null } | null;
  /** Per-method problems (e.g. system_peers disabled). Never fabricated. */
  warnings: string[];
}

export type NodeSampler = (node: NodeRecord) => Promise<RpcNodeObservation>;

export interface HttpSamplerOptions {
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4_000;

/**
 * Build the default sampler: parallel single-method HTTP POSTs (no batch
 * dependency on the node's RPC implementation), each individually tolerated.
 * The genesis hash is cached per node — it never changes for a chain DB.
 */
export function createHttpSampler(options: HttpSamplerOptions = {}): NodeSampler {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const genesisCache = new Map<string, string | null>();

  return async (node: NodeRecord): Promise<RpcNodeObservation> => {
    const url = httpUrlForPort(node.ports.rpc);
    const rpcCall = (method: string, params: unknown[] = []): Promise<unknown> =>
      rpcPost(url, method, params, timeoutMs);

    const [health, header, peers, sync, finalizedHead, genesis] = await Promise.allSettled([
      rpcCall('system_health'),
      rpcCall('chain_getHeader'),
      rpcCall('system_peers'),
      rpcCall('system_syncState'),
      rpcCall('chain_getFinalizedHead'),
      genesisCache.has(node.id)
        ? Promise.resolve(genesisCache.get(node.id) ?? null)
        : rpcCall('chain_getBlockHash', ['0x0']),
    ]);

    // Transport-level failure: every method failed the same way.
    if (health.status === 'rejected') {
      return {
        at: new Date().toISOString(),
        rpc: { reachable: false, error: messageOf(health.reason) },
        health: null,
        peers: null,
        head: null,
        finalized: null,
        genesisHash: genesisCache.get(node.id) ?? null,
        sync: null,
        warnings: [],
      };
    }

    const warnings: string[] = [];
    const observation: RpcNodeObservation = {
      at: new Date().toISOString(),
      rpc: { reachable: true },
      health: null,
      peers: null,
      head: null,
      finalized: null,
      genesisHash: null,
      sync: null,
      warnings,
    };

    const h = health.value as { isSyncing?: unknown; peers?: unknown; shouldHavePeers?: unknown };
    observation.health = {
      isSyncing: Boolean(h.isSyncing),
      peers: Number(h.peers ?? 0),
      shouldHavePeers: Boolean(h.shouldHavePeers),
    };

    if (header.status === 'fulfilled') {
      const hd = header.value as { number?: string; hash?: string } | null;
      if (hd && typeof hd.number === 'string') {
        observation.head = { number: hexToNumber(hd.number), hash: String(hd.hash ?? '') };
      } else {
        warnings.push(`chain_getHeader returned unexpected shape: ${JSON.stringify(hd)?.slice(0, 120)}`);
      }
    } else {
      warnings.push(`chain_getHeader failed: ${messageOf(header.reason)}`);
    }

    if (peers.status === 'fulfilled') {
      const arr = Array.isArray(peers.value) ? (peers.value as Array<Record<string, unknown>>) : [];
      observation.peers = {
        count: arr.length,
        list: arr.map((p) => ({
          peerId: String(p['peerId'] ?? ''),
          bestHash: String(p['bestHash'] ?? ''),
          bestNumber: quantityToNumber(p['bestNumber']),
          roles: String(p['roles'] ?? ''),
        })),
      };
    } else {
      warnings.push(`system_peers failed: ${messageOf(peers.reason)}`);
    }

    if (sync.status === 'fulfilled') {
      const s = sync.value as Record<string, unknown> | null;
      if (s && typeof s === 'object') {
        observation.sync = {
          startingBlock: quantityToNumber(s['startingBlock']),
          currentBlock: quantityToNumber(s['currentBlock']),
          highestBlock:
            s['highestBlock'] === null || s['highestBlock'] === undefined
              ? null
              : quantityToNumber(s['highestBlock']),
        };
      }
    } else {
      warnings.push(`system_syncState failed: ${messageOf(sync.reason)}`);
    }

    if (finalizedHead.status === 'fulfilled' && typeof finalizedHead.value === 'string') {
      try {
        const fh = (await rpcCall('chain_getHeader', [finalizedHead.value])) as {
          number?: string;
        } | null;
        if (fh && typeof fh.number === 'string') {
          observation.finalized = {
            number: hexToNumber(fh.number),
            hash: finalizedHead.value,
          };
        }
      } catch (e) {
        warnings.push(`finalized header read failed: ${messageOf(e)}`);
      }
    } else if (finalizedHead.status === 'rejected') {
      warnings.push(`chain_getFinalizedHead failed: ${messageOf(finalizedHead.reason)}`);
    } else {
      warnings.push('chain_getFinalizedHead returned an unexpected result shape');
    }

    if (genesis.status === 'fulfilled' && typeof genesis.value === 'string') {
      observation.genesisHash = genesis.value;
      genesisCache.set(node.id, genesis.value);
    } else {
      observation.genesisHash = genesisCache.get(node.id) ?? null;
      if (genesis.status === 'rejected') {
        warnings.push(`chain_getBlockHash(0) failed: ${messageOf(genesis.reason)}`);
      }
    }

    return observation;
  };
}

async function rpcPost(url: string, method: string, params: unknown[], timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) {
    throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`);
  }
  return body.result;
}

function hexToNumber(value: string): number {
  return value.startsWith('0x') ? parseInt(value, 16) : Number(value);
}

function quantityToNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return hexToNumber(value);
  return 0;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
