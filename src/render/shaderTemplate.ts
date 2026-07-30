// The static parts of the fragment shader: single-precision complex-number
// helpers and color palettes. User-compiled GLSL (user_f, user_rule,
// user_z0) is spliced in, and buildFragmentShader() assembles the final
// source that drives the escape-time loop.
//
// Two render paths:
//  - Plain: the whole iteration runs in ordinary float32, calling
//    user_f/user_rule/user_z0 directly. Fine down to ~1e-6 zoom scale.
//  - Perturbation (pass a `perturbationGlsl` string): the CPU has already
//    computed a high-precision reference orbit; the shader only tracks each
//    pixel's tiny *delta* from it (delta_f/delta_z0, see perturbation.ts),
//    reconstructing the full z only where it's needed (user_rule) via a
//    single float32 add that's always safe because both terms are
//    comparable in magnitude at that point. See src/dsl/perturbation.ts for
//    why this reaches far deeper zoom than raising precision ever could.
//    Eligible formulas additionally get a series-approximation jump (see
//    saEval/PERTURBED_MAIN_REBASE below) that skips most pixels straight to
//    a later iteration instead of starting the delta_f loop at i=0.

import { SERIES_ORDER } from '../dsl/perturbation'

export const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

const COMPLEX_HELPERS = `
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 cdiv(vec2 a, vec2 b) {
  float d = dot(b, b);
  return vec2(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y) / max(d, 1e-20);
}
float cabs(vec2 a) { return length(a); }
float carg(vec2 a) { return atan(a.y, a.x); }
vec2 conj(vec2 a) { return vec2(a.x, -a.y); }
vec2 cexp(vec2 a) { float m = exp(a.x); return vec2(m*cos(a.y), m*sin(a.y)); }
vec2 clog(vec2 a) { return vec2(log(max(length(a), 1e-20)), atan(a.y, a.x)); }
vec2 cpow(vec2 a, vec2 b) {
  if (a.x == 0.0 && a.y == 0.0) return vec2(0.0);
  return cexp(cmul(b, clog(a)));
}
vec2 csin(vec2 a) { return vec2(sin(a.x)*cosh(a.y), cos(a.x)*sinh(a.y)); }
vec2 ccos(vec2 a) { return vec2(cos(a.x)*cosh(a.y), -sin(a.x)*sinh(a.y)); }
vec2 ctan(vec2 a) { return cdiv(csin(a), ccos(a)); }
vec2 csqrt(vec2 a) {
  float r = length(a);
  float re = sqrt(max((r + a.x) * 0.5, 0.0));
  float im = sqrt(max((r - a.x) * 0.5, 0.0));
  return vec2(re, a.y < 0.0 ? -im : im);
}
// Exact delta rule for abs() in perturbation mode: sign(ref) is only the
// correct derivative away from a sign change. When ref and ref+delta land on
// the same side of zero, abs(full)-abs(ref) collapses algebraically to
// exactly sign(ref)*delta (no precision lost even if delta is astronomically
// tiny, since it's a pure scaling, not a subtraction of close quantities).
// When they don't — a real sign crossing — delta is provably at least as
// large in magnitude as ref (that's what crossing zero means), so computing
// abs(full)-abs(ref) directly is also safe: it's never cancelling two nearly
// equal large values down to a tiny, precision-starved residual.
float deltaAbs(float ref, float delta) {
  float full = ref + delta;
  if (sign(full) == sign(ref)) return sign(ref) * delta;
  return abs(full) - abs(ref);
}
// Exact integer powers via exponentiation by squaring — used instead of
// cpow (exp/log based) whenever the exponent is a compile-time integer
// literal, since it avoids exp/log round-trip error for things like
// (-1+0i)^2 landing a hair off of exactly 1.
vec2 cpowInt(vec2 base, int n) {
  vec2 one = vec2(1.0, 0.0);
  vec2 result = one;
  vec2 acc = base;
  int e = n < 0 ? -n : n;
  for (int i = 0; i < 16; i++) {
    if (e <= 0) break;
    if (e - (e / 2) * 2 == 1) result = cmul(result, acc);
    acc = cmul(acc, acc);
    e = e / 2;
  }
  return n < 0 ? cdiv(one, result) : result;
}
`

