import { Mode, InlineState, ViewState } from './types'

export interface ShareOptions {
  includeFractal: boolean
  includePosition: boolean
  includePalette: boolean
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
      params.set('f', state.inline.f)
      params.set('ru', state.inline.rule)
      params.set('z0', state.inline.z0)
    } else {
      params.set('src', state.python)
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

  const m = params.get('m')
  if (m === 'i') {
    const f = params.get('f')
    const ru = params.get('ru')
    const z0 = params.get('z0')
    if (f !== null && ru !== null && z0 !== null) {
      result.mode = 'inline'
      result.inline = { f, rule: ru, z0 }
    }
  } else if (m === 'p') {
    const src = params.get('src')
    if (src !== null) {
      result.mode = 'python'
      result.python = src
    }
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
