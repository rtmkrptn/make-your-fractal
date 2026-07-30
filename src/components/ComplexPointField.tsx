import { useEffect, useRef, useState } from 'react'
import { TextInput } from '@primer/react'

interface Props {
  value: { re: number; im: number }
  onChange: (v: { re: number; im: number }) => void
  range?: number
}

// Internal SVG coordinate system — independent of the rendered size, which is
// now fully responsive (see .complex-plane in App.css). Kept large so stroke
// widths stay crisp when the plane is stretched to fill the sidebar's width.
const SIZE = 300
const TICKS = [-1, -0.5, 0, 0.5, 1]

// Primer v9 exposes its resolved palette as CSS custom properties on the
// document (set up by ThemeProvider/BaseStyles), so raw SVG attributes can
// stay theme-aware without reaching into the theme object's internal shape.
const PLANE_BG = 'var(--bgColor-muted, #f6f8fa)'
const PLANE_BORDER = 'var(--borderColor-default, #d1d9e0)'
const PLANE_AXIS = 'var(--fgColor-muted, #59636e)'
const PLANE_POINT = 'var(--fgColor-accent, #0969da)'
const PLANE_POINT_STROKE = 'var(--bgColor-default, #fff)'

// A tiny Desmos-style plane: drag or click anywhere on it to place c, or type
// exact values below. `range` is the half-extent shown (in complex-plane units).
export function ComplexPointField({ value, onChange, range = 2 }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)

  // Text shown in the two inputs is kept separate from the committed numeric
  // `value` so the field can be cleared to empty (or sit on a partial value
  // like "-" or "1.") without snapping back to a number every keystroke.
  // Only synced from `value` when it actually changes from elsewhere (drag,
  // preset), never as a reaction to our own commit below.
  const [reText, setReText] = useState(String(value.re))
  const [imText, setImText] = useState(String(value.im))

  useEffect(() => setReText(String(value.re)), [value.re])
  useEffect(() => setImText(String(value.im)), [value.im])

  // While the text is empty or not a finished number, don't commit anything —
  // the shader keeps rendering with whatever `c` it last had, rather than
  // being forced through 0 on every keystroke of clearing the field.
  const commitRe = (text: string) => {
    setReText(text)
    const n = Number(text)
    if (text.trim() !== '' && Number.isFinite(n)) onChange({ ...value, re: n })
  }
  const commitIm = (text: string) => {
    setImText(text)
    const n = Number(text)
    if (text.trim() !== '' && Number.isFinite(n)) onChange({ ...value, im: n })
  }

  const fromEvent = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    return {
      re: Math.round((x - 0.5) * 2 * range * 1000) / 1000,
      im: Math.round((0.5 - y) * 2 * range * 1000) / 1000,
    }
  }

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    svgRef.current?.setPointerCapture(e.pointerId)
    onChange(fromEvent(e))
  }

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.buttons !== 1) return
    onChange(fromEvent(e))
  }

  const clamp = (n: number) => Math.max(-range, Math.min(range, n))
  const toPx = (re: number, im: number) => ({
    x: ((clamp(re) / range) * 0.5 + 0.5) * SIZE,
    y: (0.5 - (clamp(im) / range) * 0.5) * SIZE,
  })
  const point = toPx(value.re, value.im)

  return (
    <label className="field-label">
      <span>Constant c — drag the point below, or type it in</span>
      <div className="complex-plane-wrap">
        <svg
          ref={svgRef}
          className="complex-plane"
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          style={{ cursor: 'crosshair', touchAction: 'none' }}
        >
          <rect x={0} y={0} width={SIZE} height={SIZE} rx={12} fill={PLANE_BG} stroke={PLANE_BORDER} />
          {TICKS.map((t) => {
            const p = toPx(t * range, t * range)
            return (
              <g key={t}>
                <line x1={p.x} y1={0} x2={p.x} y2={SIZE} stroke={PLANE_BORDER} strokeWidth={1} />
                <line x1={0} y1={p.y} x2={SIZE} y2={p.y} stroke={PLANE_BORDER} strokeWidth={1} />
              </g>
            )
          })}
          <line x1={SIZE / 2} y1={0} x2={SIZE / 2} y2={SIZE} stroke={PLANE_AXIS} strokeWidth={1.5} />
          <line x1={0} y1={SIZE / 2} x2={SIZE} y2={SIZE / 2} stroke={PLANE_AXIS} strokeWidth={1.5} />
          <circle
            cx={point.x}
            cy={point.y}
            r={6}
            fill={PLANE_POINT}
            stroke={PLANE_POINT_STROKE}
            strokeWidth={2}
            style={{ transition: 'none' }}
          />
        </svg>
        <div className="c-inputs">
          <TextInput
            type="text"
            inputMode="decimal"
            value={reText}
            onChange={(e) => commitRe(e.target.value)}
            aria-label="c real part"
            monospace
            style={{ width: 88 }}
          />
          <span>+</span>
          <TextInput
            type="text"
            inputMode="decimal"
            value={imText}
            onChange={(e) => commitIm(e.target.value)}
            aria-label="c imaginary part"
            monospace
            style={{ width: 88 }}
          />
          <span>i</span>
        </div>
      </div>
    </label>
  )
}
