// Perturbation rendering: instead of computing every pixel's fractal orbit in
// (emulated) high precision, compute ONE reference orbit at arbitrary
// precision on the CPU (once per view), then have every pixel track only its
// tiny *offset* (delta) from that reference orbit using ordinary, cheap
// single-precision GLSL math. No pixel ever adds a tiny number to a big one,
// so there's no precision to lose — this is how deep-zoom fractal tools
// reach depths like 1e-300 while staying fast, unlike brute-force higher
// precision (which is what the old double-single renderer did: correct, but
// slower everywhere and still eventually hits a wall).
//
// Scope: only iteration functions that are a *single return expression*
// built from +, -, *, /, integer powers, abs()/conj()/re()/im()/complex(),
// and unary minus are eligible (checked by isPerturbable). That covers every
// built-in preset. Control flow, loops, comparisons, and transcendentals
// aren't supported here — formulas using them fall back to plain single
// precision (capped at the same ~1e-6 depth as before perturbation existed).

import Decimal from 'decimal.js'
import { Expr, FunctionDef } from './ast'
import { DslError } from './errors'
import { parseProgram, parseSingleExpr } from './parser'
import { FunctionCompiler, GlslType, tryLiteralInt } from './compiler'

// ---------------------------------------------------------------------------
// Eligibility check
// ---------------------------------------------------------------------------

const PERTURBABLE_CALLS = new Set(['abs', 'conj', 're', 'im', 'complex', 'pow'])

/**
 * Why `expr` can't go through deep-zoom perturbation, or null if it can.
 * Single source of truth for eligibility — isPerturbable is a thin boolean
 * wrapper over this so the UI-facing reason and the actual gate can't drift
 * apart.
 */
function describeExprBlocker(expr: Expr): string | null {
  switch (expr.kind) {
    case 'num':
    case 'imag':
    case 'name':
      return null
    case 'bool':
      return `uses a boolean literal (True/False), which deep zoom doesn't support`
    case 'attr':
      return describeExprBlocker(expr.obj)
    case 'unary':
      if (expr.op !== '-') return `uses 'not', which deep zoom doesn't support`
      return describeExprBlocker(expr.operand)
    case 'binary': {
      const leftBlocker = describeExprBlocker(expr.left)
      if (leftBlocker) return leftBlocker
      const rightBlocker = describeExprBlocker(expr.right)
      if (rightBlocker) return rightBlocker
      if (expr.op === '%') return `uses '%' (modulo), which deep zoom doesn't support`
      if (expr.op === '**') {
        const n = tryLiteralInt(expr.right)
        if (n === null || Math.abs(n) > 64) {
          return `uses '**' with a non-literal or too-large exponent — deep zoom only supports literal integer powers up to 64 (e.g. z**3)`
        }
      }
      return null
    }
    case 'compare':
      return `uses a comparison (${expr.op}), which deep zoom doesn't support`
    case 'logical':
      return `uses '${expr.op}', which deep zoom doesn't support`
    case 'ternary':
      return `uses a conditional expression ('x if cond else y'), which deep zoom doesn't support`
    case 'call': {
      if (!PERTURBABLE_CALLS.has(expr.callee)) {
        return `calls ${expr.callee}(), which deep zoom doesn't support (only abs, conj, re, im, complex, and pow with a literal integer exponent are)`
      }
      if (expr.callee === 'pow') {
        const n = tryLiteralInt(expr.args[1])
        if (n === null || Math.abs(n) > 64) {
          return `calls pow() with a non-literal or too-large exponent — deep zoom only supports literal integer exponents up to 64`
        }
      }
      for (const a of expr.args) {
        const blocker = describeExprBlocker(a)
        if (blocker) return blocker
      }
      return null
    }
  }
}

export function isPerturbable(expr: Expr): boolean {
  return describeExprBlocker(expr) === null
}

// Extra restrictions on top of describeExprBlocker for series approximation
// (see computeSeriesApproximation below): abs()/conj()/re()/im()/.real/.imag
// mix a value with its own conjugate, which isn't expressible as a power
// series in the single complex variable dc this uses — and division isn't
// expressible as an *exact* power series here either (mirrors why isExact is
// false for it in the delta-compiler path). Formulas that hit this still
// perturb normally; they just don't get the series-approximation speedup.
function seriesBlockerInExpr(expr: Expr): string | null {
  switch (expr.kind) {
    case 'num':
    case 'imag':
    case 'name':
    case 'bool':
      return null
    case 'attr':
      return `uses .real/.imag, which deep-zoom series approximation doesn't support`
    case 'unary':
      return seriesBlockerInExpr(expr.operand)
    case 'binary': {
      if (expr.op === '/') return `uses '/', which deep-zoom series approximation doesn't support`
      if (expr.op === '**') {
        const n = tryLiteralInt(expr.right)
        if (n !== null && n < 0) return `uses a negative exponent, which deep-zoom series approximation doesn't support`
      }
      return seriesBlockerInExpr(expr.left) || seriesBlockerInExpr(expr.right)
    }
    case 'compare':
    case 'logical':
    case 'ternary':
      return null // unreachable once describeExprBlocker has already passed
    case 'call': {
      if (expr.callee === 'abs' || expr.callee === 'conj' || expr.callee === 're' || expr.callee === 'im' || expr.callee === 'complex') {
        return `calls ${expr.callee}(), which deep-zoom series approximation doesn't support`
      }
      if (expr.callee === 'pow') {
        const n = tryLiteralInt(expr.args[1])
        if (n !== null && n < 0) return `calls pow() with a negative exponent, which deep-zoom series approximation doesn't support`
      }
      for (const a of expr.args) {
        const blocker = seriesBlockerInExpr(a)
        if (blocker) return blocker
      }
      return null
    }
  }
}

