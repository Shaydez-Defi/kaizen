/**
 * Live proof of resilience (public, no Kaizen API behind it).
 *
 * Drills run on GitHub Actions (.github/workflows/drill-live.yml): a fresh
 * x86_64 runner boots a REAL two-node portaldot_dev network, pauses a
 * validator, reads recovery from GRANDPA finality, certifies the run, anchors
 * the fingerprint on the Portaldot V3 TEST network (System.remark, when the
 * signer secret is set) and publishes the bundle to the `demo-data` branch.
 *
 * This page only reads that public data and re-checks it in the browser:
 * run hash + certificate fingerprint recomputed (same canonical JSON and
 * SHA-256 as packages/engine), and the V3 block fetched now to find the
 * remark. Nothing here is mocked; a check that cannot be made says so.
 */

import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { consoleBlockUrl } from './Landing';

const OWNER = 'Shaydez-Defi';
const NAME = 'kaizen';
const REPO = `https://github.com/${OWNER}/${NAME}`;
const DATA = `https://raw.githubusercontent.com/${OWNER}/${NAME}/demo-data`;
const RUNS = `https://api.github.com/repos/${OWNER}/${NAME}/actions/workflows/drill-live.yml/runs?per_page=6`;
const V3_RPC = 'https://test-node-v3.portaldot.dev';
const DRILL_API = (import.meta.env?.['VITE_KAIZEN_DRILL_API'] as string | undefined) ?? '/api/drill';

interface IndexItem {
  id: string;
  publishedAt: string;
  fingerprint: string;
  validatorId: string;
  recovered: boolean | null;
  timeToRecoverMs: number | null;
  finalityGapBlocks: number | null;
  score: number | null;
  anchor: { status: string; blockNumber: number | null };
  workflowUrl: string | null;
}
interface BlockRef {
  number: number;
  hash: string;
}
interface Bundle {
  id: string;
  publishedAt: string;
  certificate: {
    fingerprint: string;
    runHash: string;
    validatorId: string;
    chain: {
      observations: { phase: string; at: string; best: BlockRef; finalized: BlockRef }[];
      metrics: { recovered: boolean; timeToRecoverMs: number | null; finalityGapBlocks: number | null; blocksMissed: number | null };
    };
    signature: { address: string; dev: boolean };
  };
  run: unknown;
  verificationOnline: { status: string; reasons: string[] } | null;
  score: { score: number } | null;
  anchor: { status: string; reason?: string; blockHash?: string; blockNumber?: number };
  workflow: { url: string } | null;
}
interface WfRun {
  id: number;
  status: string;
  event: string;
  html_url: string;
  created_at: string;
  run_started_at?: string;
}
interface Check {
  label: string;
  ok: boolean | null;
  detail: string;
}

function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new Error(`unsupported ${typeof v}`);
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `0x${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
const utf8Hex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function v3<T>(method: string, params: unknown[]): Promise<T> {
  const r = await (await fetch(V3_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(r.error.message);
  return r.result as T;
}

async function verify(b: Bundle): Promise<Check[]> {
  const out: Check[] = [];
  const runHash = await sha256(canonicalJson({ kaizenAnchor: 1, run: b.run }));
  out.push({ label: 'Run hash recomputed', ok: runHash === b.certificate.runHash, detail: runHash });
  const fp = await sha256(canonicalJson({ kaizenCertificate: 1, runHash, run: b.run, chain: b.certificate.chain }));
  out.push({ label: 'Certificate fingerprint recomputed', ok: fp === b.certificate.fingerprint, detail: fp });
  const online = b.verificationOnline;
  out.push({
    label: 'Block hashes matched the dev chain during the run',
    ok: online ? online.status === 'verified' : null,
    detail: online ? (online.reasons[0] ?? online.status) : 'not recorded',
  });
  if (b.anchor.status === 'in-block' || b.anchor.status === 'finalized') {
    try {
      const blk = await v3<{ block: { header: { number: string }; extrinsics: string[] } } | null>('chain_getBlock', [b.anchor.blockHash]);
      const needle = utf8Hex(`kaizen:certificate:v1:${b.certificate.fingerprint}`);
      const found = Boolean(blk) && blk!.block.extrinsics.some((x) => x.toLowerCase().includes(needle));
      out.push({
        label: 'Fingerprint found on Portaldot V3 (fetched now)',
        ok: found,
        detail: blk ? `block #${Number.parseInt(blk.block.header.number, 16)}` : 'block not found',
      });
    } catch (e) {
      out.push({ label: 'Fingerprint found on Portaldot V3 (fetched now)', ok: null, detail: `V3 node unreachable: ${(e as Error).message}` });
    }
  } else {
    out.push({ label: 'Anchored on Portaldot V3', ok: null, detail: b.anchor.reason ?? b.anchor.status });
  }
  return out;
}

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const mark = (ok: boolean | null) => (ok === true ? <span className="ok">✓</span> : ok === false ? <span className="bad">✗</span> : <span className="warn">–</span>);
const secs = (ms: number | null) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);

