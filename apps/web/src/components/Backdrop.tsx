/**
 * Decorative backdrop (design import, T-3.6C): indigo gradient, glow,
 * flowing thin wave lines, a faint blurred watermark word and the
 * pointer-following hex field. Purely visual — no data.
 */

import { useEffect, useRef, type CSSProperties } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

const HEX = '0123456789abcdef';
const CELL = 72;

function Field() {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext?.('2d');
    if (!c || !ctx || reduce) return;
    let w = 0;
    let h = 0;
    let raf = 0;
    const m = { x: -999, y: -999, tx: -999, ty: -999 };
    let glyphs: string[] = [];
    const resize = () => {
      const d = window.devicePixelRatio || 1;
      w = window.innerWidth;
      h = window.innerHeight;
      c.width = w * d;
      c.height = h * d;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      glyphs = Array.from({ length: Math.ceil(w / CELL) * Math.ceil(h / CELL) }, () => HEX.charAt((Math.random() * 16) | 0) + HEX.charAt((Math.random() * 16) | 0));
    };
    const move = (e: PointerEvent) => {
      m.tx = e.clientX;
      m.ty = e.clientY;
      if (m.x < 0) {
        m.x = m.tx;
        m.y = m.ty;
      }
    };
    const draw = () => {
      m.x += (m.tx - m.x) * 0.055;
      m.y += (m.ty - m.y) * 0.055;
      ctx.clearRect(0, 0, w, h);
      const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, 260);
      g.addColorStop(0, 'rgba(169,138,255,.085)');
      g.addColorStop(1, 'rgba(169,138,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.font = '12px "Source Code Pro", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const cols = Math.ceil(w / CELL);
      glyphs.forEach((t, i) => {
        const x = (i % cols) * CELL + CELL / 2;
        const y = Math.floor(i / cols) * CELL + CELL / 2;
        const k = Math.max(0, 1 - Math.hypot(x - m.x, y - m.y) / 230);
        if (k > 0.01) {
          ctx.fillStyle = `rgba(224,210,255,${(k * k * 0.3).toFixed(3)})`;
          ctx.fillText(t, x, y);
        }
      });
      raf = requestAnimationFrame(draw);
    };
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', move);
    draw();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', move);
    };
  }, [reduce]);
  return <canvas ref={ref} className="field" />;
}

/** Flowing bundle of thin sine lines; drifts horizontally forever. */
export function Waves({ className = 'waves', count = 6, amp = 46, duration = 46, opacity = 1, style }: { className?: string; count?: number; amp?: number; duration?: number; opacity?: number; style?: CSSProperties }) {
  const reduce = useReducedMotion();
  const ops = [0.22, 0.15, 0.28, 0.11, 0.1, 0.08, 0.14, 0.06];
  const lines = Array.from({ length: count }, (_, k) => {
    const y = 110 + k * 13;
    const a = amp - k * 5;
    const x0 = -90 * k;
    let d = `M${x0} ${y}`;
    for (let p = 0; p < 4; p++) {
      const x = x0 + 800 * p;
      d += ` C${x + 130} ${y - a},${x + 270} ${y - a},${x + 400} ${y} C${x + 530} ${y + a},${x + 670} ${y + a},${x + 800} ${y}`;
    }
    return <path key={k} d={d} fill="none" stroke="#c9b5ff" strokeOpacity={(ops[k] ?? 0.08) * opacity} strokeWidth={1.1} />;
  });
  return (
    <div className={className} style={style} aria-hidden>
      <motion.svg width="3200" height="300" viewBox="0 0 3200 300" animate={reduce ? undefined : { x: [0, -800] }} transition={{ duration, repeat: Infinity, ease: 'linear' }}>
        {lines}
      </motion.svg>
    </div>
  );
}

export function Backdrop({ word = 'KAIZEN', field = true }: { word?: string; field?: boolean }) {
  return (
    <div className="bd" aria-hidden>
      <div className="glow" />
      <div className="glow2" />
      <Waves />
      {word && (
        <motion.div key={word} className="wm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8 }}>
          {word}
        </motion.div>
      )}
      {field && <Field />}
    </div>
  );
}
