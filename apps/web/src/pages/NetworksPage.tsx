/**
 * Networks: list (with client-side search), creation, entry point to detail.
 * Statuses and counts come from GET /api/networks — nothing is inferred.
 */

import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../api/client';
import { useAsync, useInterval } from '../state/useAsync';
import { useEventsContext } from '../state/EventsContext';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { StatusBadge } from '../components/StatusBadge';
import { formatTs } from '../components/fmt';
import { CreateNetworkForm } from './CreateNetworkForm';

export function NetworksPage(): JSX.Element {
  const { generation } = useEventsContext();
  const [showCreate, setShowCreate] = useState(false);
  const [query, setQuery] = useState('');
  const { data, error, loading, reload } = useAsync(
    () => apiClient.listNetworks(),
    [generation],
  );

  // Gentle refresh while anything is mid-lifecycle; manual otherwise.
  const lifecycleActive = (data?.networks ?? []).some((n) =>
    ['starting', 'stopping'].includes(n.status),
  );
  useInterval(() => reload(), lifecycleActive ? 3_000 : null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = data?.networks ?? [];
    if (!q) return list;
    return list.filter((n) => n.name.toLowerCase().includes(q) || n.preset.includes(q));
  }, [data, query]);

  if (loading && !data) return <LoadingState label="Loading networks…" />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Networks</h1>
        <div className="page-head-actions">
          <input
            className="search"
            type="search"
            placeholder="Filter by name or preset…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter networks"
          />
          <button
            type="button"
            className={`btn${showCreate ? '' : ' btn-primary'}`}
            onClick={() => setShowCreate((v) => !v)}
            aria-expanded={showCreate}
          >
            {showCreate ? 'Close' : 'Create network'}
          </button>
        </div>
      </div>

      {showCreate ? (
        <CreateNetworkForm onCreated={reload} />
      ) : null}

      <section className="panel" aria-label="Network list">
        <div className="panel-head">
          <h2>All networks</h2>
          <button type="button" className="btn btn-ghost" onClick={reload}>
            Refresh
          </button>
        </div>
        {error ? (
          <div className="banner banner-warn" role="alert">
            Refresh failed: <code>{error.code}</code> — {error.message} (showing last loaded data)
          </div>
        ) : null}
        {(data?.networks.length ?? 0) === 0 ? (
          <EmptyState
            title="No networks yet"
            description="Create a single-node, two-node, four-validator, or custom Portaldot network."
            action={
              <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
                Create your first network
              </button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState title="No matches" description={`No network matches “${query}”.`} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Topology</th>
                  <th>Status</th>
                  <th>Nodes</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((n) => (
                  <tr key={n.id}>
                    <td>
                      <Link to={`/networks/${n.id}`}>{n.name}</Link>
                      <div className="muted small">{n.id}</div>
                    </td>
                    <td>{n.preset}</td>
                    <td>
                      <StatusBadge status={n.status} />
                    </td>
                    <td>{n.nodeCount}</td>
                    <td className="muted small">{formatTs(n.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