function singleReturnExpr(fn: FunctionDef): Expr | null {
  if (fn.body.length !== 1 || fn.body[0].kind !== 'return') return null
  return fn.body[0].value
}

export interface PerturbableExprs {
  fExpr: Expr
  z0Expr: Expr
}

/** Extracts (f, z0) as eligible single-expression ASTs from a parsed Python-mode program, or null if not eligible. */
export function extractPerturbableFromProgram(source: string): PerturbableExprs | null {
  let program
  try {
    program = parseProgram(source)
  } catch {
    return null
  }
  const fFn = program.functions.get('f')
  if (!fFn) return null
  const fExpr = singleReturnExpr(fFn)
  if (!fExpr || !isPerturbable(fExpr)) return null

  const z0Fn = program.functions.get('z0')
  const z0Expr: Expr = z0Fn ? singleReturnExpr(z0Fn) ?? { kind: 'num', value: 0, line: 0 } : { kind: 'num', value: 0, line: 0 }
  if (!isPerturbable(z0Expr)) return null

  return { fExpr, z0Expr }
}

/** Extracts (f, z0) as eligible single-expression ASTs from Inline-mode's fields, or null if not eligible. */
export function extractPerturbableFromInline(fExprSrc: string, z0ExprSrc: string): PerturbableExprs | null {
  let fExpr: Expr
  let z0Expr: Expr
  try {
    fExpr = parseSingleExpr(fExprSrc)
    z0Expr = parseSingleExpr(z0ExprSrc)
  } catch {
    return null
  }
  if (!isPerturbable(fExpr) || !isPerturbable(z0Expr)) return null
  return { fExpr, z0Expr }
}

// ---------------------------------------------------------------------------
// Reference orbit: arbitrary-precision evaluation on the CPU, once per view.
// ---------------------------------------------------------------------------

interface ComplexD {
  re: Decimal
  im: Decimal
}

type ValD = { kind: 'real'; v: Decimal } | { kind: 'complex'; v: ComplexD }

function toComplexD(v: ValD): ComplexD {
  return v.kind === 'complex' ? v.v : { re: v.v, im: new Decimal(0) }
}

function cAdd(a: ComplexD, b: ComplexD): ComplexD {
  return { re: a.re.plus(b.re), im: a.im.plus(b.im) }
}
function cSub(a: ComplexD, b: ComplexD): ComplexD {
  return { re: a.re.minus(b.re), im: a.im.minus(b.im) }
}
function cMul(a: ComplexD, b: ComplexD): ComplexD {
  return { re: a.re.times(b.re).minus(a.im.times(b.im)), im: a.re.times(b.im).plus(a.im.times(b.re)) }
}
function cDiv(a: ComplexD, b: ComplexD): ComplexD {
  const d = b.re.times(b.re).plus(b.im.times(b.im))
  return { re: a.re.times(b.re).plus(a.im.times(b.im)).div(d), im: a.im.times(b.re).minus(a.re.times(b.im)).div(d) }
}
function cNeg(a: ComplexD): ComplexD {
  return { re: a.re.neg(), im: a.im.neg() }
}
function cConj(a: ComplexD): ComplexD {
  return { re: a.re, im: a.im.neg() }
}
function cPowInt(a: ComplexD, n: number): ComplexD {
  let result: ComplexD = { re: new Decimal(1), im: new Decimal(0) }
  let base = a
  let e = Math.abs(n)
  while (e > 0) {
    if (e & 1) result = cMul(result, base)
    base = cMul(base, base)
    e = Math.floor(e / 2)
  }
  return n < 0 ? cDiv({ re: new Decimal(1), im: new Decimal(0) }, result) : result
}
function realPowInt(x: Decimal, n: number): Decimal {
  let result = new Decimal(1)
  for (let i = 0; i < Math.abs(n); i++) result = result.times(x)
  return n < 0 ? new Decimal(1).div(result) : result
}

function evalBinaryD(op: '+' | '-' | '*' | '/', l: ValD, r: ValD): ValD {
  const bothReal = l.kind === 'real' && r.kind === 'real'
  if (bothReal) {
    const a = l.v as Decimal
    const b = r.v as Decimal
    const v = op === '+' ? a.plus(b) : op === '-' ? a.minus(b) : op === '*' ? a.times(b) : a.div(b)
    return { kind: 'real', v }
  }
  if (op === '+') return { kind: 'complex', v: cAdd(toComplexD(l), toComplexD(r)) }
  if (op === '-') return { kind: 'complex', v: cSub(toComplexD(l), toComplexD(r)) }
  if (op === '*') return { kind: 'complex', v: cMul(toComplexD(l), toComplexD(r)) }
  return { kind: 'complex', v: cDiv(toComplexD(l), toComplexD(r)) }
}