const PALETTES = `
vec3 palette_classic(float t) {
  return 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.15, 0.3) + t * vec3(1.0, 1.0, 1.0)));
}
vec3 palette_fire(float t) {
  return clamp(vec3(t * 1.8, pow(t, 1.6) * 1.3, pow(t, 3.0)), 0.0, 1.0);
}
vec3 palette_ocean(float t) {
  return clamp(vec3(pow(t, 3.0) * 0.6, t * 0.9, 0.5 + t * 0.5), 0.0, 1.0);
}
vec3 palette_grayscale(float t) {
  return vec3(t);
}
vec3 palette_electric(float t) {
  return clamp(vec3(pow(t, 4.0), pow(t, 1.5), 0.4 + 0.6 * sin(t * 6.28318 + 1.0)), 0.0, 1.0);
}
vec3 palette_sunset(float t) {
  return 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.35, 0.6) + t * vec3(0.8, 0.6, 0.4)));
}
vec3 palette_forest(float t) {
  return clamp(vec3(pow(t, 2.5) * 0.5, 0.25 + t * 0.65, pow(t, 4.0) * 0.35 + t * 0.1), 0.0, 1.0);
}
vec3 palette_ice(float t) {
  return clamp(vec3(pow(t, 2.0) * 0.5 + 0.15, 0.55 + t * 0.45, 0.8 + 0.2 * sin(t * 6.28318)), 0.0, 1.0);
}
vec3 palette_neon(float t) {
  return 0.5 + 0.5 * cos(6.28318 * (vec3(0.7, 0.2, 0.9) + t * vec3(0.9, 1.3, 0.6)));
}
vec3 palette_pastel(float t) {
  return 0.72 + 0.24 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + t));
}
vec3 applyPalette(float t, int scheme) {
  if (scheme == 0) return palette_classic(t);
  if (scheme == 1) return palette_fire(t);
  if (scheme == 2) return palette_ocean(t);
  if (scheme == 3) return palette_electric(t);
  if (scheme == 4) return palette_sunset(t);
  if (scheme == 5) return palette_forest(t);
  if (scheme == 6) return palette_ice(t);
  if (scheme == 7) return palette_neon(t);
  if (scheme == 8) return palette_pastel(t);
  return palette_grayscale(t);
}
`

// All uniforms for both paths are declared here — before user_f/user_rule/
// user_z0 and the perturbation delta_f/delta_z0 functions get spliced in —
// since delta_f/delta_z0 reference u_wRef directly and GLSL, like C,
// requires declaration before use. Declaring the handful of unused-in-one-
// path uniforms (e.g. u_center when perturbing) is harmless.
const HEADER = `
uniform vec2 u_resolution;
uniform float u_scale;
uniform int u_maxIter;
uniform float u_bailout;
uniform int u_colorScheme;
uniform vec2 u_c;
uniform vec2 u_center;
uniform vec2 u_wRef;
uniform vec2 u_centerDrift;
// Baseline c the reference orbit was computed with, and how far the live c
// (u_c, from the julia-constant control) has drifted from it since — see
// DeltaCompiler's 'c' case in perturbation.ts for why this makes c-dragging
// live in deep zoom instead of frozen until the next CPU recompute.
uniform vec2 u_cRef;
uniform vec2 u_cDrift;
// Series-approximation table (see computeSeriesApproximation in
// perturbation.ts): u_saSkip <= 0 means "no table" (formula ineligible, or
// even the first term wasn't trustworthy) — declared unconditionally like
// the rest of this header, harmless to leave unused on the plain path.
uniform vec2 u_saCoeffs[${SERIES_ORDER}];
uniform int u_saSkip;
uniform float u_saMaxDw2;
out vec4 fragColor;
`

