import { Preset } from '../types'

export const PRESETS: Preset[] = [
  {
    id: 'mandelbrot',
    name: 'Mandelbrot Set',
    description: 'The classic: z(n) = z(n-1)² + w, colored by escape speed.',
    inline: { f: 'z**2 + w', rule: 'abs(z) > 2', z0: '0' },
    python: `def f(z, w, c, n):
    return z**2 + w

def rule(z, w, c, n):
    return abs(z) > 2
`,
    view: { cx: -0.5, cy: 0, scale: 1.5 },
    maxIter: 300,
    bailout: 2,
    colorScheme: 0,
    juliaC: { re: 0, im: 0 },
  },
  {
    id: 'julia',
    name: 'Julia Set',
    description: 'Same z² + c formula as Mandelbrot, but c is fixed and z starts at the pixel — drag the c slider to explore the family.',
    inline: { f: 'z**2 + c', rule: 'abs(z) > 2', z0: 'w' },
    python: `def z0(w, c):
    return w

def f(z, w, c, n):
    return z**2 + c

def rule(z, w, c, n):
    return abs(z) > 2
`,
    view: { cx: 0, cy: 0, scale: 1.5 },
    maxIter: 300,
    bailout: 2,
    colorScheme: 0,
    juliaC: { re: -0.4, im: 0.6 },
  },
  {
    id: 'burning-ship',
    name: 'Burning Ship',
    description: 'Fold z to the positive quadrant each step before squaring — abs() on .real and .imag before z².',
    inline: { f: 'complex(abs(z.real), abs(z.imag))**2 + w', rule: 'abs(z) > 4', z0: '0' },
    python: `def f(z, w, c, n):
    folded = complex(abs(z.real), abs(z.imag))
    return folded**2 + w

def rule(z, w, c, n):
    return abs(z) > 4
`,
    view: { cx: -0.4, cy: -0.5, scale: 1.5 },
    maxIter: 300,
    bailout: 4,
    colorScheme: 1,
    juliaC: { re: 0, im: 0 },
  },
  {
    id: 'multibrot3',
    name: 'Multibrot (z³ + w)',
    description: 'Raise to the third power instead of squaring — three-fold symmetry.',
    inline: { f: 'z**3 + w', rule: 'abs(z) > 2', z0: '0' },
    python: `def f(z, w, c, n):
    return z**3 + w

def rule(z, w, c, n):
    return abs(z) > 2
`,
    view: { cx: 0, cy: 0, scale: 1.6 },
    maxIter: 300,
    bailout: 2,
    colorScheme: 2,
    juliaC: { re: 0, im: 0 },
  },
  {
    id: 'tricorn',
    name: 'Tricorn (Mandelbar)',
    description: 'Conjugate z before squaring: conj(z)² + w — a three-cornered cousin of the Mandelbrot set.',
    inline: { f: 'conj(z)**2 + w', rule: 'abs(z) > 2', z0: '0' },
    python: `def f(z, w, c, n):
    return conj(z)**2 + w

def rule(z, w, c, n):
    return abs(z) > 2
`,
    view: { cx: 0, cy: 0, scale: 2 },
    maxIter: 300,
    bailout: 2,
    colorScheme: 3,
    juliaC: { re: 0, im: 0 },
  },
  {
    id: 'angle-rule',
    name: 'Angle-Ruled Mandelbrot',
    description: 'Same iteration as Mandelbrot, but the escape rule also fires once the angle of z passes π/4 — proof the rule can be any boolean expression, not just |z| > bailout.',
    inline: { f: 'z**2 + w', rule: 'abs(z) > 2 or arg(z) >= pi/4', z0: '0' },
    python: `def f(z, w, c, n):
    return z**2 + w

def rule(z, w, c, n):
    return abs(z) > 2 or arg(z) >= pi / 4
`,
    view: { cx: -0.5, cy: 0, scale: 1.5 },
    maxIter: 300,
    bailout: 2,
    colorScheme: 9,
    juliaC: { re: 0, im: 0 },
  },
  {
    id: 'triple-step',
    name: 'Triple-Step (Python only)',
    description: 'Uses a local variable and a bounded for-loop to apply three sub-iterations per outer step — only expressible in Python mode.',
    inline: null,
    python: `def f(z, w, c, n):
    total = z
    for i in range(3):
        total = total**2 + w * 0.6
    return total

def rule(z, w, c, n):
    return abs(z) > 2
`,
    view: { cx: -0.3, cy: 0, scale: 1.2 },
    maxIter: 120,
    bailout: 2,
    colorScheme: 1,
    juliaC: { re: 0, im: 0 },
  },
]

export const DEFAULT_PRESET = PRESETS[0]