function evalExprD(expr: Expr, env: Map<string, ValD>): ValD {
  switch (expr.kind) {
    case 'num':
      return { kind: 'real', v: new Decimal(expr.value) }
    case 'imag':
      return { kind: 'complex', v: { re: new Decimal(0), im: new Decimal(expr.value) } }
    case 'name': {
      const v = env.get(expr.name)
      if (v) return v
      if (expr.name === 'pi') return { kind: 'real', v: Decimal.acos(-1) }
      if (expr.name === 'e') return { kind: 'real', v: new Decimal(1).exp() }
      throw new DslError(`unknown name '${expr.name}'`, expr.line)
    }
    case 'attr': {
      const obj = evalExprD(expr.obj, env)
      if (obj.kind !== 'complex') throw new DslError(`.${expr.attr} requires a complex value`, expr.line)
      return { kind: 'real', v: expr.attr === 'real' ? obj.v.re : obj.v.im }
    }
    case 'unary': {
      const o = evalExprD(expr.operand, env)
      return o.kind === 'real' ? { kind: 'real', v: (o.v as Decimal).neg() } : { kind: 'complex', v: cNeg(o.v) }
    }
    case 'binary': {
      if (expr.op === '**') {
        const l = evalExprD(expr.left, env)
        const n = tryLiteralInt(expr.right) as number
        return l.kind === 'real' ? { kind: 'real', v: realPowInt(l.v, n) } : { kind: 'complex', v: cPowInt(l.v, n) }
      }
      const l = evalExprD(expr.left, env)
      const r = evalExprD(expr.right, env)
      return evalBinaryD(expr.op as '+' | '-' | '*' | '/', l, r)
    }
    case 'call': {
      const args = expr.args.map((a) => evalExprD(a, env))
      switch (expr.callee) {
        case 'abs': {
          const a = args[0]
          return a.kind === 'real' ? { kind: 'real', v: (a.v as Decimal).abs() } : { kind: 'real', v: a.v.re.pow(2).plus(a.v.im.pow(2)).sqrt() }
        }
        case 'conj': {
          const a = args[0]
          return a.kind === 'real' ? a : { kind: 'complex', v: cConj(a.v) }
        }
        case 're': {
          const a = args[0]
          return a.kind === 'complex' ? { kind: 'real', v: a.v.re } : a
        }
        case 'im': {
          const a = args[0]
          return a.kind === 'complex' ? { kind: 'real', v: a.v.im } : { kind: 'real', v: new Decimal(0) }
        }
        case 'complex':
          return { kind: 'complex', v: { re: args[0].v as Decimal, im: args[1].v as Decimal } }
        case 'pow': {
          const n = tryLiteralInt(expr.args[1]) as number
          const a = args[0]
          return a.kind === 'real' ? { kind: 'real', v: realPowInt(a.v, n) } : { kind: 'complex', v: cPowInt(a.v, n) }
        }
      }
      throw new DslError(`unsupported function '${expr.callee}'`, expr.line)
    }
    default:
      throw new DslError(`unsupported expression form in reference-orbit evaluation`, (expr as Expr).line)
  }
}

export interface ReferenceOrbit {
  zRe: Float32Array
  zIm: Float32Array
  count: number
}

/**
 * Computes the reference orbit Z_0..Z_{maxIter-1} at `precisionDigits` decimal
 * digits, downcasting each step to float32 for GPU upload (safe: Z_n is only
 * ever *multiplied* against tiny deltas in the shader, never added to
 * something astronomically bigger, so it doesn't need extended precision
 * itself — only the one-time computation of Z_n does).
 *
 * `wRef` is passed as decimal strings, not `number` — the anchor point itself
 * needs as many significant digits as the reference orbit's own math (up to
 * ~300), which a float64 can't hold once zoomed past ~1e-16. The caller
 * (useFractalRenderer's view-center accumulator) is what actually carries
 * that precision; a plain JS number here would silently truncate it away
 * before this function ever saw it.
 */
export function computeReferenceOrbit(
  fExpr: Expr,
  z0Expr: Expr,
  wRef: { re: string; im: string },
  c: { re: number; im: number },
  maxIter: number,
  precisionDigits: number,
): ReferenceOrbit {
  const prevPrecision = Decimal.precision
  Decimal.set({ precision: Math.max(20, Math.min(300, precisionDigits)) })
  try {
    const wD: ComplexD = { re: new Decimal(wRef.re), im: new Decimal(wRef.im) }
    const cD: ComplexD = { re: new Decimal(c.re), im: new Decimal(c.im) }

    const zRe = new Float32Array(maxIter)
    const zIm = new Float32Array(maxIter)

    const z0Env = new Map<string, ValD>([
      ['w', { kind: 'complex', v: wD }],
      ['c', { kind: 'complex', v: cD }],
    ])
    let z = toComplexD(evalExprD(z0Expr, z0Env))

    const fEnv = new Map<string, ValD>([
      ['w', { kind: 'complex', v: wD }],
      ['c', { kind: 'complex', v: cD }],
    ])

    for (let i = 0; i < maxIter; i++) {
      zRe[i] = z.re.toNumber()
      zIm[i] = z.im.toNumber()
      fEnv.set('z', { kind: 'complex', v: z })
      fEnv.set('n', { kind: 'real', v: new Decimal(i) })
      z = toComplexD(evalExprD(fExpr, fEnv))
    }

    return { zRe, zIm, count: maxIter }
  } finally {
    Decimal.set({ precision: prevPrecision })
  }
}

