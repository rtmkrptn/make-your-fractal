export type Mode = 'average' | 'nerd'

export interface ViewState {
  cx: number
  cy: number
  scale: number
}

export interface AverageState {
  f: string
  rule: string
  z0: string
}

export interface Preset {
  id: string
  name: string
  description: string
  average: AverageState | null // null when the fractal needs nerd-mode-only features (loops, branching)
  nerd: string
  view: ViewState
  maxIter: number
  bailout: number
  colorScheme: number
  juliaC: { re: number; im: number }
}
