/**
 * Engine factory — wires the shared services used by both the CLI and the API.
 *
 * Single wiring point (DEC-002): the CLI constructs an engine in-process, the
 * API constructs one and exposes it over REST/WS. Both use these exact
 * services; there is no duplicated operational logic.
 */

import path from 'node:path';
import { BinaryManager } from './binary/manager';
import { EventBus } from './events/bus';
import { NetworkService } from './network/service';
import { NodeProcessManager } from './process/manager';
import { PortAllocator } from './process/ports';
import { StateStore } from './state/store';

export const KAIZEN_VERSION = '0.1.0';

export interface EngineOptions {
  /**
   * Root of all Kaizen runtime state (SQLite db, downloaded binaries,
   * network dirs). Default: $KAIZEN_DATA_DIR or ./.kaizen
   */
  dataDir?: string;
  /**
   * Where the Portaldot binary cache lives. Default: <dataDir>/bin.
   * Tests (or multi-project setups) point several engines at one cache.
   */
  binaryCacheDir?: string;
  healthTimeoutMs?: number;
}

export interface KaizenEngine {
  dataDir: string;
  store: StateStore;
  binaries: BinaryManager;
  processes: NodeProcessManager;
  ports: PortAllocator;
  events: EventBus;
  networks: NetworkService;
  /** WS RPC url of a node in a network (by node id). */
  wsUrlForNode(nodeId: string): string;
  /** Release engine resources. Managed node processes are NOT killed —
   *  networks are long-running daemons (stop them explicitly). */
  close(): Promise<void>;
}

export function resolveDataDir(explicit?: string): string {
  return explicit ?? process.env['KAIZEN_DATA_DIR'] ?? path.join(process.cwd(), '.kaizen');
}

export function createEngine(options: EngineOptions = {}): KaizenEngine {
  const dataDir = resolveDataDir(options.dataDir);
  const store = new StateStore(path.join(dataDir, 'kaizen.db'));
  const binaries = new BinaryManager({
    cacheDir: options.binaryCacheDir ?? path.join(dataDir, 'bin'),
  });
  const events = new EventBus();
  const ports = new PortAllocator();
  const processes = new NodeProcessManager({
    onExit: (nodeId, info) => {
      // Crash detection: reflect unexpected exits in the store + events.
      try {
        const node = store.getNode(nodeId);
        store.updateNodeStatus(nodeId, 'crashed', null);
        events.emit('node.status', {
          networkId: node.networkId,
          nodeId,
          name: node.name,
          status: 'crashed',
          note: `unexpected exit (code=${info.code ?? 'null'}, signal=${info.signal ?? 'null'})`,
          at: new Date().toISOString(),
        });
        const network = store.getNetwork(node.networkId);
        if (network.status === 'running') {
          store.updateNetworkStatus(node.networkId, 'degraded');
          events.emit('network.status', {
            networkId: node.networkId,
            name: network.name,
            status: 'degraded',
            at: new Date().toISOString(),
          });
        }
      } catch {
        // store may be closed during shutdown; ignore
      }
    },
  });
  const networks = new NetworkService({
    store,
    binaries,
    processes,
    events,
    ports,
    dataDir,
    healthTimeoutMs: options.healthTimeoutMs,
  });

  return {
    dataDir,
    store,
    binaries,
    processes,
    ports,
    events,
    networks,
    wsUrlForNode(nodeId: string): string {
      const node = store.getNode(nodeId);
      return `ws://127.0.0.1:${node.ports.ws}`;
    },
    async close(): Promise<void> {
      store.close();
    },
  };
}
