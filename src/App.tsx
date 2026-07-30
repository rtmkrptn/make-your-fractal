import { useEffect, useMemo, useRef, useState } from 'react'
import { IconButton, SegmentedControl, useTheme } from '@primer/react'
import { SunIcon, MoonIcon, MarkGithubIcon, StarIcon } from '@primer/octicons-react'
import { Mode, AverageState } from './types'
import { PRESETS, DEFAULT_PRESET } from './examples/presets'
import { compileAverageMode, compileProgram } from './dsl/compiler'
import { extractPerturbableFromAverage, extractPerturbableFromProgram, compilePerturbation } from './dsl/perturbation'
import { useFractalRenderer, CompiledPipeline, RenderMode } from './render/useFractalRenderer'
import { AverageMode } from './modes/AverageMode'
import { NerdMode } from './modes/NerdMode'
import { ControlsPanel } from './components/ControlsPanel'
import { ErrorBanner } from './components/ErrorBanner'
import { buildShareUrl, parseShareParams, ShareOptions } from './shareState'

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

function ThemeToggle() {
  const { colorScheme, setColorMode } = useTheme()
  const isDark = colorScheme?.startsWith('dark') ?? true
  return (
    <IconButton
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      icon={isDark ? SunIcon : MoonIcon}
      className="theme-toggle-btn"
      onClick={() => setColorMode(isDark ? 'day' : 'night')}
    />
  )
}

