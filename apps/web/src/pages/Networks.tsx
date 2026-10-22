/**
 * Networks (T-3.6C): the REAL network list from GET /api/networks, with the
 * operator's selection. Creating goes to the Create screen; lifecycle
 * operations stay on Overview (backend-owned, FR-1).
 */

import { useNavigate } from 'react-router-dom';
import { Btn, Empty, ErrorBox } from '../components/ui';
import { useConsole } from '../state/ConsoleContext';

export function Networks() {
  const nav = useNavigate();
  const { networks, networksError, networksLoaded, selectedId, select } = useConsole();
  if (networksError) return <ErrorBox error={networksError} title="Cannot reach the Kaizen API" />;
  if (!networksLoaded) return <div className="sub">Loading networks…</div>;
  if (!networks.length)
    return (
      <Empty
        title="No networks yet"
        text="Create a Portaldot network from a preset. Kaizen starts real portaldot_dev processes — or run `npx kaizen up` from the repo."
        action={
          <Btn tone="pri" arrow onClick={() => nav('/create')}>
            Create network
          </Btn>
        }
      />
    );
  return (
    <div className="pagehead">
      <div className="lab">
        {networks.length} network{networks.length === 1 ? '' : 's'} on this control plane
      </div>
      <h1>
        Your <span className="g">networks</span>
      </h1>
      <div className="tbl" role="table" aria-label="Networks" style={{ marginTop: 18, maxWidth: 1000 }}>
        <div className="tr th" role="row">
          <span>Name</span>
          <span>Preset</span>
          <span>Status</span>
          <span>Nodes</span>
          <span />
        </div>
        {networks.map((n) => (
          <div key={n.id} role="row" className={`tr ${n.id === selectedId ? 'row on' : 'row'}`} onClick={() => select(n.id)}>
            <span>
              <b>{n.name}</b>
              <br />
              <small className="sub">{n.designatedTest ? 'designated test network' : 'not a test network'}</small>
            </span>
            <span>{n.preset}</span>
            <span>
              <span className={`chip ${n.status === 'running' ? 'running' : n.status === 'starting' ? 'deploying' : n.status === 'degraded' ? 'bad' : 'pending'}`}>{n.status}</span>
            </span>
            <span>{n.nodeCount}</span>
            <span>
              <Btn
                small
                tone={n.id === selectedId ? 'pri' : 'line'}
                onClick={() => {
                  select(n.id);
                  nav('/overview');
                }}
              >
                Open
              </Btn>
            </span>
          </div>
        ))}
      </div>
      <div className="actions" style={{ marginTop: 22 }}>
        <Btn tone="pri" arrow onClick={() => nav('/create')}>
          Create network
        </Btn>
      </div>
    </div>
  );
}