// Periodicity checking (Brent-style checkpoint doubling): a pixel that never
// escapes almost always does so because it's settled into a periodic cycle —
// that's what "being in the interior of a hyperbolic component" *means*
// dynamically. Once the orbit returns this close to a saved checkpoint it's
// bound to keep repeating, so we can stop instead of grinding out the rest of
// maxIter. Checkpoint spacing doubles (0, 1, 2, 4, 8, ...) so the checking
// overhead stays O(log period) rather than O(period), and the tolerance
// (1e-14 on squared distance, i.e. ~1e-7 absolute — right at float32's own
// noise floor) is tight enough that a chaotic/escaping orbit essentially
// never triggers it by accident: exponential sensitivity to initial
// conditions means only a genuinely converged cycle returns this close.
// `startVar` is the loop's actual starting iteration (0 normally; can be
// >0 when a series-approximation jump skips straight past it — see
// PERTURBED_MAIN_REBASE) — checkIter needs to start there too, and the
// distance check needs to skip that first iteration specifically (not just
// "i == 0"), or a jumped pixel would spuriously compare against an
// uninitialized zCheck and break immediately.
const PERIODICITY_INIT = (startVar: string) => `
  vec2 zCheck = vec2(0.0);
  int checkIter = ${startVar};
  bool periodFirst = true;
`
const PERIODICITY_CHECK = (zVar: string) => `
    if (!periodFirst) {
      vec2 dCheck = ${zVar} - zCheck;
      if (dot(dCheck, dCheck) < 1e-14) break;
    }
    periodFirst = false;
    if (i == checkIter) { zCheck = ${zVar}; checkIter = checkIter == 0 ? 1 : checkIter * 2; }
`

const PLAIN_MAIN = `
vec3 computePixel(vec2 w, vec2 c) {
  vec2 z = user_z0(w, c);
  float bailout2 = u_bailout * u_bailout;
  bool escaped = false;
  int iter = 0;
  ${PERIODICITY_INIT('0')}

  for (int i = 0; i < 100000; i++) {
    if (i >= u_maxIter) break;
    iter = i;
    if (user_rule(z, w, c, float(i))) { escaped = true; break; }
    if (dot(z, z) > bailout2 * 1e6) { escaped = true; break; }
    ${PERIODICITY_CHECK('z')}
    z = user_f(z, w, c, float(i));
  }

  if (!escaped) return vec3(0.0);

  float smoothIter = float(iter);
  float mag = cabs(z);
  if (mag > 1.0001) {
    smoothIter = float(iter) - log2(max(log(mag) / log(u_bailout), 1e-6));
  }
  float t = fract(smoothIter * 0.035 + 0.75);
  return applyPalette(t, u_colorScheme);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
  vec2 w = u_center + uv * u_scale * 2.0;
  fragColor = vec4(computePixel(w, u_c), 1.0);
}
`

// u_wRef, u_centerDrift, u_c are declared in the shared header above (needed
// there since delta_f/delta_z0, spliced in before this, reference u_wRef).
// The reference orbit is only recomputed when the view settles (recomputing
// it is a CPU-side arbitrary-precision calculation, too slow to redo every
// frame during a drag) — u_centerDrift is how far the view center has moved
// since, computed in JS float64, which is exact enough for the (bounded,
// human-scale) distance covered by one interactive gesture.
const PERTURBED_UNIFORM = `
uniform sampler2D u_refOrbit;

// Series-approximation jump: evaluates the CPU-built polynomial
// dz(dw) = A_1*dw + A_2*dw^2 + ... + A_SERIES_ORDER*dw^SERIES_ORDER via
// Horner's method, so a pixel can start its delta_f loop at iteration
// u_saSkip instead of 0 — see computeSeriesApproximation in perturbation.ts
// for how the coefficients and skip point are chosen.
vec2 saEval(vec2 dw) {
  vec2 acc = u_saCoeffs[${SERIES_ORDER - 1}];
  for (int k = ${SERIES_ORDER - 2}; k >= 0; k--) {
    acc = cmul(acc, dw) + u_saCoeffs[k];
  }
  return cmul(dw, acc);
}
`

