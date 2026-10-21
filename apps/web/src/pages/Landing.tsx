/** Landing (design import, T-3.6B). Real control-plane status; accurate quickstart. */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client';
import { useAsync } from '../state/useAsync';
import { Btn, ease } from '../components/ui';

const QUICKSTART = 'npm install && npm run build';
const COMMANDS = [
  'node packages/cli/dist/index.js setup',
  'node packages/cli/dist/index.js network create demo --preset two-node',
  'node packages/cli/dist/index.js network start demo',
  'node packages/cli/dist/index.js run execute <scenarioId> -n demo',
  'node packages/cli/dist/index.js v3 anchor <runId>',
];

const FLOW: [string, string, string?][] = [
  ['Create', 'Pick a preset; Kaizen spawns real portaldot_dev nodes.'],
  ['Monitor', 'Peers, heads, finality and health from real RPC.'],
  ['Break', 'Pause or terminate nodes on purpose, gated to test networks.'],
  ['Diagnose', 'Fault evidence and run history today; incident correlation next.', 'Phase 4'],
  ['Recover', 'Faults roll back and recovery is verified independently.'],
  ['Deploy', 'Local processes today; Docker and Kubernetes adapters next.', 'Phase 6'],
];

export function Landing() {
  const nav = useNavigate();
  const [copied, setCopied] = useState(false);
  const health = useAsync((_s) => apiClient.health({ timeoutMs: 4000 }), []);
  const copy = () => {
    navigator.clipboard?.writeText(QUICKSTART).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  const cp = health.data ? (
    <span className="ok">Control plane connected · v{health.data.version}</span>
  ) : health.loading ? (
    <span className="muted">Checking control plane…</span>
  ) : (
    <span className="bad">Control plane unreachable — start it with node apps/api/dist/index.js</span>
  );
  return (
    <div className="landing">
      <header className="lnav">
        <span className="brand">KAIZEN</span>
        <nav>
          <a href="#flow">Lifecycle</a>
          <a href="#flow">Failure Lab</a>
          <a href="#flow">Portaldot V3</a>
        </nav>
        <Btn tone="pri" arrow onClick={() => nav('/overview')}>
          Launch console
        </Btn>
      </header>
      <section className="hero">
        <div>
          <motion.h1 initial={{ opacity: 0, y: 14, filter: 'blur(8px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.7, ease }}>
            Break Portaldot networks
            <br />
            on purpose. Prove it on chain.
          </motion.h1>
          <p>
            Real node lifecycle, live monitoring, a gated Failure Lab with replayable scenarios, and every finished run fingerprinted and anchored on the Portaldot V3
            testnet.
          </p>
          <div className="cmd">
            <code>
              <span>$</span> {QUICKSTART}
            </code>
            <button type="button" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="hint">{cp}</div>
        </div>
        <div className="glass term">
          <div className="lab">CLI — same engine as this console</div>
          {COMMANDS.map((l, i) => (
            <motion.div key={l} className="mono" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.3 + i * 0.25, duration: 0.4, ease }}>
              <span className="ok">$</span> {l}
            </motion.div>
          ))}
        </div>
      </section>
      <section id="flow" className="flow">
        <h2>One lifecycle, start to finish</h2>
        <ol>
          {FLOW.map(([t, d, planned], i) => (
            <motion.li key={t} whileHover={{ y: -6 }} transition={{ duration: 0.2, ease }}>
              <motion.i whileHover={{ scale: 1.08 }}>{i + 1}</motion.i>
              <b>{t}</b>
              <span>{d}</span>
              {planned && <span className="planned" style={{ marginTop: 8 }}>{planned}</span>}
            </motion.li>
          ))}
        </ol>
      </section>
      <footer className="lfoot">
        <span className="brand">KAIZEN</span>
        <span>Portaldot node operations and infrastructure platform.</span>
        {cp}
      </footer>
    </div>
  );
}
