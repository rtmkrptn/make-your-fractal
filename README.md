# Fractal Forge

Define an escape-time fractal — z(n) = f(z(n-1), w), plus a boolean escape
rule — and watch it render live on the GPU, pannable and zoomable like
Desmos or mandelbrot.site.

Two ways to define a fractal:

- **Average mode** — fill in three inline expressions: `f(z, w, c, n)`,
  `rule(z, w, c, n)`, and the starting value `z0(w, c)`.
- **Nerd mode** — write real `def f(z, w, c, n):` / `def rule(...):`
  (optionally `def z0(w, c):`) functions in a constrained Python-like
  language, with `if`/`elif`/`else`, bounded `for i in range(N):` loops, and
  local variables. Import/export as a `.py` file.

Both modes compile to the same small typed AST (`src/dsl`), which is then
transpiled to GLSL (`src/dsl/compiler.ts`) and run per-pixel in a WebGL2
fragment shader (`src/render`) — that's what keeps pan/zoom smooth even
though the user is effectively authoring the fractal's math from scratch.

Rendering has two more tricks on top of the base escape-time loop:

- **Perturbation rendering for deep zoom** (`src/dsl/perturbation.ts`). Rather
  than raising precision everywhere (tried first; correct, but ~2-4x slower
  per pixel and still eventually hits a wall — see git history), one
  high-precision reference orbit is computed *once* per view, on the CPU,
  using arbitrary-precision decimal arithmetic (`decimal.js`). Every pixel
  then only tracks its own tiny *delta* from that orbit, computed via
  automatic differentiation (dual numbers) compiled straight from the same
  AST the plain renderer uses, in ordinary single-precision GLSL — no pixel
  ever adds a tiny number to a big one, so there's no precision to lose. This
  is the same technique tools like Kalles Fraktaler use to reach depths like
  1e-300 while staying fast; here it's self-imposed-capped around 1e-290.
  Verified against plain float64 ground truth (relative error ~1.5e-8, at
  float32's own precision limit — see git history).

  Scope: only eligible for iteration functions that are a *single return
  expression* built from `+ - * /`, integer powers, `abs()`/`conj()`/`re()`/
  `im()`/`complex()`, and unary minus — covers every built-in preset.
  Formulas using control flow, loops, comparisons inside `f`, or
  transcendentals fall back to plain float32 (~1e-6 depth). The UI's
  precision badge (top-right of the canvas) shows which path is active.
- **Rebasing** (Zhuoran's method, as used in Fraktaler 3 and mandelbrot.site):
  a per-pixel delta is only a valid approximation while it stays small
  relative to the true orbit value there. Deep reference orbits have
  periodic near-zero dips (satellite minibrots), and a pixel whose own orbit
  diverges from the reference right at one of those dips would otherwise
  compound error from that point on — the classic perturbation "glitch",
  visible as speckling/banding that can even flicker between renders as the
  reference orbit gets recomputed on each settle. The shader now detects the
  moment a pixel's delta stops being small (or the stored reference orbit
  runs out) and restarts tracking it from the orbit's start, without
  resetting the pixel's real iteration count — see `PERTURBED_MAIN` in
  `src/render/shaderTemplate.ts`.
- **Gentle, clamped zoom.** The fractal boundary is infinitely thin, so blind
  zooming easily drifts into a flat "wasteland" (solid interior or empty
  background — not a bug, just nothing there to render). Zoom is
  intentionally gentle with per-event delta clamping to leave room to react
  and steer back onto detail.

## Run it

```bash
npm install
npm run dev
```

## Project layout

- `src/dsl/` — lexer, parser, AST, the AST → GLSL compiler (`compiler.ts`,
  small real/complex/bool type system so `+`, `*`, `**` etc. compile to
  correct complex arithmetic, not naive component-wise ops), the perturbation
  module (`perturbation.ts`, eligibility check + Decimal-based reference-orbit
  evaluator + dual-number delta GLSL compiler), and `usesIdentifier.ts`
  (tokenizer-based check for whether a formula references a given name, used
  to only show the constant-`c` control when a formula actually reads it).
- `src/render/` — the GLSL complex-math + palette library
  (`shaderTemplate.ts`), and the `useFractalRenderer` hook (WebGL2 setup,
  reference-orbit texture upload, pan/zoom, PNG export).
- `src/modes/` — the Average and Nerd mode UI panels; each shows a small
  draggable-point plane for the constant `c` (`components/ComplexPointField.tsx`)
  right below the starting-value field, but only once a formula references
  `c` — most presets don't (`c` is a Julia-style fixed parameter, not one of
  the DSL's implicit variables).
- `src/examples/presets.ts` — Mandelbrot, Julia, Burning Ship, Multibrot,
  Tricorn, and two presets demonstrating custom escape rules and loops.

## Known limitations

- Perturbation eligibility is restricted to single-expression iteration
  functions (see above) — formulas with loops/branches/comparisons in `f`
  are capped at plain float32 depth (~1e-6). Division and non-integer powers
  get a first-order (not exact) delta approximation, fine for the tiny
  deltas involved but worth knowing if you're chasing precision at the
  numerical edge with an unusual formula.
- `abs()`'s delta rule (`d|x|/dx = sign(x)`, used by e.g. Burning Ship) is a
  first-order local approximation, not exact like the polynomial terms —
  when it's wrong for enough iterations in a row (deep zoom, points near a
  fold line), the delta can diverge and hit float32 overflow. The shader
  detects this (NaN/Infinity/implausible magnitude) and falls back to coarse
  per-iteration coloring for just that pixel rather than letting it corrupt
  into visible noise, but the affected pixels are still less accurate than
  their neighbors — occasionally visible as faint banding deep in
  `abs()`-based formulas. Rebasing (see above) reduces how often this
  triggers by keeping the delta small in the first place, but doesn't
  eliminate it, since `abs()`'s own delta rule is approximate regardless of
  how close the reference orbit is.
- Nerd-mode loops must have a literal, compile-time bound (`for i in
  range(50):`, not a variable) since GLSL has no recursion and shader loop
  unrolling needs a known trip count.
