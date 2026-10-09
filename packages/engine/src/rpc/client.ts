/**
 * PortaldotRpcClient — typed WebSocket RPC access to a live node.
 *
 * Built on @polkadot/api (DEC-001). Verified against the real legacy Portaldot
 * node (metadata V13, spec 1002): ApiPromise connects, JSON-RPC reads work,
 * head subscriptions deliver, and raw provider.send covers methods outside the
 * typed definitions (e.g. system_localPeerId). See R-06/R-07 evidence.
 *
 * Rules: never fabricate values. If a read fails, the snapshot carries a
 * warning or the call rejects with a structured error.
 */

import { ApiPromise, WsProvider } from '@polkadot/api';
import { KaizenError } from '../errors';
import type { RpcPeerInfo, RpcSnapshot } from '../types';

export interface RpcClientOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const DEFAULTS = {
  connectTimeoutMs: 15_000,
  requestTimeoutMs: 10_000,
};

export class PortaldotRpcClient {
  private api: ApiPromise | null = null;
  /** Kept directly: `api.provider` is undefined on @polkadot/api v17. */
  private provider: WsProvider | null = null;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(
    readonly wsUrl: string,
    options: RpcClientOptions = {},
  ) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
  }

  get isConnected(): boolean {
    return this.api !== null && this.api.isConnected;
  }

  async connect(): Promise<void> {
    if (this.api?.isConnected) return;
    // Auto-connect is REQUIRED: `new WsProvider(url, false)` never initiates
    // the handshake and ApiPromise.create() then hangs (observed live).
    // The numeric arg is the retry delay between reconnect attempts.
    const provider = new WsProvider(this.wsUrl, 2_000);
    this.provider = provider;
    try {
      this.api = await withTimeout(
        ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true }),
        this.connectTimeoutMs,
        `connect to ${this.wsUrl}`,
      );
    } catch (e) {
      try { provider.disconnect(); } catch { /* best effort */ }
      this.provider = null;
      throw new KaizenError(
        'RPC_CONNECTION_FAILED',
        `Cannot connect to Portaldot node at ${this.wsUrl}: ${messageOf(e)}`,
        { wsUrl: this.wsUrl },
      );
    }
  }

  private requireApi(): ApiPromise {
    if (!this.api) {
      throw new KaizenError(
        'RPC_CONNECTION_FAILED',
        `RPC client for ${this.wsUrl} is not connected; call connect() first`,
      );
    }
    return this.api;
  }

  /**
   * Read a full operational snapshot. Chain/name/version/health/sync/head/
   * runtime are required reads; peers and localPeerId are best-effort (they
   * are unsafe-flagged RPC methods that may be disabled externally).
   */
  async getSnapshot(): Promise<RpcSnapshot> {
    const api = this.requireApi();
    const warnings: string[] = [];

    const [chain, nodeName, nodeVersion, health, sync, header, runtime] =
      await withTimeout(
        Promise.all([
          api.rpc.system.chain(),
          api.rpc.system.name(),
          api.rpc.system.version(),
          api.rpc.system.health(),
          api.rpc.system.syncState(),
          api.rpc.chain.getHeader(),
          api.rpc.state.getRuntimeVersion(),
        ]),
        this.requestTimeoutMs,
        'read node snapshot',
      ).catch((e) => {
        if (e instanceof KaizenError) throw e;
        throw new KaizenError(
          'RPC_ERROR',
          `Snapshot read failed for ${this.wsUrl}: ${messageOf(e)}`,
          { wsUrl: this.wsUrl },
        );
      });

    let peers: RpcPeerInfo[] | null = null;
    try {
      const rawPeers = await withTimeout(
        api.rpc.system.peers(),
        this.requestTimeoutMs,
        'read peers',
      );
      const arr = rawPeers.toJSON();
      peers = (Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : []).map((p) => ({
        peerId: String(p['peerId'] ?? ''),
        bestHash: String(p['bestHash'] ?? ''),
        bestNumber: Number(p['bestNumber'] ?? 0),
        roles: String(p['roles'] ?? ''),
      }));
    } catch (e) {
      warnings.push(`peers unavailable: ${messageOf(e)}`);
    }

    let localPeerId: string | null = null;
    try {
      const raw = await withTimeout(
        this.rawSend('system_localPeerId', []),
        this.requestTimeoutMs,
        'read localPeerId',
      );
      localPeerId = String(raw);
    } catch (e) {
      warnings.push(`localPeerId unavailable: ${messageOf(e)}`);
    }

    let finalized: { number: number; hash: string } | null = null;
    try {
      const finalizedHash = await withTimeout(
        api.rpc.chain.getFinalizedHead(),
        this.requestTimeoutMs,
        'read finalized head',
      );
      const finalizedHeader = await withTimeout(
        api.rpc.chain.getHeader(finalizedHash),
        this.requestTimeoutMs,
        'read finalized header',
      );
      finalized = {
        number: finalizedHeader.number.toNumber(),
        hash: finalizedHeader.hash.toHex(),
      };
    } catch (e) {
      warnings.push(`finalized unavailable: ${messageOf(e)}`);
    }

    return {
      at: new Date().toISOString(),
      chain: chain.toString(),
      nodeName: nodeName.toString(),
      nodeVersion: nodeVersion.toString(),
      localPeerId,
      health: {
        isSyncing: health.isSyncing.valueOf(),
        peers: health.peers.toNumber(),
        shouldHavePeers: health.shouldHavePeers.valueOf(),
      },
      peers,
      sync: {
        startingBlock: sync.startingBlock.toNumber(),
        currentBlock: sync.currentBlock.toNumber(),
        highestBlock: sync.highestBlock.isSome ? sync.highestBlock.unwrap().toNumber() : null,
      },
      head: {
        number: header.number.toNumber(),
        hash: header.hash.toHex(),
        parentHash: header.parentHash.toHex(),
      },
      finalized,
      runtime: {
        specName: runtime.specName.toString(),
        specVersion: runtime.specVersion.toNumber(),
        implName: runtime.implName.toString(),
        transactionVersion: runtime.transactionVersion.toNumber(),
      },
      warnings,
    };
  }

  /** Subscribe to new block heads. Returns an unsubscribe function. */
  async subscribeHeads(
    onHead: (head: { number: number; hash: string }) => void,
  ): Promise<() => Promise<void>> {
    const api = this.requireApi();
    const unsub = await api.rpc.chain.subscribeNewHeads((header) => {
      onHead({ number: header.number.toNumber(), hash: header.hash.toHex() });
    });
    return async () => {
      try { await unsub(); } catch { /* already closed */ }
    };
  }

  private async rawSend(method: string, params: unknown[]): Promise<unknown> {
    if (!this.provider) {
      throw new KaizenError(
        'RPC_CONNECTION_FAILED',
        `RPC client for ${this.wsUrl} is not connected; call connect() first`,
      );
    }
    return this.provider.send(method, params);
  }

  async close(): Promise<void> {
    if (this.api) {
      try {
        await this.api.disconnect();
      } catch { /* best effort */ }
      this.api = null;
    }
    this.provider = null;
  }
}

/**
 * One-shot snapshot helper: connect, read, disconnect. Used by inspect flows
 * and integration tests where a persistent client is unnecessary.
 */
export async function readSnapshot(
  wsUrl: string,
  options: RpcClientOptions = {},
): Promise<RpcSnapshot> {
  const client = new PortaldotRpcClient(wsUrl, options);
  try {
    await client.connect();
    return await client.getSnapshot();
  } finally {
    await client.close();
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new KaizenError('RPC_TIMEOUT', `Timed out (${ms}ms) during: ${label}`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
