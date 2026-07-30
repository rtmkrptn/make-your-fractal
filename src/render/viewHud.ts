// Formatting for the on-canvas view readout (ViewHud): zoom factor and a
// real-life size comparison in the style of mandelbrot.site — "if this
// fractal were the size of the Milky Way, your view would be about the size
// of X". Pure functions so they're easy to reason about independent of the
// renderer/React plumbing.
import { DEFAULT_VIEW } from './useFractalRenderer'

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
}

function toSuperscript(n: number): string {
  return String(n)
    .split('')
    .map((c) => SUPERSCRIPT_DIGITS[c] ?? c)
    .join('')
}

// scale = half-height of the visible complex-plane window; DEFAULT_VIEW.scale
// (1.5 → height 3) is treated as the "1×" reference, matching what a fresh
// preset loads at.
const DEFAULT_HEIGHT = 2 * DEFAULT_VIEW.scale

export function formatZoom(scale: number): string {
  const zoom = DEFAULT_HEIGHT / (2 * scale)
  if (zoom < 10) return `${zoom.toFixed(2)}×`
  if (zoom < 1e6) return `${Math.round(zoom).toLocaleString()}×`
  const exp = Math.floor(Math.log10(zoom))
  const mantissa = zoom / 10 ** exp
  return `${mantissa.toFixed(2)} × 10${toSuperscript(exp)}×`
}

const SI_PREFIXES: Array<[exp: number, prefix: string]> = [
  [24, 'Y'], [21, 'Z'], [18, 'E'], [15, 'P'], [12, 'T'], [9, 'G'], [6, 'M'], [3, 'k'], [0, ''],
  [-3, 'm'], [-6, 'μ'], [-9, 'n'], [-12, 'p'], [-15, 'f'], [-18, 'a'], [-21, 'z'], [-24, 'y'],
]

function toSuperscriptSci(x: number): string {
  const exp = Math.floor(Math.log10(x))
  const mantissa = x / 10 ** exp
  return `${mantissa.toFixed(2)} × 10${toSuperscript(exp)}`
}

// No SI prefix covers everything this app's zoom range can reach (deep zoom
// goes to 1e-290 scale) — outside yocto..yotta, fall back to scientific
// notation rather than silently rounding to "0.00 ym" the way a clamped
// bucket would.
function formatLength(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return '0 m'
  const exp = Math.floor(Math.log10(meters))
  const bucketExp = Math.floor(exp / 3) * 3
  const prefixEntry = SI_PREFIXES.find(([e]) => e === bucketExp)
  if (!prefixEntry) return `${toSuperscriptSci(meters)} m`
  const value = meters / 10 ** bucketExp
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${prefixEntry[1]}m`
}

// Named real-world objects/distances to compare against, spanning solar
// system to subatomic scale. Matching is nearest-in-log-space, so ordering
// doesn't matter and coverage gaps just widen which real sizes map to a
// neighboring entry.
const COMPARISON_TABLE: Array<{ name: string; meters: number }> = [
  { name: 'the Milky Way', meters: 9.46e20 },
  { name: 'the distance to the nearest star', meters: 4e16 },
  { name: 'a light-year', meters: 9.46e15 },
  { name: "the Solar System (out to Neptune's orbit)", meters: 9e12 },
  { name: 'the Sun', meters: 1.39e9 },
  { name: 'Jupiter', meters: 1.4e8 },
  { name: 'Earth', meters: 1.274e7 },
  { name: 'the Moon', meters: 3.47e6 },
  { name: 'Mount Everest', meters: 8849 },
  { name: 'a large city', meters: 20000 },
  { name: 'a football field', meters: 105 },
  { name: 'a blue whale', meters: 25 },
  { name: 'a house', meters: 10 },
  { name: 'a human', meters: 1.7 },
  { name: 'a housecat', meters: 0.3 },
  { name: 'a mouse', meters: 0.08 },
  { name: 'an ant', meters: 0.005 },
  { name: 'a grain of sand', meters: 0.0006 },
  { name: 'a human hair (width)', meters: 0.00007 },
  { name: 'a red blood cell', meters: 0.000008 },
  { name: 'a bacterium', meters: 0.000002 },
  { name: 'a virus', meters: 1e-7 },
  { name: 'a strand of DNA (width)', meters: 2e-9 },
  { name: 'a water molecule', meters: 3e-10 },
  { name: 'a hydrogen atom', meters: 1e-10 },
  { name: 'a proton', meters: 1.7e-15 },
]

// a proton — nothing named smaller in the table, found by value rather than
// array position since entries aren't kept in size order.
const SMALLEST_NAMED = COMPARISON_TABLE.reduce((a, b) => (b.meters < a.meters ? b : a))
// ~100,000 light-years — Milky Way rather than Earth: an Earth-sized
// reference runs out of named comparisons (hits subatomic scale) after only
// a few dozen zoom steps, while every formula in this app can meaningfully
// zoom in far past that. Milky Way buys several more decades of headroom
// before the comparison bottoms out at "smaller than any known particle".
const MILKY_WAY_DIAMETER_M = 9.46e20
const PLANCK_LENGTH_M = 1.616e-35

function findComparison(meters: number) {
  let best = COMPARISON_TABLE[0]
  let bestDiff = Infinity
  for (const entry of COMPARISON_TABLE) {
    const diff = Math.abs(Math.log10(meters) - Math.log10(entry.meters))
    if (diff < bestDiff) {
      bestDiff = diff
      best = entry
    }
  }
  return best
}

/**
 * scale: current view's half-height, same units as referenceScale.
 * referenceScale: half-height of this formula's own starting view (each
 * preset frames its shape differently, and a hand-written formula's "whole
 * picture" isn't a fixed constant like the classic Mandelbrot set's bounding
 * box — using the view it actually reset to keeps this honest for any
 * formula, not just the built-in Mandelbrot preset).
 */
export function realLifeComparison(scale: number, referenceScale: number): string {
  const ratio = scale / referenceScale
  const realMeters = ratio * MILKY_WAY_DIAMETER_M

  if (realMeters < PLANCK_LENGTH_M) {
    const orders = Math.round(Math.log10(PLANCK_LENGTH_M / realMeters))
    return `If this fractal's first view were Milky-Way-sized, your current view would be about 10${toSuperscript(orders)}× smaller than the Planck length — the shortest distance physics assigns any meaning to.`
  }

  if (realMeters < SMALLEST_NAMED.meters) {
    return `If this fractal's first view were Milky-Way-sized, your current view would be about ${formatLength(realMeters)} — smaller than any known particle (a proton is about 1.7 fm across).`
  }

  const match = findComparison(realMeters)
  return `If this fractal's first view were Milky-Way-sized, your current view would be about the size of ${match.name} (${formatLength(realMeters)}).`
}
