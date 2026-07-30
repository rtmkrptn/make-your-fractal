// Runs computeReferenceOrbit off the main thread. That function is CPU-bound
// arbitrary-precision (decimal.js) math — O(maxIter) Decimal ops at up to 300
// digits of precision — and was previously called directly from the render
// hook, which froze pointer/wheel handling and React updates for the whole
// duration on any deep-zoom settle. Moving it here means panning/zooming
// keeps responding immediately; the (possibly stale, already-uploaded)
// reference orbit keeps rendering until this finishes and the hook uploads
// the fresh one.
//
// Also builds the series-approximation table (computeSeriesApproximation)
// right alongside the reference orbit it depends on — see perturbation.ts for
// what that buys.
import { computeReferenceOrbit, computeSeriesApproximation, SERIES_ORDER } from '../dsl/perturbation'
import { Expr } from '../dsl/ast'

export interface OrbitRequest {
  id: number
  fExpr: Expr
  z0Expr: Expr
  // Decimal strings, not numbers — see computeReferenceOrbit's doc comment.
  wRef: { re: string; im: string }
  c: { re: number; im: number }
  maxIter: number
  precisionDigits: number
  bailout: number
  // Largest |dw| any pixel in the current viewport can have — see
  // computeSeriesApproximation's doc comment.
  maxDw: number
}

export interface OrbitResponse {
  id: number
  wRef: { re: string; im: string }
  c: { re: number; im: number }
  zRe: Float32Array
  zIm: Float32Array
  count: number
  saCoeffs: Float32Array
  saSkip: number
  maxDw: number
  error?: string
}

self.onmessage = (e: MessageEvent<OrbitRequest>) => {
  const req = e.data
  try {
    const orbit = computeReferenceOrbit(req.fExpr, req.z0Expr, req.wRef, req.c, req.maxIter, req.precisionDigits)
    const sa = computeSeriesApproximation(
      req.fExpr,
      req.z0Expr,
      orbit,
      { re: Number(req.wRef.re), im: Number(req.wRef.im) },
      req.c,
      req.bailout,
      req.maxDw,
    )
    const response: OrbitResponse = {
      id: req.id,
      wRef: req.wRef,
      c: req.c,
      zRe: orbit.zRe,
      zIm: orbit.zIm,
      count: orbit.count,
      saCoeffs: sa.coeffs,
      saSkip: sa.skip,
      maxDw: req.maxDw,
    }
    ;(self as unknown as Worker).postMessage(response, [orbit.zRe.buffer, orbit.zIm.buffer, sa.coeffs.buffer])
  } catch (err) {
    const response: OrbitResponse = {
      id: req.id,
      wRef: req.wRef,
      c: req.c,
      zRe: new Float32Array(0),
      zIm: new Float32Array(0),
      count: 0,
      saCoeffs: new Float32Array(SERIES_ORDER * 2),
      saSkip: 0,
      maxDw: 0,
      error: err instanceof Error ? err.message : String(err),
    }
    ;(self as unknown as Worker).postMessage(response)
  }
}