// ---------------------------------------------------------------------------
// Series approximation: one power series (in the pixel's dw), shared by every
// pixel, that lets most of them skip straight past the early iterations
// instead of walking delta_f from i=0. This is the classic deep-zoom
// speedup (as in Kalles Fraktaler / Imagina): once maxIter is large, nearly
// all of a pixel's cost is spent re-deriving behavior that looks the same
// across the whole viewport, since the reference orbit dominates and the
// per-pixel offset barely matters yet. Built once per settle, on the CPU,
// right alongside the reference orbit.
//
// Represented as dz_n(dw) = A_1*dw + A_2*dw^2 + ... + A_K*dw^K (a plain
// power series in the single complex variable dw, truncated to
// SERIES_ORDER terms) — sound only for holomorphic formulas, hence
// seriesBlockerInExpr above rejecting abs/conj/re/im/division. The
// recurrence for the A_k themselves reuses the same exact product rule as
// DeltaCompiler (d(ab) = a*db + da*b + da*db), just with "db" now a
// truncated power series instead of a concrete number, which is what makes
// the multiplication a (truncated) convolution instead of a single product.
// ---------------------------------------------------------------------------

export const SERIES_ORDER = 10
// Bounds the one-time CPU cost of building the table: unlike the plain
// reference orbit (O(1) Decimal ops per iteration), each step here costs
// O(SERIES_ORDER^2) floating-point ops, and — for orbits that stay bounded a
// long time, e.g. deep inside a mini-Mandelbrot — the series can in
// principle remain valid for most of a very large maxIter. Stopping here
// still leaves everything past this point to skip, just not quite as much.
const SERIES_MAX_ITERS = 20000
// Relative tolerance: keep extending the series while the highest-order
// term's contribution at the viewport's outer edge (radius maxDw) stays
// under this fraction of the linear term's there. This is a cheap heuristic,
// not a rigorous error bound — once it trips, the truncated polynomial is
// assumed to no longer track the true delta closely enough to trust.
const SERIES_TOL = 1e-3

interface Cplx {
  re: number
  im: number
}

function cAddN(a: Cplx, b: Cplx): Cplx {
  return { re: a.re + b.re, im: a.im + b.im }
}
function cSubN(a: Cplx, b: Cplx): Cplx {
  return { re: a.re - b.re, im: a.im - b.im }
}
function cMulN(a: Cplx, b: Cplx): Cplx {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }
}
function cNegN(a: Cplx): Cplx {
  return { re: -a.re, im: -a.im }
}

// Index 0 is always zero (a delta series never carries a constant term — at
// dw=0 every pixel's delta is exactly 0 by definition); indices 1..SERIES_ORDER
// are the coefficients of dw^1..dw^SERIES_ORDER. Kept at length SERIES_ORDER+1
// (rather than dropping index 0) purely so "coefficient of dw^d" can index by
// d directly instead of d-1 everywhere below.
type Series = Cplx[]

function zeroSeries(): Series {
  return Array.from({ length: SERIES_ORDER + 1 }, () => ({ re: 0, im: 0 }))
}
function identitySeries(): Series {
  const s = zeroSeries()
  s[1] = { re: 1, im: 0 }
  return s
}
function seriesAddN(a: Series, b: Series): Series {
  return a.map((v, i) => cAddN(v, b[i]))
}
function seriesSubN(a: Series, b: Series): Series {
  return a.map((v, i) => cSubN(v, b[i]))
}
function seriesNegN(a: Series): Series {
  return a.map(cNegN)
}
// Exact product rule, generalized from concrete numbers (DeltaCompiler.mul)
// to truncated power series: coefficient of dw^d in (Lref+L(dw))*(Rref+R(dw))
// is Lref*R[d] + L[d]*Rref + sum_{i=1}^{d-1} L[i]*R[d-i] — the last term is
// where the truncation happens (contributions above dw^SERIES_ORDER are
// simply not computed).
function seriesMulN(lRef: Cplx, lSeries: Series, rRef: Cplx, rSeries: Series): Series {
  const result = zeroSeries()
  for (let d = 1; d <= SERIES_ORDER; d++) {
    let acc = cAddN(cMulN(lRef, rSeries[d]), cMulN(lSeries[d], rRef))
    for (let i = 1; i < d; i++) acc = cAddN(acc, cMulN(lSeries[i], rSeries[d - i]))
    result[d] = acc
  }
  return result
}

interface SeriesVal {
  ref: Cplx
  series: Series
}

function seriesPowInt(base: SeriesVal, n: number): SeriesVal {
  if (n === 0) return { ref: { re: 1, im: 0 }, series: zeroSeries() }
  let result = base
  for (let i = 1; i < n; i++) {
    result = { ref: cMulN(result.ref, base.ref), series: seriesMulN(result.ref, result.series, base.ref, base.series) }
  }
  return result
}

