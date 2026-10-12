/**
 * Events: the live engine event stream, rendered once per delivery.
 *
 * Backed by the app-wide context (one WebSocket for the whole UI, so there
 * are no duplicate subscriptions). Payloads are real engine events with
 * their real timestamps; nothing is synthesized when the stream is down.
 */

import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { useEventsContext, type StoredEvent } from '../state/EventsContext';
import { EmptyState } from '../components/States';
import { formatAgo, formatTs } from '../components/fmt';
import { summarizeEvent } from './OverviewPage';

type KindFilter = 'all' | 'network' | 'node' | 'monitor' | 'operation';

const KINDS: Array<{ value: KindFilter; label: string }> = [
  { value: 'all', label: 'All events' },
  { value: 'network', label: 'Network' },
  { value: 'node', label: 'Node' },
  { value: 'monitor', label: 'Monitoring' },
  { value: 'operation', label: 'Operations' },
];

export function filterEvents(events: StoredEvent[], kind: KindFilter): StoredEvent[] {
  const list = kind === 'all' ? events : events.filter((e) => e.name.startsWith(`${kind}.`));
  return list.slice(-200).reverse();
}

export function EventsPage(): JSX.Element {
  const { events, status, generation, clear } = useEventsContext();
  const [kind, setKind] = useState<KindFilter>('all');
  const filtered = useMemo(() => filterEvents(events, kind), [events, kind]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Events</h1>
        <div className="page-head-actions">
          <label className="field inline">
            <span className="sr-only">Filter by kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as KindFilter)}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-ghost" onClick={clear}>
            Clear view
          </button>
        </div>
      </div>

      {generation > 0 ? (
        <div className="banner banner-warn" role="status">
          The event stream reconnected {generation === 1 ? 'once' : `${generation} times`} this
          session. Events during an outage are not replayed — pages refetch live state instead.
        </div>
      ) : null}

      <section className="panel" aria-label="Event feed">
        <div className="panel-head">
          <h2>Live feed</h2>
          <span className="muted small">
            {filtered.length} shown · stream {status}
          </span>
        </div>
        {filtered.length === 0 ? (
          <EmptyState
            title={status === 'open' ? 'No events yet' : 'Waiting for the event stream'}
            description={
              status === 'open'
                ? 'Start a network to see lifecycle, monitoring, and operation events here.'
                : 'The live feed appears once the WebSocket connects to the backend.'
            }
          />
        ) : (
          <ul className="event-list detailed">
            {filtered.map((e) => (
              <li key={e.seq} className="event-row">
                <span className={`event-kind event-${e.name.split('.')[0]}`}>{e.name}</span>
                <span className="event-text">{summarizeEvent(e.name, e.payload)}</span>
                <span className="muted small" title={`received ${formatTs(e.receivedAt)}`}>
                  {formatAgo(e.at)}
                </span>
                <details>
                  <summary>Payload</summary>
                  <pre className="log-view">{JSON.stringify(e.payload, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
