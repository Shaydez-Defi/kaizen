/**
 * Console-wide state (T-3.6B): the real network list, the operator's
 * selected network, its live detail (records + monitoring snapshot + fault
 * records), and the node drawer target.
 *
 * Sources of truth: REST for state, the shared WS stream for invalidation
 * (network.*, node.*, monitor.health, fault.*, operation.completed trigger a
 * refetch) plus a bounded poll of the monitoring snapshot while the network
 * runs. Nothing is simulated (DEC-009).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { ApiError, apiClient } from '../api/client';
import type { FaultRecord, NetworkMonitorSnapshot, NetworkRecord, NetworkWithCount, NodeRecord } from '../api/types';
import { buildVNet, type VNet } from '../lib/model';
import { useEventsContext } from './EventsContext';

const STORAGE_KEY = 'kaizen.selectedNetwork';
export const MONITOR_POLL_MS = 3_000;

interface ConsoleValue {
  networks: NetworkWithCount[];
  networksError: ApiError | null;
  networksLoaded: boolean;
  selectedId: string | null;
  select: (id: string | null) => void;
  network: NetworkRecord | null;
  nodes: NodeRecord[];
  snapshot: NetworkMonitorSnapshot | null;
  faults: FaultRecord[];
  vnet: VNet | null;
  detailError: ApiError | null;
  refresh: () => void;
  drawer: string | null;
  openNode: (id: string) => void;
  closeNode: () => void;
}

const Ctx = createContext<ConsoleValue | null>(null);

function readStored(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

const INVALIDATING = /^(network\.|node\.|fault\.|operation\.completed|monitor\.health|scenario-run\.finished)/;

export function ConsoleProvider({ children }: { children: ReactNode }): JSX.Element {
  const { events, generation } = useEventsContext();
  const [networks, setNetworks] = useState<NetworkWithCount[]>([]);
  const [networksError, setNetworksError] = useState<ApiError | null>(null);
  const [networksLoaded, setNetworksLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(readStored);
  const [network, setNetwork] = useState<NetworkRecord | null>(null);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [snapshot, setSnapshot] = useState<NetworkMonitorSnapshot | null>(null);
  const [faults, setFaults] = useState<FaultRecord[]>([]);
  const [detailError, setDetailError] = useState<ApiError | null>(null);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const lastSeq = useRef(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    setDrawer(null);
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
  }, []);

  // Network list.
  useEffect(() => {
    let alive = true;
    apiClient
      .listNetworks()
      .then((res) => {
        if (!alive) return;
        setNetworks(res.networks);
        setNetworksError(null);
        setNetworksLoaded(true);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setNetworksError(e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0));
        setNetworksLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [nonce, generation]);

  // Default selection: stored id if it still exists, else the first network.
  useEffect(() => {
    if (!networksLoaded) return;
    if (selectedId && networks.some((n) => n.id === selectedId)) return;
    const first = networks[0];
    if (first) select(first.id);
    else if (selectedId) select(null);
  }, [networks, networksLoaded, selectedId, select]);

  // Selected network detail.
  useEffect(() => {
    if (!selectedId) {
      setNetwork(null);
      setNodes([]);
      setSnapshot(null);
      setFaults([]);
      return;
    }
    let alive = true;
    Promise.all([
      apiClient.getNetwork(selectedId),
      apiClient.listFaults(selectedId).catch(() => ({ ok: false, faults: [] as FaultRecord[] })),
    ])
      .then(([detail, f]) => {
        if (!alive) return;
        setNetwork(detail.network);
        setNodes(detail.nodes);
        setFaults(f.faults);
        setDetailError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setDetailError(e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0));
      });
    return () => {
      alive = false;
    };
  }, [selectedId, nonce, generation]);

  // Monitoring snapshot: immediately, then bounded polling while it runs.
  const running = network?.status === 'running' || network?.status === 'degraded';
  useEffect(() => {
    if (!selectedId) return undefined;
    let alive = true;
    const pull = () =>
      apiClient
        .monitorSnapshot(selectedId)
        .then((res) => {
          if (alive) setSnapshot(res.snapshot);
        })
        .catch(() => {
          if (alive) setSnapshot(null);
        });
    void pull();
    if (!running) return () => {
      alive = false;
    };
    const t = setInterval(() => void pull(), MONITOR_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [selectedId, running, nonce]);

  // WS invalidation (lifecycle/fault/health transitions → refetch).
  useEffect(() => {
    const fresh = events.filter((e) => e.seq > lastSeq.current);
    if (!fresh.length) return;
    lastSeq.current = fresh[fresh.length - 1]!.seq;
    if (fresh.some((e) => INVALIDATING.test(e.name))) refresh();
  }, [events, refresh]);

  const vnet = useMemo(() => (network ? buildVNet(network, nodes, snapshot, faults) : null), [network, nodes, snapshot, faults]);

  const value = useMemo<ConsoleValue>(
    () => ({
      networks,
      networksError,
      networksLoaded,
      selectedId,
      select,
      network,
      nodes,
      snapshot,
      faults,
      vnet,
      detailError,
      refresh,
      drawer,
      openNode: (id: string) => setDrawer(id),
      closeNode: () => setDrawer(null),
    }),
    [networks, networksError, networksLoaded, selectedId, select, network, nodes, snapshot, faults, vnet, detailError, refresh, drawer],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConsole(): ConsoleValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useConsole must be used inside <ConsoleProvider>');
  return v;
}
