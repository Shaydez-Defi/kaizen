/**
 * Pure view-model derivation for the console (T-3.6B).
 *
 * Turns REAL API records (network + node records, the monitoring snapshot,
 * fault records) into what the topology/cards render. Nothing here invents
 * a value: an unobserved number stays `null` and renders as "—".
 *
 * Links: the engine wires every network as a full mesh (expectedPeers =
 * n−1), so the drawn edges are the EXPECTED mesh; each edge's state is what
 * monitoring OBSERVED — via `system_peers` peer ids when the node's peer id
 * is known from bootnode multiaddrs, otherwise via both endpoints reporting
 * reachable RPC with ≥1 peer (labelled `inferred`).
 */

import type {
  FaultRecord,
  NetworkMonitorSnapshot,
  NetworkRecord,
  NodeHealthReport,
  NodeMonitorSample,
  NodeRecord,
} from '../api/types';

export type VisualState = 'running' | 'offline' | 'recovering' | 'paused';

export interface VNode {
  id: string;
  index: number;
  /** Scenario label (node name without the "<network>-" prefix). */
  label: string;
  name: string;
  role: 'Validator' | 'Full node';
  state: VisualState;
  stateLabel: string;
  height: number | null;
  finalized: number | null;
  peers: number | null;
  expectedPeers: number;
  health: NodeHealthReport | null;
  sample: NodeMonitorSample | null;
  record: NodeRecord;
  /** libp2p peer id when derivable from other nodes' bootnode multiaddrs. */
  peerId: string | null;
  activeFault: FaultRecord | null;
}

export interface VEdge {
  a: string;
  b: string;
  alive: boolean;
  /** observed = confirmed via system_peers ids; inferred = from reachability. */
  basis: 'observed' | 'inferred' | 'down';
}

export interface VNet {
  network: NetworkRecord;
  nodes: VNode[];
  edges: VEdge[];
}

export const ACTIVE_FAULT_STATES = new Set(['requested', 'validating', 'ready', 'executing', 'verifying', 'cleaning-up']);

export function nodeLabel(network: Pick<NetworkRecord, 'name'>, node: Pick<NodeRecord, 'name'>): string {
  const prefix = `${network.name}-`;
  return node.name.startsWith(prefix) ? node.name.slice(prefix.length) : node.name;
}

/** Map p2p port → peer id from all bootnode multiaddrs in the network. */
export function peerIdsFromBootnodes(nodes: NodeRecord[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const n of nodes) {
    for (const addr of n.bootnodes) {
      const m = /\/tcp\/(\d+)\/p2p\/([1-9A-HJ-NP-Za-km-z]+)/.exec(addr);
      if (m && m[1] && m[2]) out.set(Number(m[1]), m[2]);
    }
  }
  return out;
}

function visual(
  record: NodeRecord,
  sample: NodeMonitorSample | null,
  health: NodeHealthReport | null,
  fault: FaultRecord | null,
): { state: VisualState; label: string } {
  if (fault && fault.type === 'pause' && fault.state !== 'cleaning-up') return { state: 'paused', label: 'Paused' };
  if (fault && fault.type === 'terminate') return { state: 'offline', label: 'Terminated' };
  switch (record.status) {
    case 'created':
      return { state: 'offline', label: 'Not started' };
    case 'starting':
      return { state: 'recovering', label: 'Starting' };
    case 'stopping':
      return { state: 'recovering', label: 'Stopping' };
    case 'stopped':
      return { state: 'offline', label: 'Stopped' };
    case 'crashed':
      return { state: 'offline', label: 'Crashed' };
    case 'stale':
      return { state: 'offline', label: 'Stale' };
    default:
      break;
  }
  switch (health?.state) {
    case 'healthy':
      return sample?.health?.isSyncing ? { state: 'recovering', label: 'Syncing' } : { state: 'running', label: 'Synced' };
    case 'unhealthy':
      return { state: 'offline', label: 'Unhealthy' };
    case 'unavailable':
      return { state: 'offline', label: 'Unreachable' };
    case 'stale':
      return { state: 'recovering', label: 'Stale data' };
    default:
      return { state: 'recovering', label: 'Checking' };
  }
}

