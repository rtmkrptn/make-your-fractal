import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VERTEX_SHADER, buildFragmentShader } from './shaderTemplate'
import { Expr } from '../dsl/ast'
import { OrbitRequest, OrbitResponse } from './orbitWorker'

export interface ViewState {
  cx: number
  cy: number
  scale: number // half-height of the visible complex-plane window
}

/** When present, the current formula is perturbation-eligible: `glsl` defines delta_f/delta_z0, and fExpr/z0Expr are the raw ASTs needed to (re)compute a reference orbit at an arbitrary point. */
export interface PerturbationInput {
  fExpr: Expr
  z0Expr: Expr
  glsl: string
  // Whether delta_f is an exact chain (safe to rebase) or relies on a
  // first-order approximation like abs()'s sign(Z) rule (unsafe to rebase —
  // see shaderTemplate.ts's PERTURBED_MAIN_REBASE doc comment).
  isExact: boolean
}

export interface CompiledPipeline {
  userGlsl: string // user_f / user_rule / user_z0
  perturbation: PerturbationInput | null
}

// 'simple' forces ordinary float32 rendering even for perturbation-eligible
// formulas — useful when a formula's delta approximation is unreliable (e.g.
// abs()-based ones like Burning Ship can render visibly wrong shapes under
// perturbation even without overflowing — see PERTURBED_MAIN_NAIVE's doc
// comment) or simply when the user wants guaranteed classic precision.
// 'deepZoom' is the default: use perturbation whenever the formula is
// eligible and a reference orbit is available, at any zoom depth.
export type RenderMode = 'simple' | 'deepZoom'

export interface RenderParams {
  maxIter: number
  bailout: number
  colorScheme: number
  juliaC: { re: number; im: number }
  renderMode: RenderMode
}

export interface FractalRenderer {
  canvasRef: React.RefObject<HTMLCanvasElement>
  glError: string | null
  isReady: boolean
  usingPerturbation: boolean
  resetView: () => void
  downloadPNG: (filename?: string) => void
}

const DEFAULT_VIEW: ViewState = { cx: -0.5, cy: 0, scale: 1.5 }
const MIN_SCALE_ELIGIBLE = 1e-290 // perturbation has no real depth limit; this is just a sane self-imposed floor
const MIN_SCALE_PLAIN = 1e-6 // plain float32 depth limit — no fallback for non-eligible formulas
const MAX_SCALE = 8
const SETTLE_DELAY_MS = 200
// Gentle enough that a burst of scroll input doesn't blow past the
// (infinitely thin) fractal boundary before you can react and steer the
// cursor back onto it.
const WHEEL_ZOOM_RATE = 1.0006
const WHEEL_DELTA_CLAMP = 150

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(log || 'unknown shader compile error')
  }
  return shader
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const program = gl.createProgram()!
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.bindAttribLocation(program, 0, 'a_position') // pin location 0 so both program variants share one VBO setup
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(log || 'unknown program link error')
  }
  return program
}

interface ProgramBundle {
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation | null>
}

const PLAIN_UNIFORMS = ['u_resolution', 'u_center', 'u_scale', 'u_maxIter', 'u_bailout', 'u_c', 'u_colorScheme']
const PERTURBED_UNIFORMS = [
  'u_resolution',
  'u_wRef',
  'u_centerDrift',
  'u_scale',
  'u_maxIter',
  'u_bailout',
  'u_c',
  'u_cRef',
  'u_cDrift',
  'u_colorScheme',
  'u_refOrbit',
]

function buildProgram(gl: WebGL2RenderingContext, fragSource: string, uniformNames: string[]): ProgramBundle {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSource)
  const program = linkProgram(gl, vs, fs)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  const uniforms: Record<string, WebGLUniformLocation | null> = {}
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name)
  return { program, uniforms }
}

/**
 * Owns the WebGL2 context and drives interactive pan/zoom rendering. For
 * perturbation-eligible formulas, a high-precision reference orbit is
 * computed on the CPU (src/dsl/perturbation.ts) whenever the view settles at
 * a new center, uploaded as a texture, and every pixel renders by tracking
 * only its tiny per-pixel delta from it in ordinary float32 — that's what
 * lets zoom go arbitrarily deep without slowing per-pixel cost down (unlike
 * raising precision everywhere, which is strictly worse on both counts).
 * `params.renderMode` lets the caller force plain rendering even when a
 * formula is perturbation-eligible — see RenderMode's doc comment.
 */