/** Next run of the workflow schedule: minute 17 of every third UTC hour. */
function nextScheduled(): Date {
  const now = new Date();
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 17));
  while (t <= now || t.getUTCHours() % 3 !== 0) t.setUTCHours(t.getUTCHours() + 1);
  return t;
}

const footnote = { fontSize: 12.5, marginTop: 10, color: '#e4dcff' } as const;

export function Live(): JSX.Element {
  const [items, setItems] = useState<IndexItem[] | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [runs, setRuns] = useState<WfRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [req, setReq] = useState<{ state: 'idle' | 'busy' | 'ok' | 'no'; text?: string }>({ state: 'idle' });

  const loadIndex = useCallback(async () => {
    try {
      const r = await fetch(`${DATA}/index.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status === 404 ? 'No drill has been published yet. The first one is running now.' : `HTTP ${r.status}`);
      const idx = (await r.json()) as { drills: IndexItem[] };
      setItems(idx.drills);
      setSelected((s) => s ?? idx.drills[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const loadRuns = useCallback(async () => {
    try {
      const r = await fetch(RUNS);
      if (r.ok) setRuns(((await r.json()) as { workflow_runs: WfRun[] }).workflow_runs);
    } catch {
      /* runner status is optional */
    }
  }, []);

  const active = runs?.find((r) => r.status !== 'completed');
  useEffect(() => {
    void loadIndex();
    void loadRuns();
    const t = setInterval(() => {
      void loadRuns();
      if (active) void loadIndex();
    }, 30_000);
    return () => clearInterval(t);
  }, [loadIndex, loadRuns, active]);

  useEffect(() => {
    if (!selected) return;
    setBundle(null);
    setChecks(null);
    void (async () => {
      try {
        const b = (await (await fetch(`${DATA}/drills/${selected}.json`)).json()) as Bundle;
        setBundle(b);
        setChecks(await verify(b));
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [selected]);

  const runNow = async () => {
    setReq({ state: 'busy' });
    try {
      const r = await fetch(DRILL_API, { method: 'POST' });
      const body = (await r.json().catch(() => ({}))) as { message?: string };
      setReq({ state: r.ok ? 'ok' : 'no', text: body.message ?? (r.ok ? 'Drill requested.' : `Not available (HTTP ${r.status})`) });
      setTimeout(() => void loadRuns(), 4000);
    } catch {
      setReq({ state: 'no', text: 'On-demand drills are not enabled on this deployment.' });
    }
  };

  const m = bundle?.certificate.chain.metrics;
  return (
    <div className="landing" id="top">
      <div className="wrap">
        <header className="lnav">
          <Link to="/" className="brand">
            KAIZEN
          </Link>
          <nav aria-label="Live">
            <a href="#latest">Latest drill</a>
            <a href="#history">History</a>
            <a href={`${REPO}#readme`} target="_blank" rel="noreferrer">
              Docs
            </a>
          </nav>
          <a className="btn pri" href={`${REPO}/actions/workflows/drill-live.yml`} target="_blank" rel="noreferrer">
            Watch drills run
          </a>
        </header>

        <section className="hero" style={{ display: 'block', paddingBottom: 24 }}>
          <div className="eyebrow">Live proof of resilience</div>
          <h1>
            We break a validator.
            <br />
            <span className="g">The chain proves it came back.</span>
          </h1>
          <p style={{ maxWidth: 760 }}>
            Every three hours a GitHub runner boots a real two-node Portaldot network, pauses a validator, and reads recovery from GRANDPA finality. The run is
            certified and its fingerprint is written to the Portaldot V3 test network. This page re-checks each one in your browser. Nothing here is mocked.
          </p>
          <div className="glass card" style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center', justifyContent: 'space-between', marginTop: 18 }}>
            {active ? (
              <span>
                <span className="chip warn">Drill running now</span>{' '}
                <span>
                  started {ago(active.run_started_at ?? active.created_at)} · {active.event}
                </span>{' '}
                <a href={active.html_url} target="_blank" rel="noreferrer">
                  watch the live log →
                </a>
              </span>
            ) : (
              <span>
                <span className="chip ok">Idle</span> <span>next scheduled drill {nextScheduled().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </span>
            )}
            <span style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              {req.text && <span className={req.state === 'ok' ? 'ok' : ''}>{req.text}</span>}
              <button className="btn sm line" type="button" disabled={req.state === 'busy' || Boolean(active)} onClick={() => void runNow()}>
                {req.state === 'busy' ? 'Requesting…' : 'Run a drill now'}
              </button>
            </span>
          </div>
        </section>

        {error && !items && (
          <div className="glass card" style={{ marginBottom: 24 }}>
            {error}
          </div>
        )}

        {bundle && m && (
          <section id="latest" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 20, marginBottom: 28, alignItems: 'start' }}>
            <div className="glass card">
              <div className="lab">Drill {items?.[0]?.id === bundle.id ? '(latest)' : ''}</div>
              <h2 style={{ margin: '6px 0 2px' }}>{m.recovered ? 'Recovered' : 'Did not recover'}</h2>
              <div>
                validator {bundle.certificate.validatorId} · {ago(bundle.publishedAt)}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
                <div>
                  <div className="dim">Time to recover</div>
                  <b>{secs(m.timeToRecoverMs)}</b>
                </div>
                <div>
                  <div className="dim">Finality gap</div>
                  <b>{m.finalityGapBlocks ?? '—'} blocks</b>
                </div>
                <div>
                  <div className="dim">Blocks missed</div>
                  <b>{m.blocksMissed ?? '—'}</b>
                </div>
                <div>
                  <div className="dim">Resilience score</div>
                  <b>{bundle.score?.score ?? '—'}/100</b>
                </div>
              </div>
              <div className="mono-s" style={{ marginTop: 14 }}>
                fingerprint {bundle.certificate.fingerprint}
              </div>
              <div style={footnote}>
                The score grows with repeated certified drills; one drill caps confidence. Signed with{' '}
                {bundle.certificate.signature.dev ? 'the public dev key (integrity, not operator identity).' : bundle.certificate.signature.address}
              </div>
            </div>

            <div className="glass card">
              <div className="lab">Verified in your browser</div>
              {!checks && <div>checking…</div>}
              {checks?.map((c) => (
                <div key={c.label} style={{ display: 'flex', gap: 10, margin: '10px 0' }}>
                  <b style={{ width: 18, flex: 'none', fontSize: 16 }}>{mark(c.ok)}</b>
                  <div style={{ minWidth: 0 }}>
                    <div>{c.label}</div>
                    <div className="mono-s">{c.detail}</div>
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {bundle.anchor.blockHash && (
                  <a className="btn sm pri" href={consoleBlockUrl(bundle.anchor.blockHash)} target="_blank" rel="noreferrer">
                    V3 block #{bundle.anchor.blockNumber}
                  </a>
                )}
                {bundle.workflow && (
                  <a className="btn sm line" href={bundle.workflow.url} target="_blank" rel="noreferrer">
                    Runner log
                  </a>
                )}
                <a className="btn sm line" href={`${DATA}/drills/${bundle.id}.json`} target="_blank" rel="noreferrer">
                  Raw bundle
                </a>
              </div>
            </div>

            <div className="glass card">
              <div className="lab">What the chain recorded</div>
              <table style={{ width: '100%', fontSize: 13, marginTop: 8 }}>
                <thead>
                  <tr className="dim">
                    <td>phase</td>
                    <td>best</td>
                    <td>finalized</td>
                  </tr>
                </thead>
                <tbody>
                  {bundle.certificate.chain.observations.map((o, i) => (
                    <tr key={i}>
                      <td>{o.phase}</td>
                      <td>#{o.best.number}</td>
                      <td title={o.finalized.hash}>
                        #{o.finalized.number} <span className="mono-s">· {short(o.finalized.hash)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={footnote}>Recovery is declared only when finality advances past where it stalled.</div>
            </div>
          </section>
        )}

        {items && (
          <section id="history" className="glass card" style={{ marginBottom: 40 }}>
            <div className="lab">Drill history ({items.length})</div>
            <table style={{ width: '100%', fontSize: 13, marginTop: 8 }}>
              <thead>
                <tr className="dim">
                  <td>when</td>
                  <td>validator</td>
                  <td>recovered</td>
                  <td>time</td>
                  <td>V3 anchor</td>
                  <td>fingerprint</td>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} onClick={() => setSelected(it.id)} style={{ cursor: 'pointer', fontWeight: it.id === selected ? 700 : 400 }}>
                    <td>{ago(it.publishedAt)}</td>
                    <td>{it.validatorId}</td>
                    <td style={{ fontSize: 16 }}>{mark(it.recovered)}</td>
                    <td>{secs(it.timeToRecoverMs)}</td>
                    <td>{it.anchor.blockNumber ? `#${it.anchor.blockNumber}` : it.anchor.status}</td>
                    <td className="mono-s">{short(it.fingerprint)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <footer style={{ padding: '24px 0 48px', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <span>© 2026 Kaizen · Portaldot Hacker House 2026</span>
          <span style={{ display: 'flex', gap: 16 }}>
            <Link to="/">Home</Link>
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href="#top">Back to top ↑</a>
          </span>
        </footer>
      </div>
    </div>
  );
}
