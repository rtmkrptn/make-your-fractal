import { TextInput } from '@primer/react'
import { AverageState } from '../types'
import { usesIdentifier } from '../dsl/usesIdentifier'
import { ComplexPointField } from '../components/ComplexPointField'
import { Reference } from '../components/Reference'

interface Props {
  value: AverageState
  onChange: (next: AverageState) => void
  juliaC: { re: number; im: number }
  onJuliaCChange: (v: { re: number; im: number }) => void
}

export function AverageMode({ value, onChange, juliaC, onJuliaCChange }: Props) {
  const set = (key: keyof AverageState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [key]: e.target.value })

  const usesC = [value.f, value.rule, value.z0].some((expr) => usesIdentifier(expr, 'c'))

  return (
    <div className="mode-panel">
      <p className="mode-blurb">
        Fill in three formulas. <code className="inline-code">z</code> is the running value,{' '}
        <code className="inline-code">w</code> is the point being tested (x + yi),{' '}
        <code className="inline-code">c</code> is the adjustable constant below, and{' '}
        <code className="inline-code">n</code> is the iteration number.
      </p>

      <label className="field-label">
        <span>
          z(n) = f(z, w, c, n) <em className="field-note">— the iteration step</em>
        </span>
        <TextInput value={value.f} onChange={set('f')} spellCheck={false} placeholder="z**2 + w" monospace block />
      </label>

      <label className="field-label">
        <span>
          rule(z, w, c, n) <em className="field-note">— boolean escape condition</em>
        </span>
        <TextInput value={value.rule} onChange={set('rule')} spellCheck={false} placeholder="abs(z) > 2" monospace block />
      </label>

      <label className="field-label">
        <span>
          z(0) = z0(w, c) <em className="field-note">— starting value</em>
        </span>
        <TextInput value={value.z0} onChange={set('z0')} spellCheck={false} placeholder="0" monospace block />
      </label>

      {usesC && <ComplexPointField value={juliaC} onChange={onJuliaCChange} />}

      <Reference summary="Available functions">
        <code className="inline-code">abs(z)</code> <code className="inline-code">arg(z)</code>{' '}
        <code className="inline-code">conj(z)</code> <code className="inline-code">z.real</code>{' '}
        <code className="inline-code">z.imag</code> <code className="inline-code">re(z)</code>{' '}
        <code className="inline-code">im(z)</code> <code className="inline-code">complex(a, b)</code>{' '}
        <code className="inline-code">sin</code> <code className="inline-code">cos</code>{' '}
        <code className="inline-code">tan</code> <code className="inline-code">exp</code>{' '}
        <code className="inline-code">log</code> <code className="inline-code">sqrt</code>{' '}
        <code className="inline-code">pow(a, b)</code> <code className="inline-code">min</code>{' '}
        <code className="inline-code">max</code> <code className="inline-code">pi</code>{' '}
        <code className="inline-code">e</code>
      </Reference>
    </div>
  )
}
