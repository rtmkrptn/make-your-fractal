import { useRef } from 'react'
import { Button, Textarea } from '@primer/react'
import { DownloadIcon, UploadIcon } from '@primer/octicons-react'
import { usesIdentifier } from '../dsl/usesIdentifier'
import { ComplexPointField } from '../components/ComplexPointField'
import { Reference } from '../components/Reference'

interface Props {
  value: string
  onChange: (next: string) => void
  juliaC: { re: number; im: number }
  onJuliaCChange: (v: { re: number; im: number }) => void
}

export function PythonMode({ value, onChange, juliaC, onJuliaCChange }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Every function signature spells out `c` as a parameter (`def f(z, w, c,
  // n):`), so checking the raw source would always report true regardless of
  // whether a function body actually references it — strip signature lines
  // first and check only what's left.
  const usesC = usesIdentifier(value.replace(/^\s*def\s+\w+\s*\([^)]*\)\s*:.*$/gm, ''), 'c')

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = e.currentTarget
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const next = value.slice(0, start) + '    ' + value.slice(end)
      onChange(next)
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 4
      })
    }
  }

  const handleImportClick = () => fileInputRef.current?.click()

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => onChange(String(reader.result ?? ''))
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleExport = () => {
    const blob = new Blob([value], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'fractal.py'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mode-panel">
      <p className="mode-blurb">
        Define <code className="inline-code">def f(z, w, c, n):</code> and{' '}
        <code className="inline-code">def rule(z, w, c, n):</code> (optionally{' '}
        <code className="inline-code">def z0(w, c):</code>). Python-style indentation,{' '}
        <code className="inline-code">if</code>/<code className="inline-code">elif</code>/
        <code className="inline-code">else</code>, <code className="inline-code">for i in range(N):</code> with a
        literal bound, and local variables are all supported. Every code path must{' '}
        <code className="inline-code">return</code>.
      </p>

      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        resize="vertical"
        rows={12}
        block
        style={{ fontFamily: 'var(--fontStack-monospace)', fontSize: 13, lineHeight: 1.5, minHeight: 220 }}
      />

      {usesC && <ComplexPointField value={juliaC} onChange={onJuliaCChange} />}

      <div className="button-row">
        <Button leadingVisual={UploadIcon} onClick={handleImportClick}>
          Import file
        </Button>
        <Button leadingVisual={DownloadIcon} onClick={handleExport}>
          Export file
        </Button>
        <input ref={fileInputRef} type="file" accept=".py,.txt" hidden onChange={handleFileChange} />
      </div>

      <Reference summary="Language reference">
        <ul className="reference-list">
          <li>Types: complex (z, w, c) and real numbers/booleans — inferred automatically.</li>
          <li>Literals: 2, 3.5, 3j (imaginary), True/False, pi, e</li>
          <li>
            Operators: + - * / ** % , comparisons, and / or / not, ternary{' '}
            <code className="inline-code">a if cond else b</code>
          </li>
          <li>
            Functions: abs, arg (phase), conj, re, im, z.real, z.imag, complex(a,b), sin, cos, tan, exp, log, sqrt,
            pow, min, max, clamp, floor, ceil, round, sign
          </li>
          <li>Control flow: if / elif / else, for i in range(N) with N a literal ≤ 10000</li>
        </ul>
      </Reference>
    </div>
  )
}
