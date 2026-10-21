/**
 * Failure Lab (design import, T-3.6B) over the REAL FailureInjector API.
 *
 * - supported mechanisms (pause, terminate) execute via POST faults/execute
 *   with mode:'execute' after an explicit confirm; the request blocks until
 *   applied → held → removed → recovery verified, while the live panel
 *   follows the persisted fault record + fault.state WS events
 * - "Roll back now" cancels the in-flight fault (the injector rolls back)
 * - peer-disconnect / partition are typed-BLOCKED in the engine (R-22) and
 *   are shown disabled with the reason — never simulated (DEC-009)
 */

import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, apiClient } from '../api/client';
import type { FaultExecutionResult, FaultPreview, FaultRecord, FaultType } from '../api/types';
import { Topology } from '../components/Topology';
import { Btn, ErrorBox, NoNet, Num, Planned, Seg, Stat, ease } from '../components/ui';
import { shortId } from '../components/fmt';
import { ACTIVE_FAULT_STATES, healthyCount, liveLinks } from '../lib/model';
import { eventLevel, eventText, eventTime } from '../lib/eventText';
import { useConsole } from '../state/ConsoleContext';
import { useEventsContext } from '../state/EventsContext';

export const FAULTS: { id: FaultType; label: string; short: string; blurb: string; supported: boolean; reason?: string }[] = [
  { id: 'pause', label: 'Pause node', short: 'Pause', blurb: 'SIGSTOP the node process for the hold, then SIGCONT and verify recovery', supported: true },
  { id: 'terminate', label: 'Terminate node', short: 'Terminate', blurb: 'Stop the node process for the hold, then restart it and verify recovery', supported: true },
  {
    id: 'peer-disconnect',
    label: 'Disconnect peer',
    short: 'Disconnect',
    blurb: 'Cut one peer connection',
    supported: false,
    reason: 'Blocked in the engine: reserved-peer removal only works on reserved-only wiring (R-22 B2).',
  },
  {
    id: 'partition',
    label: 'Partition network',
    short: 'Partition',
    blurb: 'Split the network into groups',
    supported: false,
    reason: 'Blocked in the engine: needs topology rewiring or privileged kernel isolation (R-22 C2/C4/C5, DEC-018).',
  },
];

const HOLDS = [
  { v: 10_000, l: '10s' },
  { v: 30_000, l: '30s' },
  { v: 60_000, l: '60s' },
];

const CLAIMS: [keyof FaultExecutionResult['claims'], string][] = [
  ['applied', 'Mechanism applied'],
  ['effectObserved', 'Effect observed (RPC/process)'],
  ['faultRemoved', 'Fault removed'],
  ['recovered', 'Target recovered'],
  ['recoveryVerified', 'Recovery independently verified'],
];

