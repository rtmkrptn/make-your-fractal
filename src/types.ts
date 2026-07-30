export type Mode = 'inline' | 'python'

export interface ViewState {
  cx: number
  cy: number
  scale: number
}

export interface InlineState {
  f: string
  rule: string
  z0: string
}

export interface Preset {
  id: string
  name: string
  description: string
  inline: InlineState | null // null when the fractal needs Python-mode-only features (loops, branching)
  python: string
  view: ViewState
  maxIter: number
  bailout: number
  colorScheme: number
  juliaC: { re: number; im: number }
}
