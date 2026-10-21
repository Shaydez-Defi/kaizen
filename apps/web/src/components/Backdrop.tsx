import { useEffect, useRef } from 'react'
import { motion, useReducedMotion } from 'framer-motion'

const HEX = '0123456789abcdef'
const CELL = 72

function Field() {
  const ref = useRef<HTMLCanvasElement>(null)
  const reduce = useReducedMotion()
  useEffect(() => {
    const c = ref.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx || reduce) return
    let w = 0, h = 0, raf = 0
    const m = { x: -999, y: -999, tx: -999, ty: -999 }
    let glyphs: string[] = []
    const resize = () => {
      const d = window.devicePixelRatio || 1
      w = window.innerWidth; h = window.innerHeight
      c.width = w * d; c.height = h * d; ctx.setTransform(d, 0, 0, d, 0, 0)
      glyphs = Array.from({ length: Math.ceil(w / CELL) * Math.ceil(h / CELL) }, () => HEX.charAt((Math.random() * 16) | 0) + HEX.charAt((Math.random() * 16) | 0))
    }
    const move = (e: PointerEvent) => { m.tx = e.clientX; m.ty = e.clientY; if (m.x < 0) { m.x = m.tx; m.y = m.ty } }
    const draw = () => {
      m.x += (m.tx - m.x) * 0.055; m.y += (m.ty - m.y) * 0.055
      ctx.clearRect(0, 0, w, h)
      const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, 260)
      g.addColorStop(0, 'rgba(169,138,255,.085)'); g.addColorStop(1, 'rgba(169,138,255,0)')
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h)
      ctx.font = '12px "Source Code Pro", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      const cols = Math.ceil(w / CELL)
      glyphs.forEach((t, i) => {
        const x = (i % cols) * CELL + CELL / 2, y = Math.floor(i / cols) * CELL + CELL / 2
        const k = Math.max(0, 1 - Math.hypot(x - m.x, y - m.y) / 230)
        if (k > 0.01) { ctx.fillStyle = `rgba(224,210,255,${(k * k * 0.3).toFixed(3)})`; ctx.fillText(t, x, y) }
      })
      raf = requestAnimationFrame(draw)
    }
    resize(); window.addEventListener('resize', resize); window.addEventListener('pointermove', move); draw()
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); window.removeEventListener('pointermove', move) }
  }, [reduce])
  return <canvas ref={ref} className="field" />
}

function Waves() {
  const lines = Array.from({ length: 6 }, (_, k) => {
    const y = 110 + k * 15, a = 46 - k * 5, x0 = -90 * k
    let d = `M${x0} ${y}`
    for (let p = 0; p < 4; p++) { const x = x0 + 800 * p; d += ` C${x + 130} ${y - a},${x + 270} ${y - a},${x + 400} ${y} C${x + 530} ${y + a},${x + 670} ${y + a},${x + 800} ${y}` }
    return <path key={k} d={d} fill="none" stroke="#c9b5ff" strokeOpacity={[0.2, 0.14, 0.26, 0.1, 0.09, 0.07][k]} strokeWidth={1.2} />
  })
  return (
    <div className="waves">
      <motion.svg width="3200" height="300" viewBox="0 0 3200 300" animate={{ x: [0, -800] }} transition={{ duration: 46, repeat: Infinity, ease: 'linear' }}>{lines}</motion.svg>
    </div>
  )
}

export function Backdrop() {
  return (
    <div className="bd" aria-hidden>
      <div className="glow" />
      <Waves />
      <div className="wm">
        {'KAIZEN'.split('').map((ch, i) => (
          <motion.span key={i} initial={{ filter: 'blur(10px)' }} whileHover={{ filter: 'blur(1px)', color: 'rgba(215,195,255,.22)' }} transition={{ duration: 0.9, ease: [0.16, 0.68, 0.43, 0.99] }}>{ch}</motion.span>
        ))}
      </div>
      <Field />
    </div>
  )
}