export default function App() {
  // A shared link (see ShareMenu/shareState.ts) can seed any subset of the
  // fractal definition, pan/zoom position, and color palette via URL query
  // params — whatever isn't present just falls back to the default preset.
  const shared = useMemo(() => parseShareParams(window.location.search), [])

  const [mode, setMode] = useState<Mode>(shared.mode ?? 'average')
  const [selectedPresetId, setSelectedPresetId] = useState(DEFAULT_PRESET.id)
  const [averageState, setAverageState] = useState<AverageState>(shared.average ?? DEFAULT_PRESET.average!)
  const [nerdSource, setNerdSource] = useState(shared.nerd ?? DEFAULT_PRESET.nerd)
  const [view, setView] = useState(shared.view ?? DEFAULT_PRESET.view)
  const [viewResetSignal, setViewResetSignal] = useState(0)
  const [maxIter, setMaxIter] = useState(shared.maxIter ?? DEFAULT_PRESET.maxIter)
  const [bailout, setBailout] = useState(shared.bailout ?? DEFAULT_PRESET.bailout)
  const [colorScheme, setColorScheme] = useState(shared.colorScheme ?? DEFAULT_PRESET.colorScheme)
  const [juliaC, setJuliaC] = useState(shared.juliaC ?? DEFAULT_PRESET.juliaC)
  const [renderMode, setRenderMode] = useState<RenderMode>('deepZoom')
  // Tracked in JS rather than a pure CSS :hover rule: clicking a Simple/Deep
  // button re-renders the SegmentedControl, and some browsers don't
  // re-evaluate :hover on an element until the next mousemove — the tooltip
  // could drop out right after a click even though the pointer never left.
  // mouseenter/leave don't have that gap.
  const [showRenderModeTip, setShowRenderModeTip] = useState(false)

  const debouncedAverage = useDebounced(averageState, 250)
  const debouncedNerd = useDebounced(nerdSource, 250)

  // Compiles the plain (always-available) GLSL, and separately checks whether
  // the formula is simple enough (single expression, no loops/branches) for
  // deep-zoom perturbation — see src/dsl/perturbation.ts for why that's the
  // boundary. Ineligible formulas still render fine, just capped at ~1e-6 zoom.
  const compiled = useMemo(() => {
    try {
      const plain =
        mode === 'average'
          ? compileAverageMode(debouncedAverage.f, debouncedAverage.rule, debouncedAverage.z0)
          : compileProgram(debouncedNerd)

      const perturbable =
        mode === 'average'
          ? extractPerturbableFromAverage(debouncedAverage.f, debouncedAverage.z0)
          : extractPerturbableFromProgram(debouncedNerd)

      let perturbation: CompiledPipeline['perturbation'] = null
      if (perturbable) {
        try {
          const pert = compilePerturbation(perturbable.fExpr, perturbable.z0Expr)
          perturbation = { fExpr: perturbable.fExpr, z0Expr: perturbable.z0Expr, glsl: pert.glsl, isExact: pert.isExact }
        } catch (e) {
          console.warn('Perturbation-eligible formula failed to compile a delta function; deep zoom will stay at plain float32 depth.', e)
        }
      }

      const pipeline: CompiledPipeline = { userGlsl: plain.glsl, perturbation }
      return { pipeline, error: null as string | null }
    } catch (e) {
      return { pipeline: null as CompiledPipeline | null, error: e instanceof Error ? e.message : String(e) }
    }
  }, [mode, debouncedAverage, debouncedNerd])

  const lastGoodRef = useRef<CompiledPipeline | null>(null)
  useEffect(() => {
    if (compiled.pipeline) lastGoodRef.current = compiled.pipeline
  }, [compiled.pipeline])
  const pipelineToRender = compiled.pipeline ?? lastGoodRef.current

  const params = useMemo(
    () => ({ maxIter, bailout, colorScheme, juliaC, renderMode }),
    [maxIter, bailout, colorScheme, juliaC, renderMode],
  )

  const { canvasRef, glError, resetView, downloadPNG, getView } = useFractalRenderer(
    pipelineToRender,
    params,
    view,
    String(viewResetSignal),
  )

  const handleSelectPreset = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id)
    if (!preset) return
    setSelectedPresetId(id)
    setNerdSource(preset.nerd)
    if (preset.average) {
      setAverageState(preset.average)
    } else if (mode === 'average') {
      setMode('nerd')
    }
    setView(preset.view)
    setMaxIter(preset.maxIter)
    setBailout(preset.bailout)
    setColorScheme(preset.colorScheme)
    setJuliaC(preset.juliaC)
    setViewResetSignal((v) => v + 1)
  }

  const handleShare = (options: ShareOptions) => {
    const url = buildShareUrl(
      { mode, average: averageState, nerd: nerdSource, juliaC, maxIter, bailout, view: getView(), colorScheme },
      options,
    )
    if (navigator.share) {
      navigator.share({ title: 'Fractal Forge', url }).catch(() => {})
    } else {
      navigator.clipboard.writeText(url).catch(() => {})
    }
  }

  const displayError = compiled.error ?? glError

  return (
    <div className="app">
      <div className="app-main">
        <div className="canvas-wrap">
          <canvas ref={canvasRef} />
          <a
            className="github-star-link"
            href="https://github.com/rtmkrptn/make-your-fractal"
            target="_blank"
            rel="noreferrer"
          >
            <MarkGithubIcon size={16} />
            Star on GitHub
            <StarIcon size={14} />
          </a>
          <div className="canvas-hint">Scroll to zoom · drag to pan</div>
          <div className="precision-badge-wrap">
            <ThemeToggle />
            <div
              className="render-mode-control"
              onMouseEnter={() => setShowRenderModeTip(true)}
              onMouseLeave={() => setShowRenderModeTip(false)}
              onFocus={() => setShowRenderModeTip(true)}
              onBlur={() => setShowRenderModeTip(false)}
            >
              <SegmentedControl
                aria-label="Rendering precision"
                onChange={(i) => setRenderMode(i === 0 ? 'simple' : 'deepZoom')}
              >
                <SegmentedControl.Button selected={renderMode === 'simple'}>Simple</SegmentedControl.Button>
                <SegmentedControl.Button selected={renderMode === 'deepZoom'}>Deep</SegmentedControl.Button>
              </SegmentedControl>
              <div className={`render-mode-tip ${showRenderModeTip ? 'is-visible' : ''}`} role="tooltip">
                <table>
                  <thead>
                    <tr>
                      <th scope="col" />
                      <th scope="col">Simple</th>
                      <th scope="col">Deep</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">Stability</th>
                      <td className="tip-yes">✓</td>
                      <td className="tip-no">✗</td>
                    </tr>
                    <tr>
                      <th scope="row">Fidelity</th>
                      <td className="tip-no">✗</td>
                      <td className="tip-yes">✓</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <aside className="sidebar">
          <SegmentedControl aria-label="Mode" onChange={(i) => setMode(i === 0 ? 'average' : 'nerd')} fullWidth>
            <SegmentedControl.Button selected={mode === 'average'}>Inline</SegmentedControl.Button>
            <SegmentedControl.Button selected={mode === 'nerd'}>Python</SegmentedControl.Button>
          </SegmentedControl>

          <ErrorBanner message={displayError} />

          {mode === 'average' ? (
            <AverageMode
              value={averageState}
              onChange={setAverageState}
              juliaC={juliaC}
              onJuliaCChange={setJuliaC}
            />
          ) : (
            <NerdMode value={nerdSource} onChange={setNerdSource} juliaC={juliaC} onJuliaCChange={setJuliaC} />
          )}

          <ControlsPanel
            presets={PRESETS}
            selectedPresetId={selectedPresetId}
            onSelectPreset={handleSelectPreset}
            maxIter={maxIter}
            onMaxIterChange={setMaxIter}
            colorScheme={colorScheme}
            onColorSchemeChange={setColorScheme}
            onResetView={resetView}
            onDownloadPNG={() => downloadPNG('fractal.png')}
            onShare={handleShare}
          />
        </aside>
      </div>
    </div>
  )
}
