/**
 * Overview (design import, T-3.6B): live topology + network status over the
 * REAL monitoring snapshot. Start/stop are backend operations (FR-1).
 */

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ApiError, apiClient } from '../api/client';
import { Topology } from '../components/Topology';
import { Btn, ErrorBox, NoNet, Num, Stat, ease } from '../components/ui';
import { bestHeight, finalizedHeight, healthyCount, liveLinks } from '../lib/model';
import { eventLevel, eventText, eventTime, isNotable } from '../lib/eventText';
import { useConsole } from '../state/ConsoleContext';
import { useEventsContext } from '../state/EventsContext';

export function Overview() {
  const nav = useNavigate();
  const { vnet, network, openNode, refresh, detailError, networksError, networksLoaded } = useConsole();
  const { events } = useEventsContext();
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  if (networksError) return <ErrorBox error={networksError} title="Cannot reach the Kaizen API" />;
  if (!networksLoaded) return <div className="sub">Loading networks…</div>;
  if (!vnet || !network) return detailError ? <ErrorBox error={detailError} /> : <NoNet />;

  const n = vnet.nodes.length;
  const healthy = healthyCount(vnet);
  const running = network.status === 'running' || network.status === 'degraded';
  const ok = running && healthy === n && n > 0;
  const label = ok ? 'Running' : running ? 'Degraded' : network.status === 'starting' ? 'Starting' : 'Not running';
  const headline = ok ? 'Network healthy' : running ? 'Network degraded' : network.status === 'starting' ? 'Network starting' : `Network ${network.status}`;
  const recent = events.filter((e) => isNotable(e) && (e.payload['networkId'] === network.id)).slice(-5).reverse();
  const live = liveLinks(vnet);
  const observed = vnet.edges.filter((e) => e.basis === 'observed').length;

  const op = async (kind: 'start' | 'stop') => {
    setBusy(kind);
    setError(null);
    try {
      const res = kind === 'start' ? await apiClient.startNetwork(network.id) : await apiClient.stopNetwork(network.id);
      if (!res.result.ok) setError(new ApiError(res.result.error?.message ?? `${kind} failed`, res.result.error?.code ?? 'OPERATION_FAILED', 200));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  return (
    <>
      <div className="head">
        <div>
          <div className={`lab ${ok ? 'ok' : running ? 'bad' : ''}`}>
            {label} · {network.name} · {network.preset}
          </div>
          <h1>{headline}</h1>
          <div className="actions">
            {running ? (
              <>
                <Btn tone="pri" arrow onClick={() => nav('/lab')}>
                  Open Failure Lab
                </Btn>
                <Btn onClick={() => void op('stop')} disabled={busy !== null}>
                  {busy === 'stop' ? 'Stopping…' : 'Stop network'}
                </Btn>
              </>
            ) : (
              <Btn tone="pri" arrow onClick={() => void op('start')} disabled={busy !== null || network.status === 'starting'}>
                {busy === 'start' ? 'Starting… (health-gated)' : 'Start network'}
              </Btn>
            )}
          </div>
          <ErrorBox error={error} />
        </div>
        <aside className="events" aria-label="Recent events">
          <div className="lab">Recent events (live stream)</div>
          {recent.length === 0 && <div className="sub" style={{ paddingTop: 9 }}>No events for this network since the console opened.</div>}
          <AnimatePresence initial={false}>
            {recent.map((e) => (
              <motion.div key={e.seq} layout className="evt" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }}>
                <span className={eventLevel(e)}>{eventText(e)}</span>
                <time>{eventTime(e)}</time>
              </motion.div>
            ))}
          </AnimatePresence>
        </aside>
      </div>
      <Topology net={vnet} onSelect={openNode} />
      <div className="sub" style={{ textAlign: 'center', marginTop: -8 }}>
        Select a node to inspect it. Solid links: observed by monitoring ({observed} via peer ids); dashed red: not observed.
      </div>
      <div className="stats">
        <Stat label="Healthy nodes" sub={ok ? 'All synced' : running ? 'Some not healthy' : 'Network not running'} tone={running && !ok ? 'bad' : undefined}>
          <Num v={healthy} />/{n}
        </Stat>
        <Stat label="Best block" sub="Highest observed head">
          <Num v={bestHeight(vnet)} />
        </Stat>
        <Stat label="Finalized" sub="GRANDPA (highest observed)">
          <Num v={finalizedHeight(vnet)} />
        </Stat>
        <Stat label="Peer links" sub={`of ${vnet.edges.length} expected (full mesh)`}>
          <Num v={live} />
        </Stat>
      </div>
    </>
  );
}