const PERTURBED_TAIL = `
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
  vec2 dw = u_centerDrift + uv * u_scale * 2.0;
  fragColor = vec4(computePixelPerturbed(dw), 1.0);
}
`

// Rebasing (Zhuoran's method, as used in Fraktaler 3 and mandelbrot.site):
// once a pixel's delta stops being small relative to the true orbit value
// there — the classic cause of perturbation "glitches", visible as
// speckling/banding in regions whose true orbit diverges from the single
// shared reference, and which can even flicker between renders as the
// reference orbit gets recomputed on each settle — restart it against the
// start of the orbit instead of continuing to compound error. iter is
// untouched, so escape timing and smooth coloring stay correct.
//
// Only safe for EXACT delta chains (pure +-*/, integer powers, and abs() via
// deltaAbs — see perturbation.ts). Division's delta rule is a genuine
// first-order approximation (no exact identity for it here), so formulas
// using it still fall back to PERTURBED_MAIN_NAIVE below instead — see
// CompiledPerturbation.isExact.
const PERTURBED_MAIN_REBASE = `
vec3 computePixelPerturbed(vec2 dw) {
  float bailout2 = u_bailout * u_bailout;
  bool escaped = false;
  bool numericFailure = false;
  int iter = 0;
  vec2 z_full = vec2(0.0);
  int lastIndex = u_maxIter - 1;
  // Where this pixel's loop actually starts — 0 normally, or u_saSkip when
  // the series-approximation table covers this pixel's dw (within the
  // table's guaranteed radius u_saMaxDw2) and the jump lands somewhere
  // finite. A jump that's wrong would be worse than one that's merely slow,
  // so any hint of trouble (NaN/Inf, or dw outside the table's radius) just
  // falls back to the ordinary i=0 start.
  int startI = 0;
  vec2 dz;
  if (u_saSkip > 0 && dot(dw, dw) <= u_saMaxDw2) {
    vec2 dzJump = saEval(dw);
    if (!any(isnan(dzJump)) && !any(isinf(dzJump))) {
      dz = dzJump;
      startI = min(u_saSkip, lastIndex);
    } else {
      dz = delta_z0(dw);
    }
  } else {
    dz = delta_z0(dw);
  }
  vec2 w_full = u_wRef + dw;
  // The reference-orbit index a pixel is tracking its delta against. Usually
  // equal to the true iteration count i, but rebasing can reset it back to 0
  // without resetting i — see below.
  int refIndex = startI;
  // Carries the already-fetched reference-orbit value forward each
  // iteration, so the rebase check's lookahead fetch below doubles as the
  // next iteration's fetch instead of the same texel being fetched twice —
  // keeps this at one texelFetch per iteration in the common case, with a
  // second fetch only on the rare iteration where a rebase actually fires.
  vec2 Z = texelFetch(u_refOrbit, ivec2(refIndex, 0), 0).xy;
  ${PERIODICITY_INIT('startI')}

  for (int i = startI; i < 100000; i++) {
    if (i >= u_maxIter) break;
    iter = i;
    z_full = Z + dz;
    if (any(isnan(z_full)) || any(isinf(z_full))) { escaped = true; numericFailure = true; break; }
    if (user_rule(z_full, w_full, u_c, float(i))) { escaped = true; break; }
    if (dot(z_full, z_full) > bailout2 * 1e6) { escaped = true; break; }
    ${PERIODICITY_CHECK('z_full')}
    dz = delta_f(dz, dw, Z, u_cRef, float(i));
    if (any(isnan(dz)) || any(isinf(dz)) || dot(dz, dz) > 1e12) { escaped = true; numericFailure = true; break; }
    refIndex += 1;

    vec2 Znext = texelFetch(u_refOrbit, ivec2(refIndex, 0), 0).xy;
    vec2 zNextFull = Znext + dz;
    if (refIndex >= lastIndex || dot(zNextFull, zNextFull) < dot(dz, dz)) {
      dz = zNextFull;
      refIndex = 0;
      Znext = texelFetch(u_refOrbit, ivec2(0, 0), 0).xy;
    }
    Z = Znext;
  }

  if (!escaped) return vec3(0.0);

  float smoothIter = float(iter);
  if (!numericFailure) {
    float mag = cabs(z_full);
    if (mag > 1.0001) {
      smoothIter = float(iter) - log2(max(log(mag) / log(u_bailout), 1e-6));
    }
  }
  float t = fract(smoothIter * 0.035 + 0.75);
  return applyPalette(t, u_colorScheme);
}
` + PERTURBED_TAIL

