import { useEffect, useState } from 'react'
import { PreciseView } from '../render/useFractalRenderer'
import { formatZoom, realLifeComparison } from '../render/viewHud'

interface Props {
  subscribeView: (cb: (v: PreciseView) => void) => () => void
  // Half-height of the currently loaded formula's own starting view — see
  // realLifeComparison's doc comment for why this isn't a fixed constant.
  referenceScale: number
}

// Coordinate strings can run to 60 decimal places at deep zoom (see
// useFractalRenderer's decimalPlaces) — display is truncated with an
// ellipsis, but the full value is still there in the title attribute for
// anyone who wants to copy it exactly.
const MAX_DISPLAY_LEN = 22

function truncate(value: string): string {
  return value.length > MAX_DISPLAY_LEN ? `${value.slice(0, MAX_DISPLAY_LEN)}…` : value
}

// Subscribes directly to the renderer's imperative view updates rather than
// receiving `view` as a prop, so panning/zooming (which can fire many times a
// second) only re-renders this small readout instead of the whole App tree.
export function ViewHud({ subscribeView, referenceScale }: Props) {
  const [view, setView] = useState<PreciseView | null>(null)

  useEffect(() => subscribeView(setView), [subscribeView])

  if (!view) return null

  return (
    <div className="view-hud">
      <div className="view-hud-row">
        <span className="view-hud-label">x</span>
        <span className="view-hud-value" title={view.cx}>
          {truncate(view.cx)}
        </span>
      </div>
      <div className="view-hud-row">
        <span className="view-hud-label">y</span>
        <span className="view-hud-value" title={view.cy}>
          {truncate(view.cy)}
        </span>
      </div>
      <div className="view-hud-row">
        <span className="view-hud-label">zoom</span>
        <span className="view-hud-value">{formatZoom(view.scale)}</span>
      </div>
      <div className="view-hud-compare">{realLifeComparison(view.scale, referenceScale)}</div>
    </div>
  )
}
