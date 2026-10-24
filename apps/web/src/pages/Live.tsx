/**
 * Live drills (hosted console). The engine is not behind this deployment:
 * every drill runs on a fresh x86_64 GitHub Actions runner (a REAL two-node
 * portaldot_dev network, .github/workflows/live-drill.yml) and its signed
 * certificate bundle is published to the repo's `demo-data` branch.
 *
 * This page only READS that public data, and verifies it in the browser:
 *  1. recompute the run hash and certificate fingerprint (SHA-256 over the
 *     same canonical JSON as packages/engine),
 *  2. fetch the anchoring block from the Portaldot V3 TEST network and check
 *     the System.remark "kaizen:certificate:v1:<fingerprint>" is in it.
 * Nothing is simulated; a check that cannot be made says so.
 */

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Btn, Stat, ease } from '../components/ui';

const REPO = (import.meta.env?.['VITE_KAIZEN_REPO'] as string | undefined) ?? 'Shaydez-Defi/kaizen';
const DATA = `https://raw.githubusercontent.com/${REPO}/demo-data`;
const V3_RPC = 'https://test-node-v3.portaldot.dev';
const V3_BLOCK = (hash: string) => `https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/${hash}`;

interface DrillIndexItem {
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
  anchor: { status: string; reason?: string; blockHash?: string; blockNumber?: number; remark?: string; txHash?: string };
  workflow: { url: string } | null;
}

interface WfRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
}

type Check = { label: string; ok: boolean | null; detail: string };

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      const rec = value as Record<string, unknown>;
      const keys = Object.keys(rec)
        .filter((k) => rec[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`unsupported ${typeof value}`);
  }
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `0x${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const utf8Hex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function v3Rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(V3_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? 'rpc error');
  return body.result as T;
}

async function verifyBundle(b: Bundle): Promise<Check[]> {
  const checks: Check[] = [];
  const runHash = await sha256(canonicalJson({ kaizenAnchor: 1, run: b.run }));
  checks.push({ label: 'Run hash recomputed', ok: runHash === b.certificate.runHash, detail: runHash });
  const fp = await sha256(canonicalJson({ kaizenCertificate: 1, runHash, run: b.run, chain: b.certificate.chain }));
  checks.push({ label: 'Certificate fingerprint recomputed', ok: fp === b.certificate.fingerprint, detail: fp });
  if (b.anchor.status === 'finalized' || b.anchor.status === 'in-block') {
    try {
      const block = await v3Rpc<{ block: { header: { number: string }; extrinsics: string[] } }>('chain_getBlock', [b.anchor.blockHash]);
      const needle = utf8Hex(`kaizen:certificate:v1:${b.certificate.fingerprint}`);
      const found = block.block.extrinsics.some((x) => x.toLowerCase().includes(needle));
      const canon = await v3Rpc<string>('chain_getBlockHash', [parseInt(block.block.header.number, 16)]);
      checks.push({ label: 'Fingerprint remark found in V3 block', ok: found, detail: `block #${parseInt(block.block.header.number, 16)}` });
      checks.push({ label: 'Block is canonical on V3', ok: canon === b.anchor.blockHash, detail: canon });
    } catch (e) {
      checks.push({ label: 'V3 anchor', ok: null, detail: `could not reach V3: ${(e as Error).message}` });
    }
  } else {
    checks.push({ label: 'V3 anchor', ok: null, detail: b.anchor.reason ?? `anchor ${b.anchor.status}` });
  }
  checks.push({
    label: 'Signer',
    ok: null,
    detail: b.certificate.signature.dev ? 'public DEV key — proves integrity, not operator identity' : b.certificate.signature.address,
  });
  return checks;
}