// Non-rebasing path for approximate (division-using) delta chains: the
// straightforward per-iteration Z = texelFetch(i), relying solely on the
// NaN/overflow guard below when the approximation diverges too far (the
// documented "occasional faint banding" limitation — a much smaller defect
// than rebasing's wrong-answer failure mode for these formulas).
const PERTURBED_MAIN_NAIVE = `
vec3 computePixelPerturbed(vec2 dw) {
  vec2 dz = delta_z0(dw);
  vec2 w_full = u_wRef + dw;
  float bailout2 = u_bailout * u_bailout;
  bool escaped = false;
  bool numericFailure = false;
  int iter = 0;
  vec2 z_full = vec2(0.0);
  ${PERIODICITY_INIT('0')}

  for (int i = 0; i < 100000; i++) {
    if (i >= u_maxIter) break;
    iter = i;
    vec2 Z = texelFetch(u_refOrbit, ivec2(i, 0), 0).xy;
    z_full = Z + dz;
    if (any(isnan(z_full)) || any(isinf(z_full))) { escaped = true; numericFailure = true; break; }
    if (user_rule(z_full, w_full, u_c, float(i))) { escaped = true; break; }
    if (dot(z_full, z_full) > bailout2 * 1e6) { escaped = true; break; }
    ${PERIODICITY_CHECK('z_full')}
    dz = delta_f(dz, dw, Z, u_cRef, float(i));
    if (any(isnan(dz)) || any(isinf(dz)) || dot(dz, dz) > 1e12) { escaped = true; numericFailure = true; break; }
  }

  if (!escaped) return vec3(0.0);

  float smoothIter = float(iter);
  if (!numericFailure) {
    float mag = cabs(z_full);
    if (mag > 1.0001) {
      smoothIter = float(iter) - log2(max(log(mag) / log(u_bailout), 1e-6));
    }
  }
  float t = fract(smoothIter * 0.035 + 0.75);
  return applyPalette(t, u_colorScheme);
}
` + PERTURBED_TAIL

/**
 * Assembles the full fragment shader. Pass `perturbationGlsl` (delta_f /
 * delta_z0, from src/dsl/perturbation.ts) to use the deep-zoom perturbation
 * path instead of the plain one; `userGlsl` (user_f/user_rule/user_z0) is
 * still included either way since user_rule is reused unchanged, and unused
 * GLSL functions are harmless. `isExact` (from `CompiledPerturbation.isExact`)
 * picks between the rebasing and naive perturbation loops — required when
 * `perturbationGlsl` is passed, since rebasing is unsound for approximate
 * (abs()/division) delta chains; see PERTURBED_MAIN_REBASE's doc comment.
 */
export function buildFragmentShader(userGlsl: string, perturbationGlsl?: string, isExact = true): string {
  return [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    COMPLEX_HELPERS,
    PALETTES,
    HEADER,
    '// ---- user-defined functions ----',
    userGlsl,
    ...(perturbationGlsl
      ? ['// ---- perturbation delta functions ----', perturbationGlsl, PERTURBED_UNIFORM]
      : []),
    '// ---------------------------------',
    perturbationGlsl ? (isExact ? PERTURBED_MAIN_REBASE : PERTURBED_MAIN_NAIVE) : PLAIN_MAIN,
  ].join('\n')
}

export const PALETTE_NAMES = [
  'Classic',
  'Fire',
  'Ocean',
  'Electric',
  'Sunset',
  'Forest',
  'Ice',
  'Neon',
  'Pastel',
  'Grayscale',
] as const
