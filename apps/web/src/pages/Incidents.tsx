/**
 * Incidents (design import, T-3.6B). Automatic incident detection and
 * correlation is Phase 4 and NOT built — it is labelled as such. What this
 * screen shows is real: each executed fault's persisted evidence (before /
 * applied / effect / removed / recovery observations) as a timeline.
 */

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import type { FaultRecord } from '../api/types';
import { Btn, Empty, NoNet, Planned, ease } from '../components/ui';
import { formatTs, shortId } from '../components/fmt';
import { ACTIVE_FAULT_STATES } from '../lib/model';
import { useConsole } from '../state/ConsoleContext';

interface TimelineEntry {
  t: string | null;
  msg: string;
  lvl: 'ok' | 'warn';
}

export function faultTimeline(f: FaultRecord): TimelineEntry[] {
  const ev = f.evidence;
  const out: TimelineEntry[] = [{ t: f.requestedAt, msg: `${f.type} requested on ${f.nodeName} by ${f.requestedBy}`, lvl: 'ok' }];
  if (ev?.before) out.push({ t: ev.before.at, msg: `Before: RPC ${ev.before.rpcReachable ? 'reachable' : 'unreachable'}${ev.before.head ? `, head #${ev.before.head.number}` : ''}`, lvl: 'ok' });
  if (ev?.applied) out.push({ t: ev.applied.at, msg: `Applied: ${ev.applied.how}`, lvl: 'warn' });
  if (ev?.effect) out.push({ t: ev.effect.at, msg: `Effect ${ev.effect.observed ? 'observed' : 'NOT observed'}: ${ev.effect.detail}`, lvl: 'warn' });
  if (ev?.removed) out.push({ t: ev.removed.at, msg: `Removed: ${ev.removed.how}`, lvl: 'ok' });
  if (ev?.recovery) out.push({ t: ev.recovery.at, msg: `Recovery ${ev.recovery.verified ? 'verified' : 'NOT verified'}: ${ev.recovery.detail}`, lvl: ev.recovery.verified ? 'ok' : 'warn' });
  if (f.finishedAt) out.push({ t: f.finishedAt, msg: `Finished: ${f.state}${f.result ? ` (${f.result.outcome})` : ''}`, lvl: f.state === 'completed' ? 'ok' : 'warn' });
  return out;
}

export function Incidents() {
  const nav = useNavigate();
  const { network, faults } = useConsole();
  const [pick, setPick] = useState<string | null>(null);
  if (!network) return <NoNet />;
  const executed = faults.filter((f) => f.mode === 'execute');
  const banner = (
    <div className="sub">
      Automatic incident detection, correlation and root-cause hints <Planned phase="Phase 4" /> — below is the recorded fault evidence.
    </div>
  );
  if (!executed.length)
    return (
      <>
        {banner}
        <Empty
          title="No fault evidence yet"
          text="Break something in the Failure Lab and its observed evidence (applied, effect, removal, recovery) appears here."
          action={
            <Btn tone="pri" arrow onClick={() => nav('/lab')}>
              Open Failure Lab
            </Btn>
          }
        />
      </>
    );
  const f = executed.find((x) => x.id === pick) ?? executed[0]!;
  const live = ACTIVE_FAULT_STATES.has(f.state);
  const claims = f.result?.claims;
  return (
    <div className="incident">
      {banner}
      <div className="chips" style={{ marginTop: 14 }}>
        {executed.slice(0, 12).map((x) => (
          <button type="button" key={x.id} className={`chip ${x.id === f.id ? 'sel' : ''}`} onClick={() => setPick(x.id)}>
            {x.type} · {x.nodeName.replace(`${network.name}-`, '')} · {x.state}
          </button>
        ))}
      </div>
      <div className={`lab ${live ? 'warn' : f.state === 'completed' ? 'ok' : 'bad'}`}>{live ? 'In progress' : f.state}</div>
      <h1>Fault {shortId(f.id, 18)}</h1>
      <ol className="tl">
        <AnimatePresence initial={false}>
          {faultTimeline(f).map((e, i) => (
            <motion.li key={i} className={e.lvl} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.35, ease }}>
              <time>{formatTs(e.t).split(', ').pop()}</time>
              <span>{e.msg}</span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
      <div className="cols">
        <div>
          <div className="lab">What was affected</div>
          <p>
            {f.nodeName} ({f.type}
            {f.holdDurationMs ? `, ${f.holdDurationMs / 1000}s hold` : ''})
          </p>
        </div>
        <div>
          <div className="lab">Observed effect</div>
          <p>{f.evidence?.effect ? f.evidence.effect.detail : live ? 'Not observed yet.' : 'No effect observation recorded.'}</p>
        </div>
        <div>
          <div className="lab">Recovery</div>
          <p>{claims ? (claims.recoveryVerified ? 'Verified independently over RPC.' : claims.recovered ? 'Recovered, but not independently verified.' : 'Not recovered.') : live ? 'Not finished yet.' : '—'}</p>
        </div>
      </div>
      {f.error && <div className="wbox">{f.error.message}</div>}
      <div className="actions">
        <Btn tone="pri" arrow onClick={() => nav('/lab')}>
          Failure Lab
        </Btn>
        <Btn onClick={() => nav('/overview')}>View network</Btn>
      </div>
    </div>
  );
}