export function useFractalRenderer(
  compiled: CompiledPipeline | null,
  params: RenderParams,
  initialView: ViewState = DEFAULT_VIEW,
  viewResetSignal: string = '',
): FractalRenderer {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const glRef = useRef<WebGL2RenderingContext | null>(null)
  const programsRef = useRef<{ plain: ProgramBundle | null; perturbed: ProgramBundle | null }>({ plain: null, perturbed: null })
  const refOrbitTextureRef = useRef<WebGLTexture | null>(null)
  const refOrbitReadyRef = useRef(false)
  const refPointRef = useRef<{ re: number; im: number } | null>(null)
  const refCRef = useRef<{ re: number; im: number } | null>(null)
  const compiledRef = useRef<CompiledPipeline | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const orbitRequestIdRef = useRef(0)

  const viewRef = useRef<ViewState>({ ...initialView })
  const initialViewRef = useRef(initialView)
  const paramsRef = useRef(params)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drawRef = useRef<() => void>(() => {})
  const updateReferenceOrbitRef = useRef<() => void>(() => {})

  const [glError, setGlError] = useState<string | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [usingPerturbation, setUsingPerturbation] = useState(false)

  paramsRef.current = params
  initialViewRef.current = initialView
  compiledRef.current = compiled

  // --- one-time GL setup ---
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })
    if (!gl) {
      setGlError('WebGL2 is not available in this browser.')
      return
    }
    glRef.current = gl

    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    if (!gl.getExtension('EXT_color_buffer_float')) {
      // Needed to sample the reference-orbit float texture; without it we
      // simply never enable perturbation (checked again at texture-upload time).
      console.warn('EXT_color_buffer_float not available — deep-zoom perturbation will be disabled, capped at plain float32 depth.')
    }

    const tex = gl.createTexture()
    refOrbitTextureRef.current = tex
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = canvas.getBoundingClientRect()
      const w = Math.max(1, Math.round(rect.width * dpr))
      const h = Math.max(1, Math.round(rect.height * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      gl.viewport(0, 0, canvas.width, canvas.height)
      drawRef.current()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()

    return () => {
      ro.disconnect()
      gl.deleteBuffer(vbo)
      gl.deleteTexture(tex)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- background worker for reference-orbit computation ---
  // computeReferenceOrbit is CPU-bound arbitrary-precision (decimal.js) math
  // — O(maxIter) Decimal ops at up to 300 digits — that used to run directly
  // on the main thread and freeze pointer/wheel handling and React updates
  // for however long it took. Running it in a worker keeps interaction
  // responsive; whatever orbit is already uploaded (even if for a slightly
  // stale center) keeps rendering via u_centerDrift until this resolves and
  // triggers a fresh draw.
  useEffect(() => {
    const worker = new Worker(new URL('./orbitWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<OrbitResponse>) => {
      const res = e.data
      if (res.id !== orbitRequestIdRef.current) return // superseded by a newer request; discard
      const gl = glRef.current
      const tex = refOrbitTextureRef.current
      if (!gl || !tex || res.error || res.count === 0) {
        if (res.error) console.warn('Reference orbit computation failed; falling back to plain precision.', res.error)
        refOrbitReadyRef.current = false
        setUsingPerturbation(false)
        drawRef.current()
        return
      }
      const data = new Float32Array(res.count * 2)
      for (let i = 0; i < res.count; i++) {
        data[i * 2] = res.zRe[i]
        data[i * 2 + 1] = res.zIm[i]
      }
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, res.count, 1, 0, gl.RG, gl.FLOAT, data)
      refPointRef.current = res.wRef
      refCRef.current = res.c
      refOrbitReadyRef.current = true
      setUsingPerturbation(true)
      drawRef.current()
    }
    workerRef.current = worker
    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  // --- kick off a (background) recompute of the reference orbit at the current view center ---
  const updateReferenceOrbit = useCallback(() => {
    const worker = workerRef.current
    const pert = compiledRef.current?.perturbation
    if (!worker || !pert) {
      refOrbitReadyRef.current = false
      return
    }
    const v = viewRef.current
    const p = paramsRef.current
    const precisionDigits = Math.max(20, Math.min(300, Math.ceil(-Math.log10(v.scale)) + 15))
    const request: OrbitRequest = {
      id: ++orbitRequestIdRef.current,
      fExpr: pert.fExpr,
      z0Expr: pert.z0Expr,
      wRef: { re: v.cx, im: v.cy },
      c: p.juliaC,
      maxIter: p.maxIter,
      precisionDigits,
    }
    worker.postMessage(request)
  }, [])
  updateReferenceOrbitRef.current = updateReferenceOrbit

  // --- (re)compile programs whenever the compiled user GLSL changes ---
  useEffect(() => {
    const gl = glRef.current
    if (!gl || !compiled) return

    let cancelled = false
    let newPlain: ProgramBundle | null = null
    let newPerturbed: ProgramBundle | null = null
    let plainError: string | null = null

    try {
      newPlain = buildProgram(gl, buildFragmentShader(compiled.userGlsl), PLAIN_UNIFORMS)
    } catch (e) {
      plainError = e instanceof Error ? e.message : String(e)
    }

    if (compiled.perturbation) {
      try {
        newPerturbed = buildProgram(
          gl,
          buildFragmentShader(compiled.userGlsl, compiled.perturbation.glsl, compiled.perturbation.isExact),
          PERTURBED_UNIFORMS,
        )
      } catch (e) {
        console.warn('Perturbation shader failed to compile; deep zoom will stay at plain float32 depth.', e)
      }
    }

    if (cancelled) {
      if (newPlain) gl.deleteProgram(newPlain.program)
      if (newPerturbed) gl.deleteProgram(newPerturbed.program)
      return
    }

    if (!newPlain) {
      setIsReady(false)
      setGlError(plainError)
      return
    }

    if (programsRef.current.plain) gl.deleteProgram(programsRef.current.plain.program)
    if (programsRef.current.perturbed) gl.deleteProgram(programsRef.current.perturbed.program)
    programsRef.current = { plain: newPlain, perturbed: newPerturbed }
    refOrbitReadyRef.current = false
    refPointRef.current = null

    setGlError(null)
    setIsReady(true)
    if (newPerturbed && paramsRef.current.renderMode === 'deepZoom') {
      updateReferenceOrbitRef.current()
    } else {
      // Either this formula can't use perturbation, or the user has forced
      // simple mode — if the view was left deep inside perturbation-only
      // territory (e.g. by a previous formula, or by editing the code while
      // already zoomed in), plain float32 can't resolve u_center + uv*u_scale
      // at that depth: the tiny term vanishes into rounding and every pixel
      // would sample the same point. Clamp back to where plain precision
      // still works instead of silently freezing.
      viewRef.current.scale = Math.max(MIN_SCALE_PLAIN, viewRef.current.scale)
      setUsingPerturbation(false)
    }
    drawRef.current()

    return () => {
      cancelled = true
    }
  }, [compiled])

  // --- draw function (imperative; called on every interaction, not on an RAF loop) ---
  const draw = useCallback(() => {
    const gl = glRef.current
    const canvas = canvasRef.current
    if (!gl || !canvas) return
    const v = viewRef.current
    const p = paramsRef.current
    const { plain, perturbed } = programsRef.current
    const usePerturbed = p.renderMode === 'deepZoom' && !!perturbed && refOrbitReadyRef.current
    const bundle = usePerturbed ? perturbed : plain
    if (!bundle) return

    gl.useProgram(bundle.program)
    const u = bundle.uniforms
    gl.uniform2f(u.u_resolution, canvas.width, canvas.height)
    gl.uniform1f(u.u_scale, v.scale)
    gl.uniform1i(u.u_maxIter, p.maxIter)
    gl.uniform1f(u.u_bailout, p.bailout)
    gl.uniform1i(u.u_colorScheme, p.colorScheme)
    gl.uniform2f(u.u_c, p.juliaC.re, p.juliaC.im)

    if (usePerturbed) {
      const ref = refPointRef.current!
      const cRef = refCRef.current!
      gl.uniform2f(u.u_wRef, ref.re, ref.im)
      gl.uniform2f(u.u_centerDrift, v.cx - ref.re, v.cy - ref.im)
      gl.uniform2f(u.u_cRef, cRef.re, cRef.im)
      gl.uniform2f(u.u_cDrift, p.juliaC.re - cRef.re, p.juliaC.im - cRef.im)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, refOrbitTextureRef.current)
      gl.uniform1i(u.u_refOrbit, 0)
    } else {
      gl.uniform2f(u.u_center, v.cx, v.cy)
    }

    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }, [])
  drawRef.current = draw

  // Redraws immediately on every gesture step (cheap: single-sample, no
  // supersampling), then SETTLE_DELAY_MS after the last input event,
  // recomputes a fresh reference orbit at wherever the view ended up — that's
  // a CPU-side arbitrary-precision calculation, too slow to redo every frame
  // during a drag.
  const scheduleSettle = useCallback(() => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
    settleTimerRef.current = setTimeout(() => {
      if (compiledRef.current?.perturbation && paramsRef.current.renderMode === 'deepZoom') updateReferenceOrbitRef.current()
      drawRef.current()
    }, SETTLE_DELAY_MS)
  }, [])

  const markInteraction = useCallback(() => {
    draw()
    scheduleSettle()
  }, [draw, scheduleSettle])

  // Redraw immediately on every param change — cheap, single-sample.
  useEffect(() => {
    drawRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.maxIter, params.bailout, params.colorScheme, params.juliaC.re, params.juliaC.im, params.renderMode])

  // Only maxIter and juliaC (c feeds directly into the orbit formula) can
  // change the reference orbit itself, so only they warrant the settle-then-
  // recompute treatment sliders/drags get. bailout and colorScheme are purely
  // cosmetic (escape threshold / palette) and reuse whatever orbit is already
  // uploaded — recomputing it for those was pure waste, and on a slow deep
  // zoom made every color-scheme click pay the same CPU cost as a pan.
  useEffect(() => {
    scheduleSettle()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.maxIter, params.juliaC.re, params.juliaC.im, params.renderMode])

  // --- pointer drag panning + wheel zoom ---
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let dragging = false
    let lastX = 0
    let lastY = 0

    const onPointerDown = (e: PointerEvent) => {
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      canvas.setPointerCapture(e.pointerId)
      canvas.style.cursor = 'grabbing'
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return
      const rect = canvas.getBoundingClientRect()
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      const v = viewRef.current
      v.cx -= (dx / rect.height) * v.scale * 2
      v.cy += (dy / rect.height) * v.scale * 2
      markInteraction()
    }
    const endDrag = (e: PointerEvent) => {
      dragging = false
      canvas.style.cursor = 'grab'
      try {
        canvas.releasePointerCapture(e.pointerId)
      } catch {
        /* no-op */
      }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const uvx = (e.clientX - rect.left - 0.5 * rect.width) / rect.height
      const uvy = -(e.clientY - rect.top - 0.5 * rect.height) / rect.height
      const v = viewRef.current
      const minScale =
        compiledRef.current?.perturbation && paramsRef.current.renderMode === 'deepZoom' ? MIN_SCALE_ELIGIBLE : MIN_SCALE_PLAIN
      // Clamp per-event delta so a single large burst (trackpad inertial
      // scrolling can fire many events, or occasionally one huge one) can't
      // blow through many zoom levels at once — the fractal boundary is
      // infinitely thin, so overshooting it in one jump lands you in a flat
      // "wasteland" with no way to tell which direction detail went.
      const clampedDelta = Math.max(-WHEEL_DELTA_CLAMP, Math.min(WHEEL_DELTA_CLAMP, e.deltaY))
      const factor = Math.pow(WHEEL_ZOOM_RATE, clampedDelta)
      const newScale = Math.min(MAX_SCALE, Math.max(minScale, v.scale * factor))
      v.cx += uvx * 2 * (v.scale - newScale)
      v.cy += uvy * 2 * (v.scale - newScale)
      v.scale = newScale
      markInteraction()
    }

    canvas.style.cursor = 'grab'
    canvas.style.touchAction = 'none'
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', endDrag)
    canvas.addEventListener('pointercancel', endDrag)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', endDrag)
      canvas.removeEventListener('pointercancel', endDrag)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [markInteraction])

  const resetView = useCallback(() => {
    viewRef.current = { ...initialViewRef.current }
    refPointRef.current = null
    refOrbitReadyRef.current = false
    if (compiledRef.current?.perturbation && paramsRef.current.renderMode === 'deepZoom') updateReferenceOrbitRef.current()
    draw()
  }, [draw])

  // Snap to the (possibly new) initial view whenever the caller signals a
  // reset is warranted — e.g. the user picked a different preset.
  useEffect(() => {
    if (!viewResetSignal) return
    resetView()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewResetSignal])

  const downloadPNG = useCallback((filename = 'fractal.png') => {
    const canvas = canvasRef.current
    if (!canvas) return
    draw()
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }, [draw])

  return useMemo(
    () => ({ canvasRef, glError, isReady, usingPerturbation, resetView, downloadPNG }),
    [glError, isReady, usingPerturbation, resetView, downloadPNG],
  )
}