export function buildVNet(
  network: NetworkRecord,
  nodes: NodeRecord[],
  snapshot: NetworkMonitorSnapshot | null,
  faults: FaultRecord[] = [],
): VNet {
  const ids = peerIdsFromBootnodes(nodes);
  const vnodes: VNode[] = nodes.map((record, index) => {
    const sample = snapshot?.samples.find((s) => s.nodeId === record.id) ?? null;
    const health = snapshot?.health.find((h) => h.nodeId === record.id) ?? null;
    const activeFault = faults.find((f) => f.nodeId === record.id && f.mode === 'execute' && ACTIVE_FAULT_STATES.has(f.state)) ?? null;
    const v = visual(record, sample, health, activeFault);
    return {
      id: record.id,
      index,
      label: nodeLabel(network, record),
      name: record.name,
      role: record.role === 'validator' ? 'Validator' : 'Full node',
      state: v.state,
      stateLabel: v.label,
      height: sample?.head?.number ?? null,
      finalized: sample?.finalized?.number ?? null,
      peers: sample?.peers?.count ?? sample?.health?.peers ?? null,
      expectedPeers: record.expectedPeers ?? Math.max(0, nodes.length - 1),
      health,
      sample,
      record,
      peerId: ids.get(record.ports.p2p) ?? null,
      activeFault,
    };
  });
  const edges: VEdge[] = [];
  for (let i = 0; i < vnodes.length; i++) {
    for (let j = i + 1; j < vnodes.length; j++) {
      const A = vnodes[i]!;
      const B = vnodes[j]!;
      const up = (n: VNode) => n.state !== 'offline' && n.sample?.rpc.reachable === true;
      let basis: VEdge['basis'] = 'down';
      if (up(A) && up(B)) {
        const aSees = B.peerId ? A.sample?.peers?.list.some((p) => p.peerId === B.peerId) : undefined;
        const bSees = A.peerId ? B.sample?.peers?.list.some((p) => p.peerId === A.peerId) : undefined;
        if (aSees === true || bSees === true) basis = 'observed';
        else if (aSees === false || bSees === false) basis = 'down';
        else if ((A.peers ?? 0) > 0 && (B.peers ?? 0) > 0) basis = 'inferred';
      }
      edges.push({ a: A.id, b: B.id, alive: basis !== 'down', basis });
    }
  }
  return { network, nodes: vnodes, edges };
}

export function healthyCount(net: VNet): number {
  return net.nodes.filter((n) => n.state === 'running').length;
}

export function liveLinks(net: VNet): number {
  return net.edges.filter((e) => e.alive).length;
}

export function bestHeight(net: VNet): number | null {
  const hs = net.nodes.map((n) => n.height).filter((h): h is number => h !== null);
  return hs.length ? Math.max(...hs) : null;
}

export function finalizedHeight(net: VNet): number | null {
  const hs = net.nodes.map((n) => n.finalized).filter((h): h is number => h !== null);
  return hs.length ? Math.max(...hs) : null;
}

/** Network names must match the API regex ^[a-z0-9][a-z0-9_-]{0,31}$. */
export function slugifyNetworkName(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+/, '')
    .replace(/-+$/, '')
    .slice(0, 32);
  return s;
}

export function isValidNetworkName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name);
}

export function blockUrl(template: string | null | undefined, blockHash: string | null | undefined): string | null {
  if (!template || !blockHash || !template.includes('{block}')) return null;
  return template.replace('{block}', blockHash);
}

/** Planck (string) → human tokens with 4 decimals. */
export function formatTokens(planck: string | null | undefined, decimals: number | null | undefined, symbol?: string | null): string {
  if (planck === null || planck === undefined || decimals === null || decimals === undefined) return '—';
  const v = BigInt(planck);
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, '0').slice(0, 4);
  return `${(v / base).toString()}.${frac}${symbol ? ` ${symbol}` : ''}`;
}
