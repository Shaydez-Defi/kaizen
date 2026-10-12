/**
 * Overview: fleet-level picture from real API responses only.
 *
 * Counts are DERIVED from GET /api/networks and per-running-network monitor
 * snapshots — nothing here is hardcoded or simulated. A network without a
 * monitoring snapshot shows "not monitoring", never a guessed health.
 */

import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { useCallback, useMemo } from 'react';
import { apiClient } from '../api/client';
import type { KaizenApiClient } from '../api/client';
import type { NetworkMonitorSnapshot, NetworkWithCount } from '../api/types';
import { useAsync, useInterval } from '../state/useAsync';
import { useEventsContext } from '../state/EventsContext';
import { ErrorState, LoadingState, EmptyState } from '../components/States';
import { StatusBadge, HealthBadge } from '../components/StatusBadge';
import { formatAgo } from '../components/fmt';

export interface OverviewData {
  networks: NetworkWithCount[];
  /** Monitor snapshot per RUNNING network (keyed by network id). */
  monitors: Record<string, NetworkMonitorSnapshot>;
  /** When this combined load completed (display only). */
  loadedAt: string;
}

/** One combined load: the network list + monitor snapshots for running nets. */
export async function loadOverview(
  client: KaizenApiClient,
  signal: AbortSignal,
): Promise<OverviewData> {
  void signal; // list/monitor calls are short; abort is honored by fetch timeouts
  const { networks } = await client.listNetworks();
  const running = networks.filter((n) => n.status === 'running' || n.status === 'starting');
  const settled = await Promise.allSettled(
    running.map((n) => client.monitorSnapshot(n.id)),
  );
  const monitors: Record<string, NetworkMonitorSnapshot> = {};
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') monitors[running[i]!.id] = r.value.snapshot;
  });
  return { networks, monitors, loadedAt: new Date().toISOString() };
}

interface NetworkHealthRollup {
  network: NetworkWithCount;
  /** null when the network is not running (no monitoring expected). */
  rollup: { healthy: number; unhealthy: number; other: number } | null;
}

export function computeRollups(data: OverviewData): NetworkHealthRollup[] {
  return data.networks.map((network) => {
    const snapshot = data.monitors[network.id];
    if (!snapshot) return { network, rollup: null };
    let healthy = 0;
    let unhealthy = 0;
    let other = 0;
    for (const h of snapshot.health) {
      if (h.state === 'healthy') healthy += 1;
      else if (h.state === 'unhealthy' || h.state === 'unavailable') unhealthy += 1;
      else other += 1;
    }
    return { network, rollup: { healthy, unhealthy, other } };
  });
}

