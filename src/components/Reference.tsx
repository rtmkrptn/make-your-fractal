import { ReactNode, useId, useState } from 'react'
import { ChevronRightIcon } from '@primer/octicons-react'

interface Props {
  summary: string
  children: ReactNode
}

// A visibly-clickable, animated accordion. Native <details>/<summary> can't
// animate its open/close (browsers snap the content in/out instantly), so
// this drives a plain button + CSS grid-rows transition instead — the
// 0fr -> 1fr trick animates to an intrinsic, unmeasured height.
export function Reference({ summary, children }: Props) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()

  return (
    <div className="reference">
      <button
        type="button"
        className="reference-summary"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="reference-chevron" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
          <ChevronRightIcon size={14} />
        </span>
        {summary}
      </button>
      <div className={`reference-collapse ${open ? 'is-open' : ''}`}>
        <div className="reference-collapse-inner">
          <div id={bodyId} className="reference-body">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