function DrillCard({ item }: { item: DrillIndexItem }) {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`${DATA}/drills/${item.id}.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`bundle HTTP ${r.status}`);
    const b = (await r.json()) as Bundle;
    setBundle(b);
    return b;
  }, [item.id]);

  const verify = async () => {
    setBusy(true);
    setErr(null);
    try {
      setChecks(await verifyBundle(bundle ?? (await load())));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const m = bundle?.certificate.chain.metrics;
  return (
    <motion.div className="glass card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease }} aria-label={`Drill ${item.id}`}>
      <div className="lab">
        <span className={`dot ${item.recovered ? '' : 'bad'}`} />
        Pause drill · {item.validatorId} · {new Date(item.publishedAt).toLocaleString()}
      </div>
      <div className="grid2" style={{ marginTop: 8 }}>
        <Stat label="Recovered" tone={item.recovered ? 'ok' : 'bad'}>
          {item.recovered ? 'yes' : 'no'}
        </Stat>
        <Stat label="Time to recover" sub="finality advancing again">
          {item.timeToRecoverMs !== null ? `${(item.timeToRecoverMs / 1000).toFixed(1)} s` : '—'}
        </Stat>
        <Stat label="Finality gap">{item.finalityGapBlocks ?? '—'} blocks</Stat>
        <Stat label="Resilience score">{item.score ?? '—'}</Stat>
      </div>
      <div className="kv">
        <span>Fingerprint</span>
        <b className="mono-s">{item.fingerprint}</b>
      </div>
      <div className="kv">
        <span>V3 anchor</span>
        <b className="mono-s">
          {item.anchor.status}
          {item.anchor.blockNumber !== null ? ` · block #${item.anchor.blockNumber}` : ''}
          {bundle?.anchor.blockHash && (
            <>
              {' '}
              <a className="ext" href={V3_BLOCK(bundle.anchor.blockHash)} target="_blank" rel="noreferrer">
                node console
              </a>
            </>
          )}
        </b>
      </div>
      {item.workflowUrl && (
        <div className="kv">
          <span>Runner log</span>
          <b className="mono-s">
            <a className="ext" href={item.workflowUrl} target="_blank" rel="noreferrer">
              GitHub Actions run
            </a>
          </b>
        </div>
      )}
      {bundle && (
        <div className="sub mono-s" style={{ marginTop: 8 }} aria-label="Chain observations">
          {bundle.certificate.chain.observations.map((o, i) => (
            <div key={i}>
              {o.phase}: best #{o.best.number} · finalized #{o.finalized.number} ({o.finalized.hash.slice(0, 12)}…)
            </div>
          ))}
          {m && m.blocksMissed !== null && <div>blocks missed: {m.blocksMissed}</div>}
        </div>
      )}
      <div className="actions" style={{ marginTop: 12 }}>
        <Btn tone="pri" onClick={verify} disabled={busy}>
          {busy ? 'Verifying…' : 'Verify in browser'}
        </Btn>
        {!bundle && <Btn onClick={() => void load().catch((e) => setErr((e as Error).message))}>Show evidence</Btn>}
      </div>
      {err && <div className="sub bad">{err}</div>}
      {checks && (
        <div style={{ marginTop: 10 }} aria-label="Verification">
          {checks.map((c) => (
            <div key={c.label} className={c.ok === false ? 'wbox' : c.ok ? 'okbox' : 'sub'} style={{ marginTop: 6 }}>
              <b>{c.ok === null ? '•' : c.ok ? '✓' : '✗'} {c.label}</b> <span className="mono-s">{c.detail}</span>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

export function Live() {
  const [items, setItems] = useState<DrillIndexItem[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [runs, setRuns] = useState<WfRun[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${DATA}/index.json?t=${Date.now()}`, { cache: 'no-store' });
      if (r.status === 404) setItems([]);
      else if (!r.ok) throw new Error(`HTTP ${r.status}`);
      else setItems(((await r.json()) as { drills: DrillIndexItem[] }).drills);
      setLoadErr(null);
    } catch (e) {
      setLoadErr((e as Error).message);
    }
    try {
      const w = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/live-drill.yml/runs?per_page=3`);
      if (w.ok) setRuns(((await w.json()) as { workflow_runs: WfRun[] }).workflow_runs);
    } catch {
      /* the runner status is optional */
    }
  }, []);

  const active = runs.find((r) => r.status !== 'completed');
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), active ? 15_000 : 60_000);
    return () => clearInterval(t);
  }, [refresh, active]);

  const start = async () => {
    setStarting(true);
    setMsg(null);
    try {
      const r = await fetch('/api/live-drill', { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      setMsg(r.ok ? 'Drill queued. A fresh runner is booting two portaldot_dev validators; the certificate lands here in about 5–8 minutes.' : body.error ?? `HTTP ${r.status}`);
      setTimeout(() => void refresh(), 5000);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <div className="head">
        <div>
          <div className="lab ok">Hosted · drills run on GitHub Actions · anchored on Portaldot V3</div>
          <h1>Live drills</h1>
          <p>
            Each drill boots a real two-node portaldot_dev network on a fresh runner, pauses a validator, records the chain&apos;s own block hashes before,
            during and after, and only declares recovery when GRANDPA finality advances again. The signed certificate is anchored on the V3 test network.
            Verify any of them right here.
          </p>
        </div>
        <div className="actions">
          <Btn tone="pri" arrow onClick={start} disabled={starting || Boolean(active)}>
            {active ? 'Drill running…' : starting ? 'Starting…' : 'Run a drill'}
          </Btn>
        </div>
      </div>
      {msg && (
        <div className="okbox" role="status">
          {msg}
        </div>
      )}
      {active && (
        <div className="wbox" role="status">
          Runner {active.status.replace('_', ' ')} ·{' '}
          <a className="ext" href={active.html_url} target="_blank" rel="noreferrer">
            watch the live log
          </a>
        </div>
      )}
      {loadErr && <div className="errbox">Could not load published drills ({loadErr})</div>}
      {items && items.length === 0 && <div className="sub">No drills published yet. Run the first one.</div>}
      <div className="list" aria-label="Published drills" style={{ display: 'grid', gap: 16 }}>
        {items?.map((it) => <DrillCard key={it.id} item={it} />)}
      </div>
    </>
  );
}