/** Interprets expr with SeriesVal arithmetic. Only reachable node shapes are those seriesBlockerInExpr (and describeExprBlocker) allow through: num/imag/name/unary(-)/binary(+,-,*,** with a literal non-negative int)/call(pow). */
function evalExprSeries(expr: Expr, env: Map<string, SeriesVal>): SeriesVal {
  switch (expr.kind) {
    case 'num':
      return { ref: { re: expr.value, im: 0 }, series: zeroSeries() }
    case 'imag':
      return { ref: { re: 0, im: expr.value }, series: zeroSeries() }
    case 'name': {
      const v = env.get(expr.name)
      if (v) return v
      if (expr.name === 'pi') return { ref: { re: Math.PI, im: 0 }, series: zeroSeries() }
      if (expr.name === 'e') return { ref: { re: Math.E, im: 0 }, series: zeroSeries() }
      throw new DslError(`unknown name '${expr.name}'`, expr.line)
    }
    case 'unary': {
      const o = evalExprSeries(expr.operand, env)
      return { ref: cNegN(o.ref), series: seriesNegN(o.series) }
    }
    case 'binary': {
      if (expr.op === '**') {
        const l = evalExprSeries(expr.left, env)
        const n = tryLiteralInt(expr.right) as number
        return seriesPowInt(l, n)
      }
      const l = evalExprSeries(expr.left, env)
      const r = evalExprSeries(expr.right, env)
      if (expr.op === '+') return { ref: cAddN(l.ref, r.ref), series: seriesAddN(l.series, r.series) }
      if (expr.op === '-') return { ref: cSubN(l.ref, r.ref), series: seriesSubN(l.series, r.series) }
      return { ref: cMulN(l.ref, r.ref), series: seriesMulN(l.ref, l.series, r.ref, r.series) } // '*'
    }
    case 'call': {
      const base = evalExprSeries(expr.args[0], env)
      const n = tryLiteralInt(expr.args[1]) as number
      return seriesPowInt(base, n)
    }
    default:
      throw new DslError(`unsupported expression form for series approximation`, (expr as Expr).line)
  }
}

export interface SeriesApproxResult {
  // Interleaved (re, im) pairs for degree 1..SERIES_ORDER; length SERIES_ORDER*2.
  coeffs: Float32Array
  // Iteration index it's sound to jump a pixel to; 0 means "don't" (either
  // the formula isn't eligible, or even the first term didn't look trustworthy).
  skip: number
}

/**
 * Builds the viewport-wide series described above. `wRef`/`c` are the same
 * float32-precision anchor values the shader uses (not the arbitrary-
 * precision Decimal originals) so the coefficients are computed against
 * exactly what delta_f will see at iteration `skip` onward. `maxDw` is the
 * largest |dw| any pixel in the current viewport can have — the caller
 * (useFractalRenderer) derives this from the render's scale and aspect
 * ratio; the table is only valid for pixels within that radius, which the
 * shader checks per-pixel before using it.
 *
 * Not aware of rebasing (see PERTURBED_MAIN_REBASE in shaderTemplate.ts):
 * the recurrence here mirrors delta_f's plain per-iteration form, not the
 * rebase-and-restart one. In practice this isn't a gap — rebasing exists
 * because a pixel's delta has grown too large relative to the reference,
 * and that's exactly the condition SERIES_TOL is watching for too, so the
 * series stops extending before a rebase would have been needed.
 */
export function computeSeriesApproximation(
  fExpr: Expr,
  z0Expr: Expr,
  orbit: ReferenceOrbit,
  wRef: { re: number; im: number },
  c: { re: number; im: number },
  bailout: number,
  maxDw: number,
): SeriesApproxResult {
  const disabled: SeriesApproxResult = { coeffs: new Float32Array(SERIES_ORDER * 2), skip: 0 }
  if (describeExprBlocker(fExpr) || describeExprBlocker(z0Expr) || seriesBlockerInExpr(fExpr) || seriesBlockerInExpr(z0Expr)) {
    return disabled
  }
  if (!(maxDw > 0) || orbit.count === 0) return disabled

  const isValid = (s: Series): boolean => {
    let linear = 0
    let top = 0
    for (let d = 1; d <= SERIES_ORDER; d++) {
      const mag = Math.hypot(s[d].re, s[d].im) * Math.pow(maxDw, d)
      if (!Number.isFinite(mag)) return false
      if (d === 1) linear = mag
      top = mag
    }
    if (linear === 0) return true // e.g. z0 doesn't depend on w at all yet (plain Mandelbrot's z0=0) — not unsafe, just not informative yet
    return top < SERIES_TOL * linear
  }

  const z0Env = new Map<string, SeriesVal>([
    ['w', { ref: wRef, series: identitySeries() }],
    ['c', { ref: c, series: zeroSeries() }],
  ])
  let current: SeriesVal
  try {
    current = evalExprSeries(z0Expr, z0Env)
  } catch {
    return disabled
  }
  if (!isValid(current.series)) return disabled

  const cap = Math.min(orbit.count - 1, SERIES_MAX_ITERS)
  const bailoutGuard2 = (bailout * 0.5) ** 2
  let skip = 0

  const fEnv = new Map<string, SeriesVal>([
    ['w', { ref: wRef, series: identitySeries() }],
    ['c', { ref: c, series: zeroSeries() }],
  ])

  for (let n = 0; n < cap; n++) {
    const Zn: Cplx = { re: orbit.zRe[n], im: orbit.zIm[n] }
    // Reference already close to escaping — stop extending here rather than
    // risk jumping a pixel past the point where its true escape iteration
    // (and hence its smooth-coloring value) would have mattered.
    if (Zn.re * Zn.re + Zn.im * Zn.im > bailoutGuard2) break
    fEnv.set('z', { ref: Zn, series: current.series })
    fEnv.set('n', { ref: { re: n, im: 0 }, series: zeroSeries() })
    let next: SeriesVal
    try {
      next = evalExprSeries(fExpr, fEnv)
    } catch {
      break
    }
    if (!isValid(next.series)) break
    current = next
    skip = n + 1
  }

  if (skip === 0) return disabled

  const coeffs = new Float32Array(SERIES_ORDER * 2)
  for (let d = 1; d <= SERIES_ORDER; d++) {
    coeffs[(d - 1) * 2] = current.series[d].re
    coeffs[(d - 1) * 2 + 1] = current.series[d].im
  }
  return { coeffs, skip }
}

