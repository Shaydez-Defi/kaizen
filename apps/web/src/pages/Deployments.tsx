/**
 * Deployments (design import, T-3.6B). Local-process deployment is what the
 * engine runs today and is shown with REAL per-node process data. Docker
 * and Kubernetes/Helm adapters are Phase 6 (planned scope, spec §6.6) and
 * are disabled with that label — no generated manifests, no fake pods.
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Btn, NoNet, Planned, Seg, ease } from '../components/ui';
import { formatUptime } from '../components/fmt';
import { healthyCount } from '../lib/model';
import { useConsole } from '../state/ConsoleContext';

type Target = 'Local' | 'Docker' | 'Kubernetes';

export function Deployments() {
  const nav = useNavigate();
  const { vnet, network } = useConsole();
  const [t, setT] = useState<Target>('Local');
  if (!vnet || !network) return <NoNet />;
  const running = vnet.nodes.filter((v) => v.record.status === 'running').length;
  const n = vnet.nodes.length;
  return (
    <div className="split">
      <div>
        <div className={`lab ${running === n ? 'ok' : ''}`}>Deployment target</div>
        <h1>{t === 'Local' ? (running ? 'Running as local processes' : 'Local processes (stopped)') : `Deploy to ${t}`}</h1>
        <Seg
          id="tg"
          label="Deployment target"
          value={t}
          onChange={setT}
          items={[
            { v: 'Local', l: 'Local' },
            { v: 'Docker', l: 'Docker', disabled: true, title: 'Planned — Phase 6' },
            { v: 'Kubernetes', l: 'Kubernetes', disabled: true, title: 'Planned — Phase 6' },
          ]}
        />
        <div className="sub" style={{ marginTop: 10 }}>
          Docker and Kubernetes/Helm adapters <Planned phase="Phase 6" />
        </div>
        <div className="kvs">
          <div className="kv">
            <span>Network</span>
            <b>{network.name}</b>
          </div>
          <div className="kv">
            <span>Chain</span>
            <b className="mono-s">{network.chain}</b>
          </div>
          <div className="kv">
            <span>Data directory</span>
            <b className="mono-s">{network.baseDir}</b>
          </div>
          <div className="kv">
            <span>Designated test network</span>
            <b className={network.designatedTest ? 'ok' : 'bad'}>{network.designatedTest ? 'yes' : 'no'}</b>
          </div>
        </div>
        <Btn tone="pri" arrow onClick={() => nav('/overview')}>
          View network
        </Btn>
      </div>
      <aside className="glass panel">
        <div className="lab">
          Local · {running} of {n} processes running
        </div>
        <div className="bar">
          <motion.i animate={{ width: `${n ? (running / n) * 100 : 0}%` }} transition={{ duration: 0.5, ease }} />
        </div>
        {vnet.nodes.map((v) => (
          <div className="kv" key={v.id}>
            <span>
              <b>{v.label}</b>
              <br />
              <small className="sub">
                {v.record.pid ? `pid ${v.record.pid}` : 'no process'} · up {formatUptime(v.sample?.uptimeMs)}
              </small>
            </span>
            <motion.span key={v.record.status} className={`chip ${v.record.status === 'running' ? 'running' : v.record.status === 'starting' ? 'deploying' : 'pending'}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease }}>
              {v.record.status}
            </motion.span>
          </div>
        ))}
        <div className="sub">
          Health {healthyCount(vnet)} of {n}
        </div>
      </aside>
    </div>
  );
}
