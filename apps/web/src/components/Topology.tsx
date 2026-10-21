/**
 * Network topology stage (design import, T-3.6B) rendering REAL nodes.
 * Edges are the engine's expected full mesh; solid/pulsing = link observed
 * alive by monitoring, dashed red = not observed (see lib/model.ts).
 * The per-node bar shows connected peers out of the expected peer count.
 */

import { motion } from 'framer-motion';
import type { VNet } from '../lib/model';
import { ease } from './ui';

const W = 760;
const H = 300;
const Y = 190;

export function Topology({ net, sel, onSelect }: { net: VNet; sel?: string; onSelect?: (id: string) => void }) {
  const nodes = net.nodes;
  const n = nodes.length;
  const X = (i: number) => ((i + 0.5) / Math.max(n, 1)) * W;
  const idx = new Map(nodes.map((v, i) => [v.id, i]));
  return (
    <div className="stage" data-testid="topology">
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden>
        {net.edges.map((e) => {
          const i = idx.get(e.a) ?? 0;
          const j = idx.get(e.b) ?? 0;
          const d = Math.abs(j - i);
          const h = Math.min(30 + d * 46, 170);
          const p = `M${X(i)} ${Y} C${X(i)} ${Y - h * 1.33} ${X(j)} ${Y - h * 1.33} ${X(j)} ${Y}`;
          return (
            <g key={`${e.a}-${e.b}`} data-edge={e.basis}>
              <motion.path
                d={p}
                fill="none"
                strokeWidth={1.4}
                strokeDasharray={e.alive ? '0' : '3 7'}
                initial={false}
                animate={{ stroke: e.alive ? 'rgba(190,160,255,.3)' : 'rgba(255,107,94,.6)' }}
                transition={{ duration: 0.6, ease }}
              />
              {e.alive && (
                <motion.path
                  d={p}
                  pathLength={1}
                  className="pulse"
                  initial={{ strokeDashoffset: 0 }}
                  animate={{ strokeDashoffset: -0.5 }}
                  transition={{ duration: 2.6 + d * 1.1, repeat: Infinity, ease: 'linear' }}
                />
              )}
            </g>
          );
        })}
      </svg>
      {nodes.map((v, i) => {
        const bars = Math.min(Math.max(v.expectedPeers, 0), 16);
        return (
          <motion.button
            type="button"
            key={v.id}
            className={`node ${v.state === 'offline' ? 'bad' : ''} ${v.state === 'recovering' ? 'rec' : ''} ${v.state === 'paused' ? 'pau' : ''} ${sel === v.id ? 'sel' : ''}`}
            style={{ left: `${(X(i) / W) * 100}%`, x: '-50%', width: n > 5 ? 112 : 132 }}
            whileHover={{ y: -3 }}
            whileTap={{ scale: 0.985 }}
            transition={{ duration: 0.2, ease }}
            onClick={() => onSelect?.(v.id)}
            disabled={!onSelect}
            aria-label={`${v.name}, ${v.stateLabel}`}
          >
            <span className="nh">
              <span className="ni">{String(i + 1).padStart(2, '0')}</span>
              <motion.span key={v.stateLabel} className="nc" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease }}>
                {v.stateLabel}
              </motion.span>
            </span>
            <span className="nl">
              {v.label} · {v.role} · {v.peers ?? '—'} peers
            </span>
            {bars > 0 && (
              <span className="nk" title={`${v.peers ?? 0} of ${v.expectedPeers} expected peers`}>
                {Array.from({ length: bars }, (_, k) => (
                  <b key={k} className={k >= (v.peers ?? 0) ? 'm' : ''} />
                ))}
              </span>
            )}
            <span className="nm">{v.height !== null ? `#${v.height.toLocaleString('en-US')}` : '# —'}</span>
          </motion.button>
        );
      })}
    </div>
  );
}