export function OverviewPage(): JSX.Element {
  const { events, status } = useEventsContext();
  const { data, error, loading, reload } = useAsync(
    (signal) => loadOverview(apiClient, signal),
    [],
  );

  // Poll only while something is running (bounded; nothing to poll otherwise).
  const anyActive = (data?.networks ?? []).some(
    (n) => n.status === 'running' || n.status === 'starting',
  );
  useInterval(() => reload(), anyActive ? 10_000 : null);

  const rollups = useMemo(() => (data ? computeRollups(data) : []), [data]);
  const metrics = useMemo(() => {
    const networks = data?.networks ?? [];
    const running = networks.filter((n) => n.status === 'running').length;
    const unhealthy = rollups.filter((r) => (r.rollup?.unhealthy ?? 0) > 0).length;
    const nodes = networks.reduce((sum, n) => sum + n.nodeCount, 0);
    return { total: networks.length, running, unhealthy, nodes };
  }, [data, rollups]);

  const recentEvents = useMemo(() => events.slice(-12).reverse(), [events]);
  const refresh = useCallback(() => reload(), [reload]);

  if (loading && !data) return <LoadingState label="Loading fleet overview…" />;
  if (error && !data) return <ErrorState error={error} onRetry={refresh} />;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Overview</h1>
        <div className="page-head-actions">
          <span className="muted small">
            {data ? `updated ${formatAgo(data.loadedAt)}` : ''}
          </span>
          <button type="button" className="btn btn-ghost" onClick={refresh}>
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <div className="banner banner-warn" role="alert">
          Refresh failed: <code>{error.code}</code> — {error.message} (showing last loaded data)
        </div>
      ) : null}

      <section aria-label="Fleet metrics">
        <div className="tiles">
          <div className="tile" data-testid="tile-networks">
            <span className="tile-value">{metrics.total}</span>
            <span className="tile-label">Networks</span>
          </div>
          <div className="tile" data-testid="tile-running">
            <span className="tile-value">{metrics.running}</span>
            <span className="tile-label">Running</span>
          </div>
          <div className="tile" data-testid="tile-unhealthy">
            <span className={`tile-value${metrics.unhealthy > 0 ? ' text-danger' : ''}`}>
              {metrics.unhealthy}
            </span>
            <span className="tile-label">Unhealthy networks</span>
          </div>
          <div className="tile" data-testid="tile-nodes">
            <span className="tile-value">{metrics.nodes}</span>
            <span className="tile-label">Nodes</span>
          </div>
        </div>
      </section>

      <div className="grid-2">
        <section aria-label="Network health summaries" className="panel">
          <div className="panel-head">
            <h2>Networks</h2>
            <Link to="/networks" className="small">
              manage →
            </Link>
          </div>
          {metrics.total === 0 ? (
            <EmptyState
              title="No networks yet"
              description="Create a Portaldot network to get started."
              action={
                <Link className="btn btn-primary" to="/networks">
                  Create a network
                </Link>
              }
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Nodes</th>
                    <th>Health</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {rollups.map(({ network, rollup }) => (
                    <tr key={network.id}>
                      <td>
                        <Link to={`/networks/${network.id}`}>{network.name}</Link>
                        <div className="muted small">{network.preset}</div>
                      </td>
                      <td>
                        <StatusBadge status={network.status} />
                      </td>
                      <td>{network.nodeCount}</td>
                      <td>
                        {rollup === null ? (
                          <span className="muted small">not monitoring</span>
                        ) : (
                          <span className="health-rollup">
                            <HealthBadge state="healthy" reasons={[`${rollup.healthy} healthy`]} />
                            {rollup.unhealthy > 0 ? (
                              <HealthBadge
                                state="unhealthy"
                                reasons={[`${rollup.unhealthy} unhealthy`]}
                              />
                            ) : null}
                            {rollup.other > 0 ? (
                              <HealthBadge state="unknown" reasons={[`${rollup.other} other`]} />
                            ) : null}
                          </span>
                        )}
                      </td>
                      <td className="muted small">{formatAgo(network.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section aria-label="Recent operational events" className="panel">
          <div className="panel-head">
            <h2>Recent events</h2>
            <Link to="/events" className="small">
              all →
            </Link>
          </div>
          {recentEvents.length === 0 ? (
            <EmptyState
              title={status === 'open' ? 'No events yet' : 'Waiting for the event stream'}
              description={
                status === 'open'
                  ? 'Lifecycle, monitoring, and operation events will appear here.'
                  : 'Events appear once the live connection is established.'
              }
            />
          ) : (
            <ul className="event-list">
              {recentEvents.map((e) => (
                <li key={e.seq} className="event-row">
                  <span className={`event-kind event-${e.name.split('.')[0]}`}>{e.name}</span>
                  <span className="event-text">{summarizeEvent(e.name, e.payload)}</span>
                  <span className="muted small">{formatAgo(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** One-line human summary of an event payload; unknown shapes stay honest. */
export function summarizeEvent(name: string, payload: Record<string, unknown>): string {
  const p = payload;
  const id = typeof p['name'] === 'string' ? (p['name'] as string) : (p['networkId'] as string) ?? '';
  switch (name) {
    case 'network.created':
      return `network “${String(p['name'] ?? '')}” created (${String(p['nodeCount'] ?? '?')} nodes, ${String(p['preset'] ?? '?')})`;
    case 'network.status':
      return `network “${String(p['name'] ?? id)}” → ${String(p['status'] ?? '?')}`;
    case 'node.status':
      return `node “${String(p['name'] ?? p['nodeId'] ?? '')}” → ${String(p['status'] ?? '?')}`;
    case 'monitor.health':
      return `node “${String(p['name'] ?? p['nodeId'] ?? '')}” health ${String(p['from'] ?? '?')} → ${String(p['to'] ?? '?')} (${(p['reasons'] as string[] | undefined)?.join('; ') ?? ''})`;
    case 'monitor.peers':
      return `node “${String(p['name'] ?? p['nodeId'] ?? '')}” peers ${String(p['from'] ?? '?')} → ${String(p['to'] ?? '?')}`;
    case 'monitor.error':
      return `monitoring error on ${String(p['networkId'] ?? '')}: ${String(p['message'] ?? '')}`;
    case 'operation.completed':
      return `operation ${String(p['kind'] ?? '')} ${p['ok'] === true ? 'OK' : 'FAILED'} (${String(p['durationMs'] ?? '?')}ms)`;
    case 'monitor.sample':
      return `sample for network ${String(p['networkId'] ?? '')}`;
    case 'rpc.sample':
      return `rpc sample for ${String(p['nodeId'] ?? '')}`;
    default:
      return JSON.stringify(payload).slice(0, 120);
  }
}
