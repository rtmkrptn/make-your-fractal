import { useEffect, useRef, useState } from 'react'
import { Button } from '@primer/react'
import { ShareIcon } from '@primer/octicons-react'
import { ShareOptions } from '../shareState'

interface Props {
  onShare: (options: ShareOptions) => void
}

// Share is a small popover rather than a single action: the link can carry
// the fractal definition, the current pan/zoom position, and/or the color
// palette, and not every share should carry all three (e.g. sending someone
// "look at this formula" shouldn't also pin them to your exact zoom depth).
export function ShareMenu({ onShare }: Props) {
  const [open, setOpen] = useState(false)
  const [includeFractal, setIncludeFractal] = useState(true)
  const [includePosition, setIncludePosition] = useState(false)
  const [includePalette, setIncludePalette] = useState(true)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClickAway = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [open])

  const handleCopy = () => {
    onShare({ includeFractal, includePosition, includePalette })
    setOpen(false)
  }

  return (
    <div className="share-menu" ref={rootRef}>
      <Button leadingVisual={ShareIcon} onClick={() => setOpen((o) => !o)}>
        Share
      </Button>
      {open && (
        <div className="share-menu-popover">
          <label className="share-menu-option">
            <input type="checkbox" checked={includeFractal} onChange={(e) => setIncludeFractal(e.target.checked)} />
            Fractal
          </label>
          <label className="share-menu-option">
            <input type="checkbox" checked={includePosition} onChange={(e) => setIncludePosition(e.target.checked)} />
            Position
          </label>
          <label className="share-menu-option">
            <input type="checkbox" checked={includePalette} onChange={(e) => setIncludePalette(e.target.checked)} />
            Color palette
          </label>
          <Button size="small" block onClick={handleCopy}>
            Copy link
          </Button>
        </div>
      )}
    </div>
  )
}
