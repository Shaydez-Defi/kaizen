/**
 * Node detail (T-2.6/T-2.7): identity, live health evidence, peers, sync,
 * and the captured log tail (real bytes from the engine's log file).
 *
 * Unreachable fields render as “unreachable”/“—” with the RPC error shown —
 * the page never substitutes plausible numbers for missing reads.
 */

import type { JSX } from 'react';
import { useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient } from '../api/client';
import { useAsync, useInterval } from '../state/useAsync';
import { useEventsContext } from '../state/EventsContext';
import { BackLink, ErrorState, LoadingState } from '../components/States';
import { HealthBadgeOrUnknown, StatusBadge } from '../components/StatusBadge';
import { OperationButton } from '../components/OperationButton';
import { formatAgo, formatTs, formatUptime, shortId } from '../components/fmt';

export function NodeDetailPage(): JSX.Element {
  const { networkId = '', nodeId = '' } = useParams();
  const { generation } = useEventsContext();

  const detail = useAsync(() => apiClient.getNode(networkId, nodeId), [networkId, nodeId, generation]);
  const reload = detail.reload;
  const node = detail.data?.node ?? null;

  const logs = useAsync(
    () => apiClient.nodeLogs(networkId, nodeId),
    [networkId, nodeId, generation],
  );

  const isRunning = node?.status === 'running' || node?.status === 'starting';
  useInterval(() => reload(), isRunning ? 5_000 : null);
  useInterval(() => logs.reload(), isRunning ? 10_000 : null);

  const reloadAll = useCallback(() => {
    reload();
    logs.reload();
  }, [reload, logs.reload]);

  const sample = detail.data?.sample ?? null;
  const health = detail.data?.health ?? null;
  const logLines = useMemo(() => logs.data?.lines ?? [], [logs.data]);

  if (detail.loading && !detail.data) return <LoadingState label="Loading node…" />;
  if (detail.error && !detail.data) {
    return (
      <div className="page">
        <BackLink to={`/networks/${networkId}`}>Back to network</BackLink>
        <ErrorState error={detail.error} onRetry={reloadAll} />
      </div>
    );
  }
  if (!node) return <LoadingState />;

  return (
    <div className="page">
      <BackLink to={`/networks/${networkId}`}>Back to network</BackLink>
      <div className="page-head">
        <div>
          <h1>{node.name}</h1>
          <div className="meta-line">
            <StatusBadge status={node.status} kind="node" />
            <span className="muted">{node.role}</span>
            {node.wellKnownKey ? <span className="badge badge-key">key: {node.wellKnownKey}</span> : null}
            <HealthBadgeOrUnknown health={health} />
          </div>
        </div>
        <div className="page-head-actions">
          {isRunning ? (
            <OperationButton
              className="btn"
              onRun={() => apiClient.stopNode(networkId, nodeId)}
              onFinished={reloadAll}
              busyLabel="Stopping…"
            >
              Stop node
            </OperationButton>
          ) : (
            <OperationButton
              className="btn btn-primary"
              onRun={() => apiClient.startNode(networkId, nodeId)}
              onFinished={reloadAll}
              busyLabel="Starting…"
              disabled={node.status === 'starting' || node.status === 'stopping'}
            >
              Start node
            </OperationButton>
          )}
          <button type="button" className="btn btn-ghost" onClick={reloadAll}>
            Refresh
          </button>
        </div>
      </div>

      {health && health.reasons.length > 0 ? (
        <div className={`banner ${health.state === 'healthy' ? 'banner-ok' : 'banner-warn'}`} role="status">
          <strong>{health.state}</strong>: {health.reasons.join(' · ')}
          <span className="muted small"> (since {formatTs(health.since)})</span>
        </div>
      ) : null}

      <div className="grid-2">
        <section className="panel" aria-label="Node identity">
          <div className="panel-head">
            <h2>Identity & process</h2>
          </div>
          <dl className="kv">
            <dt>Node id</dt>
            <dd className="mono small">{node.id}</dd>
            <dt>Role</dt>
            <dd>{node.role}</dd>
            <dt>Well-known key</dt>
            <dd>{node.wellKnownKey ?? <span className="muted">none (keyless)</span>}</dd>
            <dt>PID</dt>
            <dd className="mono">{node.pid ?? <span className="muted">—</span>}</dd>
            <dt>Started</dt>
            <dd>{node.startedAt ? formatTs(node.startedAt) : <span className="muted">—</span>}</dd>
            <dt>Uptime</dt>
            <dd>{formatUptime(sample?.uptimeMs ?? null)}</dd>
            <dt>Expected peers</dt>
            <dd>{node.expectedPeers ?? '—'}</dd>
            <dt>Ports</dt>
            <dd className="mono small">
              p2p {node.ports.p2p} · rpc {node.ports.rpc} · ws {node.ports.ws} · prom{' '}
              {node.ports.prometheus}
            </dd>
            <dt>Bootnodes</dt>
            <dd className="mono small">
              {node.bootnodes.length > 0 ? node.bootnodes.map((b) => shortId(b, 42)).join(', ') : '—'}
            </dd>
            <dt>Base dir</dt>
            <dd className="mono small">{node.baseDir}</dd>
          </dl>
        </section>

        <section className="panel" aria-label="Live chain data">
          <div className="panel-head">
            <h2>Live chain data</h2>
            <span className="muted small">
              {sample ? `sample ${formatAgo(sample.at)}` : 'no sample yet'}
            </span>
          </div>
          {!sample ? (
            <p className="muted" data-testid="no-sample">
              No monitoring sample yet — {isRunning ? 'waiting for the first RPC read.' : 'the node is not running.'}
            </p>
          ) : !sample.rpc.reachable ? (
            <div className="state-block error" role="status" data-testid="rpc-unreachable">
              <h3>RPC unreachable</h3>
              <p className="muted">
                {sample.rpc.error ?? 'connection failed'} — process is{' '}
                <StatusBadge status={sample.process.status} kind="node" />.
              </p>
            </div>
          ) : (
            <dl className="kv">
              <dt>Best block</dt>
              <dd className="mono">
                {sample.head ? `#${sample.head.number}` : <span className="muted">—</span>}
                {sample.head ? (
                  <span className="muted small mono"> {shortId(sample.head.hash, 16)}</span>
                ) : null}
              </dd>
              <dt>Finalized</dt>
              <dd className="mono">
                {sample.finalized ? (
                  `#${sample.finalized.number}`
                ) : (
                  <span className="muted">not finalized yet / unreadable</span>
                )}
              </dd>
              <dt>Sync</dt>
              <dd>
                {sample.sync
                  ? `${sample.sync.currentBlock} / ${sample.sync.highestBlock ?? '?'} (start ${sample.sync.startingBlock})${sample.health?.isSyncing ? ' — syncing' : ''}`
                  : <span className="muted">—</span>}
              </dd>
              <dt>Peers</dt>
              <dd>
                {sample.peers ? (
                  <>
                    {sample.peers.count} / {sample.peers.expected} expected
                  </>
                ) : (
                  <span className="muted">unreachable</span>
                )}
              </dd>
              <dt>Genesis hash</dt>
              <dd className="mono small">{sample.genesisHash ?? <span className="muted">—</span>}</dd>
              {sample.warnings.length > 0 ? (
                <>
                  <dt>Warnings</dt>
                  <dd>
                    <ul className="issues">
                      {sample.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </dd>
                </>
              ) : null}
            </dl>
          )}

          {sample?.peers && sample.peers.list.length > 0 ? (
            <>
              <h3>Connected peers</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Peer id</th>
                      <th>Roles</th>
                      <th>Their best</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sample.peers.list.map((p) => (
                      <tr key={p.peerId}>
                        <td className="mono small" title={p.peerId}>
                          {shortId(p.peerId, 18)}
                        </td>
                        <td>{p.roles}</td>
                        <td className="mono">#{p.bestNumber}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>
      </div>

      <section className="panel" aria-label="Node log">
        <div className="panel-head">
          <h2>Log tail</h2>
          <div className="panel-head-actions">
            <span className="muted small">{node.logFile}</span>
            <button type="button" className="btn btn-ghost" onClick={logs.reload}>
              Refresh logs
            </button>
          </div>
        </div>
        {logs.loading && logLines.length === 0 ? (
          <LoadingState label="Reading log…" />
        ) : logs.error ? (
          <ErrorState error={logs.error} onRetry={logs.reload} />
        ) : logLines.length === 0 ? (
          <p className="muted" data-testid="no-logs">
            No log output captured yet (the node has not produced any).
          </p>
        ) : (
          <pre className="log-view" tabIndex={0} aria-label={`Log tail of ${node.name}`}>
            {logLines.join('\n')}
          </pre>
        )}
      </section>
    </div>
  );
}