// ---------------------------------------------------------------------------
// Delta compiler: dual-number automatic differentiation, AST -> GLSL.
// Emits statements into temp variables (not nested expression text) so
// repeated operations (e.g. z**8 via 7 multiplications) grow code linearly,
// not exponentially — the product rule alone triples text size per naive
// nesting level, which blows up fast without this.
// ---------------------------------------------------------------------------

interface DeltaCompiled {
  refCode: string
  refType: GlslType
  deltaCode: string
}

function toComplexGlsl(code: string, type: GlslType): string {
  return type === 'complex' ? code : `vec2(${code}, 0.0)`
}

function formatFloat32(n: number): string {
  if (!Number.isFinite(n)) return '0.0'
  let s = n.toString()
  if (s.includes('e') || s.includes('E')) {
    if (!s.includes('.')) {
      const idx = s.search(/[eE]/)
      s = s.slice(0, idx) + '.0' + s.slice(idx)
    }
  } else if (!s.includes('.')) {
    s += '.0'
  }
  return s
}

class DeltaCompiler {
  private lines: string[] = []
  private tempCounter = 0
  private refCompiler: FunctionCompiler
  // Set when the delta chain includes a genuine first-order-only
  // approximation — division is the only one left (see div() below; abs()
  // used to be one too, until deltaAbs replaced its sign(Z)*delta rule with
  // an exact one). Perturbation callers check this to skip rebasing for such
  // formulas, since rebasing assumes the delta chain is exact.
  private approximate = false

  constructor(private env: Map<string, GlslType>) {
    this.refCompiler = new FunctionCompiler(env, 'perturbation_ref')
  }

  isApproximate(): boolean {
    return this.approximate
  }

  getLines(): string[] {
    return this.lines
  }

  private freshVar(prefix: string): string {
    return `${prefix}${this.tempCounter++}`
  }

  private emitTemp(refType: GlslType, refExpr: string, deltaExpr: string): DeltaCompiled {
    const glslType = refType === 'complex' ? 'vec2' : 'float'
    const refVar = this.freshVar('_r')
    const deltaVar = this.freshVar('_d')
    this.lines.push(`${glslType} ${refVar} = ${refExpr};`)
    this.lines.push(`${glslType} ${deltaVar} = ${deltaExpr};`)
    return { refCode: refVar, refType, deltaCode: deltaVar }
  }

  compile(expr: Expr): DeltaCompiled {
    switch (expr.kind) {
      case 'num':
        return { refCode: formatFloat32(expr.value), refType: 'real', deltaCode: '0.0' }
      case 'imag':
        return { refCode: `vec2(0.0, ${formatFloat32(expr.value)})`, refType: 'complex', deltaCode: 'vec2(0.0, 0.0)' }
      case 'name': {
        if (expr.name === 'z') return { refCode: 'z', refType: 'complex', deltaCode: 'dz' }
        if (expr.name === 'w') return { refCode: 'w', refType: 'complex', deltaCode: 'dw' }
        // c is the same for every pixel, so it has no *per-pixel* delta — but
        // it can still change *between frames* while the reference orbit
        // (computed CPU-side, once, at whatever c was current then) stays
        // fixed until the next settle. u_cDrift is live_c - baseline_c,
        // uploaded fresh every draw; folding it in here via the exact
        // product rule (same trick as w/dw) makes a live c-slider drag
        // update the image immediately and exactly on the GPU, with no
        // reference-orbit recompute needed until the drag settles.
        if (expr.name === 'c') return { refCode: 'c', refType: 'complex', deltaCode: 'u_cDrift' }
        if (expr.name === 'n') return { refCode: 'n', refType: 'real', deltaCode: '0.0' }
        if (expr.name === 'pi' || expr.name === 'e') {
          const ref = this.refCompiler.compileStandaloneExpr(expr, this.env)
          return { refCode: ref.code, refType: 'real', deltaCode: '0.0' }
        }
        throw new DslError(`unknown name '${expr.name}'`, expr.line)
      }
      case 'attr': {
        const inner = this.compile(expr.obj)
        if (inner.refType !== 'complex') throw new DslError(`.${expr.attr} requires a complex value`, expr.line)
        const comp = expr.attr === 'real' ? 'x' : 'y'
        return this.emitTemp('real', `(${inner.refCode}).${comp}`, `(${inner.deltaCode}).${comp}`)
      }
      case 'unary': {
        if (expr.op !== '-') throw new DslError(`'${expr.op}' isn't supported for deep-zoom perturbation`, expr.line)
        const inner = this.compile(expr.operand)
        return this.emitTemp(inner.refType, `(-${inner.refCode})`, `(-${inner.deltaCode})`)
      }
      case 'binary':
        return this.compileBinary(expr)
      case 'call':
        return this.compileCall(expr)
      default:
        throw new DslError(`this expression form isn't supported for deep-zoom perturbation`, (expr as Expr).line)
    }
  }