export function Lab() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { vnet, network, faults, refresh } = useConsole();
  const { events } = useEventsContext();
  const [target, setTarget] = useState<string | null>(params.get('node'));
  const [kind, setKind] = useState<FaultType>('pause');
  const [hold, setHold] = useState(10_000);
  const [confirm, setConfirm] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  const [result, setResult] = useState<FaultExecutionResult | null>(null);
  const [preview, setPreview] = useState<FaultPreview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const active: FaultRecord | null = useMemo(
    () => faults.find((f) => f.mode === 'execute' && ACTIVE_FAULT_STATES.has(f.state)) ?? null,
    [faults],
  );
  const logEvents = useMemo(() => {
    if (!network) return [];
    return events
      .filter((e) =>
        active
          ? e.payload['faultId'] === active.id || (e.payload['nodeId'] === active.nodeId && /^(node\.status|monitor\.health)$/.test(e.name))
          : e.name.startsWith('fault.') && e.payload['networkId'] === network.id,
      )
      .slice(-10);
  }, [events, active, network]);

  if (!vnet || !network) return <NoNet />;
  const running = network.status === 'running' || network.status === 'degraded';
  const live = inFlight || active !== null;
  const node = vnet.nodes.find((x) => x.id === target) ?? vnet.nodes.find((x) => x.state === 'running') ?? vnet.nodes[0];
  const fail = FAULTS.find((f) => f.id === kind) ?? FAULTS[0]!;
  const recentFaults = faults.filter((f) => f.mode === 'execute').slice(0, 4);
  if (!node) return <NoNet />;

  const warn = `${node.name} ${kind === 'pause' ? 'freezes (process stopped, stays allocated)' : 'goes offline'} for ${hold / 1000}s, then Kaizen restores it and verifies recovery over RPC.`;

  const doPreview = async () => {
    setError(null);
    setPreview(null);
    try {
      const res = await apiClient.dryRunFault(network.id, { nodeId: node.id, type: kind, options: { durationMs: hold }, requestedBy: 'web' });
      setPreview(res.preview);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0);
      const p = err.details?.['preview'] as FaultPreview | undefined;
      if (p) setPreview(p);
      else setError(err);
    }
  };

  const inject = async () => {
    setConfirm(false);
    setError(null);
    setResult(null);
    setPreview(null);
    setInFlight(true);
    refresh();
    try {
      const res = await apiClient.executeFault(network.id, { nodeId: node.id, type: kind, options: { durationMs: hold }, requestedBy: 'web' });
      setResult(res.result);
      if (res.result.error) setError(new ApiError(res.result.error.message, res.result.error.code, 200));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0));
    } finally {
      setInFlight(false);
      refresh();
    }
  };

  const rollback = async () => {
    if (!active) return;
    setCancelling(true);
    try {
      await apiClient.cancelFault(active.id);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0));
    } finally {
      setCancelling(false);
      refresh();
    }
  };

  const done = !live && result !== null;
  return (
    <>
      <div className="split">
        <div>
          <div className={`lab ${live ? 'bad' : done ? (result.ok ? 'ok' : 'bad') : ''}`}>
            {live ? 'Fault active' : done ? (result.ok ? 'Recovered' : `Outcome: ${result.outcome}`) : `Failure Lab · ${network.name}`}
          </div>
          <h1>{live ? `${active?.nodeName ?? node.name} under ${active?.type ?? kind}` : done ? (result.ok ? 'Recovery verified' : 'Fault did not verify') : 'Break it on purpose'}</h1>
          <Topology net={vnet} sel={live ? undefined : node.id} onSelect={live ? undefined : setTarget} />
          {!network.designatedTest && <div className="wbox">This network is not a designated test network — the engine refuses faults on it (DEC-008).</div>}
        </div>
        <aside className="glass panel danger">
          <AnimatePresence mode="wait" initial={false}>
            {live ? (
              <motion.div key="live" className="stack" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }}>
                <div className="lab">Live fault log</div>
                {active && (
                  <div className="kv">
                    <span>{shortId(active.id, 16)}</span>
                    <b className="warn">{active.state}</b>
                  </div>
                )}
                <div className="log" aria-label="Live fault log">
                  {logEvents.length === 0 && <div className="sub">Waiting for fault events…</div>}
                  {logEvents.map((e) => (
                    <motion.div key={e.seq} className="evt mono" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3, ease }}>
                      <span className={eventLevel(e)}>{eventText(e)}</span>
                      <time>{eventTime(e)}</time>
                    </motion.div>
                  ))}
                </div>
                <Btn tone="pri" arrow disabled={!active || cancelling} onClick={() => void rollback()}>
                  {cancelling ? 'Rolling back…' : 'Roll back now'}
                </Btn>
                <div className="sub">Otherwise the injector removes the fault automatically after the hold and verifies recovery.</div>
              </motion.div>
            ) : (
              <motion.div key="idle" className="stack" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }}>
                <div className="lab">Inject fault</div>
                <div>
                  <div className="field-l">Fault</div>
                  <Seg
                    wrap
                    id="k"
                    label="Fault type"
                    value={kind}
                    onChange={(k) => {
                      setKind(k);
                      setPreview(null);
                    }}
                    items={FAULTS.map((f) => ({ v: f.id, l: f.short, disabled: !f.supported, title: f.reason }))}
                  />
                  <div className="sub" style={{ marginTop: 6 }}>
                    {fail.blurb}.
                  </div>
                  <div className="sub" style={{ marginTop: 6 }}>
                    Disconnect / Partition: <span className="planned blocked">Blocked (R-22)</span>
                  </div>
                </div>
                <div>
                  <div className="field-l">Target</div>
                  <Seg id="t" label="Target node" value={node.id} onChange={setTarget} items={vnet.nodes.map((v) => ({ v: v.id, l: v.label }))} />
                </div>
                <div>
                  <div className="field-l">Hold</div>
                  <Seg id="d" label="Hold duration" value={hold} onChange={setHold} items={HOLDS} />
                </div>
                <div className="wbox">Intentional disruption. {warn}</div>
                {result && (
                  <div className={result.ok ? 'okbox' : 'wbox'} aria-label="Last result">
                    Last fault {shortId(result.faultId, 14)} — {result.outcome} in {(result.durationMs / 1000).toFixed(1)}s
                    {CLAIMS.map(([k, l]) => (
                      <div key={k} className="kv" style={{ padding: '4px 0' }}>
                        <span>{l}</span>
                        <b className={result.claims[k] ? 'ok' : 'bad'}>{result.claims[k] ? 'yes' : 'no'}</b>
                      </div>
                    ))}
                  </div>
                )}
                {preview && (
                  <div className={preview.preflight.ok ? 'okbox' : 'wbox'} aria-label="Dry-run preflight">
                    <b>Dry run: {preview.preflight.ok ? 'ready' : 'refused'}</b>
                    {preview.preflight.checks.map((c) => (
                      <div key={c.id} className="kv" style={{ padding: '4px 0' }}>
                        <span title={c.detail}>{c.id}</span>
                        <b className={c.ok ? 'ok' : 'bad'}>{c.ok ? 'pass' : 'fail'}</b>
                      </div>
                    ))}
                    {preview.preflight.blockingReasons.map((r) => (
                      <div key={r} className="sub">
                        {r}
                      </div>
                    ))}
                  </div>
                )}
                <ErrorBox error={error} />
                <div className="actions">
                  <Btn tone="danger" arrow disabled={!running || !fail.supported} onClick={() => setConfirm(true)}>
                    Inject fault
                  </Btn>
                  <Btn tone="line" small disabled={!fail.supported} onClick={() => void doPreview()}>
                    Dry run
                  </Btn>
                </div>
                {!running && <div className="sub">Start the network first (Overview).</div>}
              </motion.div>
            )}
          </AnimatePresence>
        </aside>
      </div>
      <div className="stats">
        <Stat label="Target" tone={live ? 'bad' : undefined} sub={live ? 'Under fault' : 'Selected'}>
          {live ? (active?.nodeName.replace(`${network.name}-`, '') ?? node.label) : node.label}
        </Stat>
        <Stat label="Peer links" sub="Observed alive">
          <Num v={liveLinks(vnet)} />
        </Stat>
        <Stat label="Healthy nodes" sub={live ? 'During fault' : 'Now'}>
          <Num v={healthyCount(vnet)} />/{vnet.nodes.length}
        </Stat>
        <Stat label="Recent faults" sub={recentFaults[0] ? `${recentFaults[0].type} · ${recentFaults[0].state}` : 'None yet'}>
          <Num v={recentFaults.length} />
        </Stat>
      </div>
      <div className="actions">
        <Btn small tone="line" onClick={() => nav('/incidents')}>
          Fault evidence
        </Btn>
        <Btn small tone="line" onClick={() => nav('/scenarios')}>
          Scripted scenarios
        </Btn>
        <span className="sub" style={{ alignSelf: 'center' }}>
          Incident correlation <Planned phase="Phase 4" />
        </span>
      </div>
      <AnimatePresence>
        {confirm && (
          <motion.div className="modal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={() => setConfirm(false)}>
            <motion.div
              className="glass dialog"
              role="dialog"
              aria-modal
              aria-label="Confirm fault"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.26, ease }}
              onClick={(e) => e.stopPropagation()}
            >
              <h2>{fail.label}?</h2>
              <p>{warn} This runs against the real portaldot_dev process.</p>
              <div className="actions">
                <Btn onClick={() => setConfirm(false)}>Cancel</Btn>
                <Btn tone="danger" onClick={() => void inject()}>
                  Inject fault
                </Btn>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
