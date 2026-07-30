// Runs computeReferenceOrbit off the main thread. That function is CPU-bound
// arbitrary-precision (decimal.js) math — O(maxIter) Decimal ops at up to 300
// digits of precision — and was previously called directly from the render
// hook, which froze pointer/wheel handling and React updates for the whole
// duration on any deep-zoom settle. Moving it here means panning/zooming
// keeps responding immediately; the (possibly stale, already-uploaded)
// reference orbit keeps rendering until this finishes and the hook uploads
// the fresh one.
import { computeReferenceOrbit } from '../dsl/perturbation'
import { Expr } from '../dsl/ast'

export interface OrbitRequest {
  id: number
  fExpr: Expr
  z0Expr: Expr
  wRef: { re: number; im: number }
  c: { re: number; im: number }
  maxIter: number
  precisionDigits: number
}

export interface OrbitResponse {
  id: number
  wRef: { re: number; im: number }
  c: { re: number; im: number }
  zRe: Float32Array
  zIm: Float32Array
  count: number
  error?: string
}

self.onmessage = (e: MessageEvent<OrbitRequest>) => {
  const req = e.data
  try {
    const orbit = computeReferenceOrbit(req.fExpr, req.z0Expr, req.wRef, req.c, req.maxIter, req.precisionDigits)
    const response: OrbitResponse = { id: req.id, wRef: req.wRef, c: req.c, zRe: orbit.zRe, zIm: orbit.zIm, count: orbit.count }
    ;(self as unknown as Worker).postMessage(response, [orbit.zRe.buffer, orbit.zIm.buffer])
  } catch (err) {
    const response: OrbitResponse = {
      id: req.id,
      wRef: req.wRef,
      c: req.c,
      zRe: new Float32Array(0),
      zIm: new Float32Array(0),
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    }
    ;(self as unknown as Worker).postMessage(response)
  }
}