  private compileBinary(expr: Extract<Expr, { kind: 'binary' }>): DeltaCompiled {
    if (expr.op === '**') return this.compilePow(expr.left, expr.right, expr.line)
    if (expr.op === '%') throw new DslError(`'%' isn't supported for deep-zoom perturbation`, expr.line)
    const l = this.compile(expr.left)
    const r = this.compile(expr.right)
    switch (expr.op) {
      case '+':
        return this.addSub(l, r, false)
      case '-':
        return this.addSub(l, r, true)
      case '*':
        return this.mul(l, r)
      case '/':
        return this.div(l, r)
    }
    throw new DslError('unreachable', expr.line)
  }

  private addSub(l: DeltaCompiled, r: DeltaCompiled, isSub: boolean): DeltaCompiled {
    const op = isSub ? '-' : '+'
    if (l.refType === 'real' && r.refType === 'real') {
      return this.emitTemp('real', `(${l.refCode} ${op} ${r.refCode})`, `(${l.deltaCode} ${op} ${r.deltaCode})`)
    }
    const lRefC = toComplexGlsl(l.refCode, l.refType)
    const rRefC = toComplexGlsl(r.refCode, r.refType)
    const lDeltaC = toComplexGlsl(l.deltaCode, l.refType)
    const rDeltaC = toComplexGlsl(r.deltaCode, r.refType)
    return this.emitTemp('complex', `(${lRefC} ${op} ${rRefC})`, `(${lDeltaC} ${op} ${rDeltaC})`)
  }

  // Exact product rule: d(ab) = a*db + da*b + da*db (the da*db term makes
  // this an exact identity, not just a first-order approximation).
  private mul(l: DeltaCompiled, r: DeltaCompiled): DeltaCompiled {
    if (l.refType === 'real' && r.refType === 'real') {
      return this.emitTemp(
        'real',
        `(${l.refCode} * ${r.refCode})`,
        `(${l.refCode} * ${r.deltaCode} + ${l.deltaCode} * ${r.refCode} + ${l.deltaCode} * ${r.deltaCode})`,
      )
    }
    const lRefC = toComplexGlsl(l.refCode, l.refType)
    const rRefC = toComplexGlsl(r.refCode, r.refType)
    const lDeltaC = toComplexGlsl(l.deltaCode, l.refType)
    const rDeltaC = toComplexGlsl(r.deltaCode, r.refType)
    return this.emitTemp(
      'complex',
      `cmul(${lRefC}, ${rRefC})`,
      `(cmul(${lRefC}, ${rDeltaC}) + cmul(${lDeltaC}, ${rRefC}) + cmul(${lDeltaC}, ${rDeltaC}))`,
    )
  }

  // First-order approximation for division: d(a/b) ≈ (da - (a/b)*db) / b.
  // Rare in fractal formulas — none of the built-in presets use it in f.
  private div(l: DeltaCompiled, r: DeltaCompiled): DeltaCompiled {
    this.approximate = true
    if (l.refType === 'real' && r.refType === 'real') {
      return this.emitTemp(
        'real',
        `(${l.refCode} / ${r.refCode})`,
        `((${l.deltaCode} - (${l.refCode} / ${r.refCode}) * ${r.deltaCode}) / ${r.refCode})`,
      )
    }
    const lRefC = toComplexGlsl(l.refCode, l.refType)
    const rRefC = toComplexGlsl(r.refCode, r.refType)
    const lDeltaC = toComplexGlsl(l.deltaCode, l.refType)
    const rDeltaC = toComplexGlsl(r.deltaCode, r.refType)
    const refVar = this.freshVar('_r')
    this.lines.push(`vec2 ${refVar} = cdiv(${lRefC}, ${rRefC});`)
    const deltaVar = this.freshVar('_d')
    this.lines.push(`vec2 ${deltaVar} = cdiv((${lDeltaC} - cmul(${refVar}, ${rDeltaC})), ${rRefC});`)
    return { refCode: refVar, refType: 'complex', deltaCode: deltaVar }
  }

