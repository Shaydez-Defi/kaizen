/**
 * Network detail (T-2.6): identity + lifecycle controls + LIVE per-node
 * table driven by real monitoring snapshots.
 *
 * Honesty rules enforced here:
 *  - a field the RPC could not read renders as “unreachable”/“—”, never 0
 *  - monitoring only runs for running networks; otherwise the section says so
 *  - destructive actions (purge/remove) always go through confirmation
 */

import type { JSX } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiClient } from '../api/client';
import { useAsync, useInterval } from '../state/useAsync';
import { useEventsContext } from '../state/EventsContext';
import { BackLink, EmptyState, ErrorState, LoadingState } from '../components/States';
import { HealthBadgeOrUnknown, StatusBadge } from '../components/StatusBadge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { OperationButton } from '../components/OperationButton';
import { formatAgo, formatTs, formatUptime, shortId } from '../components/fmt';
import { summarizeEvent } from './OverviewPage';

type DialogKind = 'purge' | 'remove' | null;

export function NetworkDetailPage(): JSX.Element {
  const { networkId = '' } = useParams();
  const navigate = useNavigate();
  const { events, generation } = useEventsContext();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);

  const detail = useAsync(() => apiClient.getNetwork(networkId), [networkId, generation]);
  const reload = detail.reload;
  const network = detail.data?.network ?? null;
  const nodes = detail.data?.nodes ?? [];

  const monitor = useAsync(
    () => apiClient.monitorSnapshot(networkId),
    [networkId, generation, network?.status],
  );
  const monitorReload = monitor.reload;

  const isRunning = network?.status === 'running' || network?.status === 'starting';
  // Poll live monitoring only while the network is up (bounded, no busy loop).
  useInterval(() => monitorReload(), isRunning ? 5_000 : null);

  const reloadAll = useCallback(() => {
    reload();
    monitorReload();
  }, [reload, monitorReload]);

  const snapshot = monitor.data?.snapshot ?? null;
  const rows = useMemo(
    () =>
      nodes.map((node) => ({
        node,
        sample: snapshot?.samples.find((s) => s.nodeId === node.id) ?? null,
        health: snapshot?.health.find((h) => h.nodeId === node.id) ?? null,
      })),
    [nodes, snapshot],
  );

  const netEvents = useMemo(
    () =>
      events
        .filter(
          (e) =>
            (e.payload['networkId'] as string | undefined) === networkId ||
            (e.payload['nodeId'] as string | undefined)?.startsWith(`${networkId}-`),
        )
        .slice(-15)
        .reverse(),
    [events, networkId],
  );

  if (detail.loading && !detail.data) return <LoadingState label="Loading network…" />;
  if (detail.error && !detail.data) {
    return (
      <div className="page">
        <BackLink to="/networks">Networks</BackLink>
        <ErrorState error={detail.error} onRetry={reloadAll} />
      </div>
    );
  }
  if (!network) return <LoadingState />;

  const closeDialog = (): void => {
    setDialog(null);
    setDialogError(null);
  };

  return (
    <div className="page">
      <BackLink to="/networks">Networks</BackLink>
      <div className="page-head">
        <div>
          <h1>{network.name}</h1>
          <div className="meta-line">
            <StatusBadge status={network.status} />
            <span className="muted">{network.preset}</span>
            <span className="muted small">{network.id}</span>
            {network.designatedTest ? (
              <span className="badge badge-designated" title="Failure operations permitted (DEC-008)">
                designated test
              </span>
            ) : null}
          </div>
        </div>
        <div className="page-head-actions">
          {network.status === 'running' ? (
            <OperationButton
              className="btn"
              onRun={() => apiClient.stopNetwork(network.id)}
              onFinished={reloadAll}
              busyLabel="Stopping…"
            >
              Stop network
            </OperationButton>
          ) : (
            <OperationButton
              className="btn btn-primary"
              onRun={() => apiClient.startNetwork(network.id)}
              onFinished={reloadAll}
              busyLabel="Starting (health-gated)…"
              disabled={network.status === 'starting' || network.status === 'stopping'}
            >
              Start network
            </OperationButton>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => setDialog('purge')}
            disabled={network.status === 'running' || network.status === 'starting'}
            title={
              network.status === 'running'
                ? 'Stop the network before purging chain data'
                : 'Delete chain databases; keep identity, ports, spec'
            }
          >
            Purge chain data
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => setDialog('remove')}
            disabled={network.status === 'running' || network.status === 'starting'}
            title={
              network.status === 'running' ? 'Stop the network before removing it' : 'Delete this network'
            }
          >
            Remove
          </button>
        </div>
      </div>

      <div className="grid-2">
        <section className="panel" aria-label="Network identity">
          <div className="panel-head">
            <h2>Identity</h2>
          </div>
          <dl className="kv">
            <dt>Name</dt>
            <dd>{network.name}</dd>
            <dt>Preset</dt>
            <dd>{network.preset}</dd>
            <dt>Chain</dt>
            <dd>{network.chain}</dd>
            <dt>Chain spec</dt>
            <dd className="mono small">{network.chainSpecPath ?? '— (dev chain)'}</dd>
            <dt>Created</dt>
            <dd>{formatTs(network.createdAt)}</dd>
            <dt>Updated</dt>
            <dd>{formatTs(network.updatedAt)}</dd>
            <dt>Base dir</dt>
            <dd className="mono small">{network.baseDir}</dd>
          </dl>
        </section>

        <section className="panel" aria-label="Nodes configuration">
          <div className="panel-head">
            <h2>Nodes ({nodes.length})</h2>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Key</th>
                  <th>Ports (p2p/rpc/ws/prom)</th>
                  <th>Exp. peers</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ node }) => (
                  <tr key={node.id}>
                    <td>
                      <Link to={`/networks/${network.id}/nodes/${node.id}`}>{node.name}</Link>
                      <div className="muted small" title={node.id}>
                        {shortId(node.id, 18)}
                      </div>
                    </td>
                    <td>{node.role}</td>
                    <td>
                      <StatusBadge status={node.status} kind="node" />
                    </td>
                    <td>{node.wellKnownKey ?? <span className="muted">—</span>}</td>
                    <td className="mono small">
                      {node.ports.p2p}/{node.ports.rpc}/{node.ports.ws}/{node.ports.prometheus}
                    </td>
                    <td>{node.expectedPeers ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="panel" aria-label="Live monitoring">
        <div className="panel-head">
          <h2>Live monitoring</h2>
          <div className="panel-head-actions">
            {snapshot ? (
              <span className="muted small" title={snapshot.at}>
                sample {formatAgo(snapshot.at)} · every {Math.round(snapshot.intervalMs / 1000)}s
              </span>
            ) : null}
            {isRunning ? (
              <button type="button" className="btn btn-ghost" onClick={monitorReload}>
                Sample now
              </button>
            ) : null}
          </div>
        </div>

        {!isRunning ? (
          <p className="muted" data-testid="monitor-off">
            Monitoring runs while the network is running. Current status:{' '}
            <StatusBadge status={network.status} />.
          </p>
        ) : monitor.loading && !snapshot ? (
          <LoadingState label="Waiting for the first RPC sample…" />
        ) : monitor.error && !snapshot ? (
          <ErrorState error={monitor.error} onRetry={monitorReload} />
        ) : snapshot ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Health</th>
                  <th>Peers</th>
                  <th>Best</th>
                  <th>Finalized</th>
                  <th>Sync</th>
                  <th>Uptime</th>
                  <th>Sample</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ node, sample, health }) => (
                  <tr key={node.id}>
                    <td>
                      <Link to={`/networks/${network.id}/nodes/${node.id}`}>{node.name}</Link>
                    </td>
                    <td>
                      <HealthBadgeOrUnknown health={health} />
                      {health && health.reasons.length > 0 ? (
                        <div className="muted small reasons">{health.reasons.join(' · ')}</div>
                      ) : null}
                    </td>
                    <td>
                      {sample && sample.rpc.reachable && sample.peers ? (
                        <span
                          className={sample.peers.count < sample.peers.expected ? 'text-warn' : ''}
                          title={`expected ${sample.peers.expected}`}
                        >
                          {sample.peers.count}/{sample.peers.expected}
                        </span>
                      ) : (
                        <span className="muted" title={sample?.rpc.error ?? 'no sample'}>
                          unreachable
                        </span>
                      )}
                    </td>
                    <td className="mono">
                      {sample?.head ? `#${sample.head.number}` : <span className="muted">—</span>}
                    </td>
                    <td className="mono">
                      {sample?.finalized ? (
                        `#${sample.finalized.number}`
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {sample?.health ? (
                        sample.health.isSyncing ? (
                          <span className="badge badge-warn">syncing</span>
                        ) : (
                          <span className="muted">in sync</span>
                        )
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{formatUptime(sample?.uptimeMs ?? null)}</td>
                    <td className="muted small">{sample ? formatAgo(sample.at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {snapshot.samples.some((s) => s.warnings.length > 0) ? (
              <ul className="issues">
                {snapshot.samples.flatMap((s) =>
                  s.warnings.map((w, i) => (
                    <li key={`${s.nodeId}-${i}`}>
                      {s.name}: {w}
                    </li>
                  )),
                )}
              </ul>
            ) : null}
          </div>
        ) : (
          <EmptyState title="No monitoring data yet" description="Waiting for RPC samples." />
        )}
      </section>

      <section className="panel" aria-label="Recent events for this network">
        <div className="panel-head">
          <h2>Recent events</h2>
          <Link to="/events" className="small">
            all →
          </Link>
        </div>
        {netEvents.length === 0 ? (
          <EmptyState title="No events yet" description="Lifecycle and monitoring events appear here." />
        ) : (
          <ul className="event-list">
            {netEvents.map((e) => (
              <li key={e.seq} className="event-row">
                <span className={`event-kind event-${e.name.split('.')[0]}`}>{e.name}</span>
                <span className="event-text">{summarizeEvent(e.name, e.payload)}</span>
                <span className="muted small">{formatAgo(e.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={dialog === 'purge'}
        title="Purge chain data?"
        danger
        busy={dialogBusy}
        error={dialogError}
        body={
          <>
            <p>
              Deletes the chain databases of all {nodes.length} nodes in{' '}
              <strong>{network.name}</strong>. Identities (peer ids), ports, and the chain spec are
              kept — the next start boots from a fresh genesis.
            </p>
          </>
        }
        confirmLabel="Purge chain data"
        onCancel={closeDialog}
        onConfirm={() => {
          setDialogBusy(true);
          setDialogError(null);
          apiClient
            .purgeNetwork(network.id)
            .then((res) => {
              if (!res.ok) {
                setDialogError(
                  `${res.result.error?.code ?? 'FAILED'}: ${res.result.error?.message ?? ''}`,
                );
              } else {
                closeDialog();
                reloadAll();
              }
            })
            .catch((e: unknown) => setDialogError(e instanceof Error ? e.message : String(e)))
            .finally(() => setDialogBusy(false));
        }}
      />

      <ConfirmDialog
        open={dialog === 'remove'}
        title={`Remove network “${network.name}”?`}
        danger
        busy={dialogBusy}
        error={dialogError}
        body={
          <p>
            Deletes the network definition and its node data directories from this machine. This
            cannot be undone.
          </p>
        }
        confirmLabel="Remove network"
        onCancel={closeDialog}
        onConfirm={() => {
          setDialogBusy(true);
          setDialogError(null);
          apiClient
            .removeNetwork(network.id)
            .then(() => {
              closeDialog();
              navigate('/networks');
            })
            .catch((e: unknown) => setDialogError(e instanceof Error ? e.message : String(e)))
            .finally(() => setDialogBusy(false));
        }}
      />
    </div>
  );
}
