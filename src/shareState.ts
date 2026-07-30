import { Mode, InlineState, ViewState } from './types'

export interface ShareOptions {
  includeFractal: boolean
  includePosition: boolean
  includePalette: boolean
}

// Formula/code fields are base64url-encoded before going in the query
// string. Fractal syntax leans hard on '*' (e.g. "z**2 + w"), and a raw '*'
// or '**' in a shared link doesn't survive being pasted into chat apps that
// treat it as markdown bold (Slack, Discord, Telegram, WhatsApp, ...) —
// the asterisks get eaten by the renderer, silently corrupting the formula.
// Base64url's alphabet is only [A-Za-z0-9_-], none of which trigger any
// markdown formatting, so the payload survives any text medium intact.
function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(str: string): string {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export interface ShareableState {
  mode: Mode
  inline: InlineState
  python: string
  juliaC: { re: number; im: number }
  maxIter: number
  bailout: number
  view: ViewState
  colorScheme: number
}

export function buildShareUrl(state: ShareableState, options: ShareOptions): string {
  const params = new URLSearchParams()

  if (options.includeFractal) {
    params.set('m', state.mode === 'inline' ? 'i' : 'p')
    if (state.mode === 'inline') {
      params.set('f', toBase64Url(state.inline.f))
      params.set('ru', toBase64Url(state.inline.rule))
      params.set('z0', toBase64Url(state.inline.z0))
    } else {
      params.set('src', toBase64Url(state.python))
    }
    params.set('cre', String(state.juliaC.re))
    params.set('cim', String(state.juliaC.im))
    params.set('mi', String(state.maxIter))
    params.set('bo', String(state.bailout))
  }

  if (options.includePosition) {
    params.set('x', String(state.view.cx))
    params.set('y', String(state.view.cy))
    params.set('s', String(state.view.scale))
  }

  if (options.includePalette) {
    params.set('pal', String(state.colorScheme))
  }

  const url = new URL(window.location.href)
  url.search = params.toString()
  return url.toString()
}

export interface ParsedShareState {
  mode?: Mode
  inline?: InlineState
  python?: string
  juliaC?: { re: number; im: number }
  maxIter?: number
  bailout?: number
  view?: ViewState
  colorScheme?: number
}

function parseNumber(v: string | null): number | undefined {
  if (v === null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function parseShareParams(search: string): ParsedShareState {
  const params = new URLSearchParams(search)
  const result: ParsedShareState = {}

  try {
    const m = params.get('m')
    if (m === 'i') {
      const f = params.get('f')
      const ru = params.get('ru')
      const z0 = params.get('z0')
      if (f !== null && ru !== null && z0 !== null) {
        result.mode = 'inline'
        result.inline = { f: fromBase64Url(f), rule: fromBase64Url(ru), z0: fromBase64Url(z0) }
      }
    } else if (m === 'p') {
      const src = params.get('src')
      if (src !== null) {
        result.mode = 'python'
        result.python = fromBase64Url(src)
      }
    }
  } catch {
    // Malformed/truncated base64 (e.g. a link mangled or clipped in transit) —
    // fall back to the default preset rather than crashing on garbage input.
  }

  const cre = parseNumber(params.get('cre'))
  const cim = parseNumber(params.get('cim'))
  if (cre !== undefined && cim !== undefined) result.juliaC = { re: cre, im: cim }

  const maxIter = parseNumber(params.get('mi'))
  if (maxIter !== undefined) result.maxIter = maxIter

  const bailout = parseNumber(params.get('bo'))
  if (bailout !== undefined) result.bailout = bailout

  const cx = parseNumber(params.get('x'))
  const cy = parseNumber(params.get('y'))
  const scale = parseNumber(params.get('s'))
  if (cx !== undefined && cy !== undefined && scale !== undefined) result.view = { cx, cy, scale }

  const colorScheme = parseNumber(params.get('pal'))
  if (colorScheme !== undefined) result.colorScheme = colorScheme

  return result
}