  private compilePow(leftExpr: Expr, rightExpr: Expr, line: number): DeltaCompiled {
    const n = tryLiteralInt(rightExpr)
    if (n === null || Math.abs(n) > 64) {
      throw new DslError(`perturbation requires a literal integer exponent (e.g. z**2)`, line)
    }
    const base = this.compile(leftExpr)
    if (n === 0) {
      const one = base.refType === 'complex' ? 'vec2(1.0, 0.0)' : '1.0'
      const zero = base.refType === 'complex' ? 'vec2(0.0, 0.0)' : '0.0'
      return this.emitTemp(base.refType, one, zero)
    }
    let result = base
    for (let i = 1; i < Math.abs(n); i++) {
      result = this.mul(result, base)
    }
    if (n < 0) {
      const oneRef = base.refType === 'complex' ? 'vec2(1.0, 0.0)' : '1.0'
      const oneDelta = base.refType === 'complex' ? 'vec2(0.0, 0.0)' : '0.0'
      const one = this.emitTemp(base.refType, oneRef, oneDelta)
      result = this.div(one, result)
    }
    return result
  }

  private compileCall(expr: Extract<Expr, { kind: 'call' }>): DeltaCompiled {
    const { callee, args, line } = expr
    switch (callee) {
      case 'abs': {
        const a = this.compile(args[0])
        if (a.refType !== 'real') {
          throw new DslError(`abs() of a complex value isn't supported for deep-zoom perturbation (abs() of a real part, e.g. abs(z.real), is fine)`, line)
        }
        // Exact, not linearized: sign(x) is only the right delta rule away
        // from a sign change (e.g. Burning Ship's abs() folds — any view
        // spanning x=0 has pixels on both sides of the reference orbit's
        // sign, where sign(ref)*delta is flatly wrong, not just approximate).
        // deltaAbs (see COMPLEX_HELPERS) handles the crossing case exactly
        // instead, so abs() no longer needs the approximate/naive fallback.
        return this.emitTemp('real', `abs(${a.refCode})`, `deltaAbs(${a.refCode}, ${a.deltaCode})`)
      }
      case 'conj': {
        const a = this.compile(args[0])
        if (a.refType !== 'complex') return a
        return this.emitTemp('complex', `conj(${a.refCode})`, `conj(${a.deltaCode})`)
      }
      case 're': {
        const a = this.compile(args[0])
        if (a.refType !== 'complex') return a
        return this.emitTemp('real', `(${a.refCode}).x`, `(${a.deltaCode}).x`)
      }
      case 'im': {
        const a = this.compile(args[0])
        if (a.refType !== 'complex') return this.emitTemp('real', '0.0', '0.0')
        return this.emitTemp('real', `(${a.refCode}).y`, `(${a.deltaCode}).y`)
      }
      case 'complex': {
        const re = this.compile(args[0])
        const im = this.compile(args[1])
        return this.emitTemp('complex', `vec2(${re.refCode}, ${im.refCode})`, `vec2(${re.deltaCode}, ${im.deltaCode})`)
      }
      case 'pow':
        return this.compilePow(args[0], args[1], line)
      default:
        throw new DslError(`'${callee}()' isn't supported for deep-zoom perturbation yet`, line)
    }
  }
}

function indent(line: string): string {
  return '  ' + line
}

export interface CompiledPerturbation {
  glsl: string // defines delta_f(vec2 dz, vec2 dw, vec2 Z, vec2 c, float n) and delta_z0(vec2 dw)
  // Whether delta_f's chain is exact (pure +-*/, integer powers, and abs()
  // via deltaAbs — all exact identities) rather than relying on division's
  // first-order approximation (see DeltaCompiler.approximate). Callers should
  // only enable rebasing when this is true; non-exact formulas should use the
  // plain per-iteration indexing instead and rely on the NaN/overflow
  // fallback.
  isExact: boolean
}

/** Compiles the dual-number delta functions for f and z0. Callers must check isPerturbable first. */
export function compilePerturbation(fExpr: Expr, z0Expr: Expr): CompiledPerturbation {
  const fEnv = new Map<string, GlslType>([
    ['z', 'complex'],
    ['w', 'complex'],
    ['c', 'complex'],
    ['n', 'real'],
  ])
  const fCompiler = new DeltaCompiler(fEnv)
  const fResult = fCompiler.compile(fExpr)
  // A real number is a valid complex number (imaginary part 0) — same
  // implicit widening the main compiler allows on return, needed here since
  // e.g. z0 = "0" (the default) is a real literal.
  const fReturnDelta = toComplexGlsl(fResult.deltaCode, fResult.refType)
  const fGlsl = [
    'vec2 delta_f(vec2 dz, vec2 dw, vec2 Z, vec2 c, float n) {',
    '  vec2 z = Z;',
    '  vec2 w = u_wRef;',
    ...fCompiler.getLines().map(indent),
    `  return ${fReturnDelta};`,
    '}',
  ].join('\n')

  const z0Env = new Map<string, GlslType>([
    ['w', 'complex'],
    ['c', 'complex'],
  ])
  const z0Compiler = new DeltaCompiler(z0Env)
  const z0Result = z0Compiler.compile(z0Expr)
  const z0ReturnDelta = toComplexGlsl(z0Result.deltaCode, z0Result.refType)
  const z0Glsl = [
    'vec2 delta_z0(vec2 dw) {',
    '  vec2 w = u_wRef;',
    ...z0Compiler.getLines().map(indent),
    `  return ${z0ReturnDelta};`,
    '}',
  ].join('\n')

  return { glsl: [fGlsl, z0Glsl].join('\n\n'), isExact: !fCompiler.isApproximate() }
}
