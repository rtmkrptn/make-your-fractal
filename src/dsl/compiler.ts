import { Expr, Stmt, FunctionDef, Program } from './ast'
import { DslError } from './errors'
import { parseProgram, parseSingleExpr } from './parser'

export type GlslType = 'real' | 'complex' | 'bool'

interface Compiled {
  code: string
  type: GlslType
}

type TypeEnv = Map<string, GlslType>

// ---------------------------------------------------------------------------
// Built-in function table. Math functions (sin/cos/tan/exp/log/sqrt) are
// overloaded: called on a real argument they use GLSL's native function,
// called on a complex argument they use our complex-arithmetic helpers
// (csin/ccos/... defined in the shader template).
// ---------------------------------------------------------------------------

const REAL_ONLY_MATH = ['floor', 'ceil', 'round', 'sign']
const OVERLOADED_MATH = ['sin', 'cos', 'tan', 'exp', 'log', 'sqrt']

function requireArgc(name: string, args: unknown[], n: number, line: number) {
  if (args.length !== n) {
    throw new DslError(`'${name}' expects ${n} argument${n === 1 ? '' : 's'}, got ${args.length}`, line)
  }
}

/**
 * Detects `2`, `-2`, etc. as a compile-time integer exponent (unary minus
 * wraps a literal in its own AST node). Exported for reuse by the
 * perturbation compiler, which needs the same "is this a literal integer
 * power" check to decide whether a `**` is deep-zoom eligible.
 */
export function tryLiteralInt(expr: Expr): number | null {
  if (expr.kind === 'num' && Number.isInteger(expr.value)) return expr.value
  if (expr.kind === 'unary' && expr.op === '-' && expr.operand.kind === 'num' && Number.isInteger(expr.operand.value)) {
    return -expr.operand.value
  }
  return null
}

/** GLSL float literals need a decimal point or exponent to parse as a float, not an int. */
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

function glslTypeName(t: GlslType): string {
  return t === 'real' ? 'float' : t === 'complex' ? 'vec2' : 'bool'
}

function describeType(t: GlslType): string {
  return t === 'real' ? 'real number' : t === 'complex' ? 'complex number' : 'boolean'
}

function toComplex(code: string, type: GlslType): string {
  if (type === 'complex') return code
  if (type === 'real') return `vec2(${code}, 0.0)`
  throw new Error('cannot convert bool to complex')
}

function indent(line: string): string {
  return '  ' + line
}

function stmtsAlwaysReturn(stmts: Stmt[]): boolean {
  if (stmts.length === 0) return false
  const last = stmts[stmts.length - 1]
  if (last.kind === 'return') return true
  if (last.kind === 'if' && last.orelse) {
    return last.branches.every((b) => stmtsAlwaysReturn(b.body)) && stmtsAlwaysReturn(last.orelse)
  }
  return false
}

function unifyTypes(a: GlslType, b: GlslType, line: number): GlslType {
  if (a === b) return a
  if ((a === 'real' && b === 'complex') || (a === 'complex' && b === 'real')) return 'complex'
  throw new DslError(`the two branches of an 'if' expression produce different types (${describeType(a)} vs ${describeType(b)})`, line)
}

function expectType(c: Compiled, want: GlslType, callee: string, line: number) {
  if (c.type !== want) {
    throw new DslError(`${callee}() expects a ${describeType(want)} argument, got ${describeType(c.type)}`, line)
  }
}

// ---------------------------------------------------------------------------

export class FunctionCompiler {
  private hoisted: TypeEnv = new Map()

  constructor(private paramTypes: TypeEnv, private fnName: string) {}

  /** Compiles a standalone expression (no statements/hoisting) — used by the perturbation compiler to get "reference value" GLSL for sub-expressions without duplicating this whole class. */
  compileStandaloneExpr(expr: Expr, env: TypeEnv): Compiled {
    return this.compileExpr(expr, env)
  }

  /** Compiles a full FunctionDef into a GLSL function body's statement lines (no signature/braces). */
  compileBody(fn: FunctionDef, expectedReturn: GlslType): string[] {
    if (!stmtsAlwaysReturn(fn.body)) {
      throw new DslError(
        `function '${fn.name}' must return a value on every code path (every 'if' needs a matching 'else', and the last statement in each branch must be a return)`,
        fn.line,
      )
    }

    // Pass 1: hoist locals to function scope (GLSL if/else/for open new blocks,
    // but Python-style code expects a variable assigned in one branch to still
    // be visible afterward — so we declare every local once at the top).
    const env: TypeEnv = new Map(this.paramTypes)
    this.hoistStmts(fn.body, env)

    const lines: string[] = []
    for (const [name, type] of this.hoisted) {
      lines.push(`${glslTypeName(type)} ${name};`)
    }

    const bodyEnv: TypeEnv = new Map(this.paramTypes)
    for (const [name, type] of this.hoisted) bodyEnv.set(name, type)

    lines.push(...this.compileStmts(fn.body, bodyEnv, expectedReturn))
    return lines
  }

  /**
   * Pass 1: hoists locals to function scope AND tracks, statement by
   * statement, which variables are *definitely assigned* on the path reached
   * so far — `env` only ever contains those, so any expression (a `return`,
   * an `if` test, an assignment's RHS) that names something not yet
   * guaranteed assigned fails here with "unknown name" instead of silently
   * compiling into a GLSL read of an uninitialized local. Returns the set of
   * names this statement list itself guarantees assigned, so an enclosing
   * `if`/`for` can decide whether to merge them into its own outer `env`.
   */
  private hoistStmts(stmts: Stmt[], env: TypeEnv): Set<string> {
    const assignedHere = new Set<string>()
    for (const s of stmts) {
      if (s.kind === 'assign') {
        const t = this.inferExpr(s.value, env).type
        const existing = this.hoisted.get(s.name)
        if (existing && existing !== t) {
          throw new DslError(
            `variable '${s.name}' was first used as ${existing}, cannot later assign a ${t} value to it`,
            s.line,
          )
        }
        if (!existing) this.hoisted.set(s.name, t)
        env.set(s.name, t)
        assignedHere.add(s.name)
      } else if (s.kind === 'return') {
        this.inferExpr(s.value, env)
      } else if (s.kind === 'if') {
        // A variable is guaranteed assigned after the whole `if` only if
        // every branch that can fall through (i.e. doesn't itself always
        // return) assigns it — and only if there's an `else` at all, since
        // otherwise "no branch taken" is itself a fall-through path that
        // assigns nothing new.
        const fallthroughSets: Set<string>[] = []
        for (const branch of s.branches) {
          this.inferExpr(branch.test, env)
          const a = this.hoistStmts(branch.body, new Map(env))
          if (!stmtsAlwaysReturn(branch.body)) fallthroughSets.push(a)
        }
        if (s.orelse) {
          const a = this.hoistStmts(s.orelse, new Map(env))
          if (!stmtsAlwaysReturn(s.orelse)) fallthroughSets.push(a)
        } else {
          fallthroughSets.push(new Set())
        }
        if (fallthroughSets.length > 0) {
          let guaranteed = fallthroughSets[0]
          for (let i = 1; i < fallthroughSets.length; i++) {
            guaranteed = new Set([...guaranteed].filter((name) => fallthroughSets[i].has(name)))
          }
          for (const name of guaranteed) {
            env.set(name, this.hoisted.get(name)!)
            assignedHere.add(name)
          }
        }
      } else if (s.kind === 'for') {
        const existing = this.hoisted.get(s.varName)
        if (existing && existing !== 'real') {
          throw new DslError(`loop variable '${s.varName}' collides with a variable of a different type`, s.line)
        }
        if (!existing) this.hoisted.set(s.varName, 'real')
        const inner = new Map(env)
        inner.set(s.varName, 'real')
        // Conservative: a loop's body isn't guaranteed to run (and even if
        // count >= 1 always does, nothing after should rely on "assigned
        // only inside the loop"), so nothing here merges into the outer env.
        this.hoistStmts(s.body, inner)
      }
    }
    return assignedHere
  }

  private compileStmts(stmts: Stmt[], env: TypeEnv, expectedReturn: GlslType): string[] {
    const lines: string[] = []
    for (const s of stmts) {
      if (s.kind === 'assign') {
        const { code, type } = this.compileExpr(s.value, env)
        const declared = env.get(s.name)
        if (declared && declared !== type) {
          throw new DslError(`variable '${s.name}' was declared as ${declared}, cannot assign a ${type} value here`, s.line)
        }
        lines.push(`${s.name} = ${code};`)
      } else if (s.kind === 'return') {
        const { code, type } = this.compileExpr(s.value, env)
        let outCode = code
        if (type !== expectedReturn) {
          // A real number is a valid complex number (imaginary part 0), so allow
          // that one implicit widening — e.g. `return 0` for a complex-valued z0.
          if (expectedReturn === 'complex' && type === 'real') {
            outCode = toComplex(code, type)
          } else {
            throw new DslError(
              `function '${this.fnName}' must return a ${describeType(expectedReturn)} value, but this 'return' produces a ${describeType(type)}`,
              s.line,
            )
          }
        }
        lines.push(`return ${outCode};`)
      } else if (s.kind === 'if') {
        const parts: string[] = []
        s.branches.forEach((branch, idx) => {
          const { code: condCode, type: condType } = this.compileExpr(branch.test, env)
          if (condType !== 'bool') {
            throw new DslError(`'if' condition must be a boolean expression (e.g. a comparison), got ${describeType(condType)}`, s.line)
          }
          const kw = idx === 0 ? 'if' : '} else if'
          parts.push(`${kw} (${condCode}) {`)
          parts.push(...this.compileStmts(branch.body, env, expectedReturn).map(indent))
        })
        if (s.orelse) {
          parts.push('} else {')
          parts.push(...this.compileStmts(s.orelse, env, expectedReturn).map(indent))
        }
        parts.push('}')
        lines.push(...parts)
      } else if (s.kind === 'for') {
        lines.push(`for (${s.varName} = 0.0; ${s.varName} < ${s.count.toFixed(1)}; ${s.varName} += 1.0) {`)
        const innerEnv = new Map(env)
        innerEnv.set(s.varName, 'real')
        lines.push(...this.compileStmts(s.body, innerEnv, expectedReturn).map(indent))
        lines.push('}')
      }
    }
    return lines
  }

  // Type inference only (no code emitted) — used during hoisting.
  private inferExpr(expr: Expr, env: TypeEnv): Compiled {
    return this.compileExpr(expr, env, true)
  }

  private compileExpr(expr: Expr, env: TypeEnv, typeOnly = false): Compiled {
    switch (expr.kind) {
      case 'num':
        return { code: typeOnly ? '' : formatFloat32(expr.value), type: 'real' }
      case 'imag':
        return { code: typeOnly ? '' : `vec2(0.0, ${formatFloat32(expr.value)})`, type: 'complex' }
      case 'bool':
        return { code: typeOnly ? '' : expr.value ? 'true' : 'false', type: 'bool' }
      case 'name':
        return this.compileName(expr.name, env, expr.line, typeOnly)
      case 'attr': {
        const obj = this.compileExpr(expr.obj, env, typeOnly)
        if (obj.type !== 'complex') {
          throw new DslError(`.${expr.attr} can only be used on a complex value`, expr.line)
        }
        const comp = expr.attr === 'real' ? 'x' : 'y'
        return { code: typeOnly ? '' : `(${obj.code}).${comp}`, type: 'real' }
      }
      case 'unary':
        return this.compileUnary(expr, env, typeOnly)
      case 'binary':
        return this.compileBinary(expr, env, typeOnly)
      case 'compare':
        return this.compileCompare(expr, env, typeOnly)
      case 'logical': {
        const l = this.compileExpr(expr.left, env, typeOnly)
        const r = this.compileExpr(expr.right, env, typeOnly)
        if (l.type !== 'bool' || r.type !== 'bool') {
          throw new DslError(`'${expr.op}' requires boolean operands (e.g. comparisons); got ${describeType(l.type)} and ${describeType(r.type)}`, expr.line)
        }
        const glslOp = expr.op === 'and' ? '&&' : '||'
        return { code: typeOnly ? '' : `(${l.code} ${glslOp} ${r.code})`, type: 'bool' }
      }
      case 'ternary': {
        const test = this.compileExpr(expr.test, env, typeOnly)
        if (test.type !== 'bool') {
          throw new DslError(`the condition of an 'if' expression must be boolean, got ${describeType(test.type)}`, expr.line)
        }
        const then = this.compileExpr(expr.then, env, typeOnly)
        const orelse = this.compileExpr(expr.orelse, env, typeOnly)
        const resultType = unifyTypes(then.type, orelse.type, expr.line)
        if (typeOnly) return { code: '', type: resultType }
        const thenCode = resultType === 'complex' ? toComplex(then.code, then.type) : then.code
        const orelseCode = resultType === 'complex' ? toComplex(orelse.code, orelse.type) : orelse.code
        return { code: `(${test.code} ? ${thenCode} : ${orelseCode})`, type: resultType }
      }
      case 'call':
        return this.compileCall(expr, env, typeOnly)
    }
  }

  private compileName(name: string, env: TypeEnv, line: number, typeOnly: boolean): Compiled {
    const t = env.get(name)
    if (t) return { code: typeOnly ? '' : name, type: t }
    if (name === 'pi') return { code: typeOnly ? '' : formatFloat32(Math.PI), type: 'real' }
    if (name === 'e') return { code: typeOnly ? '' : formatFloat32(Math.E), type: 'real' }
    const available = [...env.keys()].join(', ')
    throw new DslError(`unknown name '${name}' (available: ${available}, pi, e)`, line)
  }

  private compileUnary(expr: Extract<Expr, { kind: 'unary' }>, env: TypeEnv, typeOnly: boolean): Compiled {
    const operand = this.compileExpr(expr.operand, env, typeOnly)
    if (expr.op === 'not') {
      if (operand.type !== 'bool') throw new DslError(`'not' requires a boolean operand, got ${describeType(operand.type)}`, expr.line)
      return { code: typeOnly ? '' : `(!${operand.code})`, type: 'bool' }
    }
    if (operand.type === 'bool') throw new DslError(`cannot negate a boolean value`, expr.line)
    return { code: typeOnly ? '' : `(-${operand.code})`, type: operand.type }
  }

  private compileBinary(expr: Extract<Expr, { kind: 'binary' }>, env: TypeEnv, typeOnly: boolean): Compiled {
    if (expr.op === '**') {
      return this.emitPower(expr.left, expr.right, env, typeOnly, expr.line, '**')
    }
    const l = this.compileExpr(expr.left, env, typeOnly)
    const r = this.compileExpr(expr.right, env, typeOnly)
    if (l.type === 'bool' || r.type === 'bool') {
      throw new DslError(`arithmetic operator '${expr.op}' cannot be used with a boolean value`, expr.line)
    }
    switch (expr.op) {
      case '+':
        return this.emitAddSub(l, r, false, typeOnly)
      case '-':
        return this.emitAddSub(l, r, true, typeOnly)
      case '*':
        return this.emitMul(l, r, typeOnly)
      case '/':
        return this.emitDiv(l, r, typeOnly)
      case '%':
        return this.emitMod(l, r, expr.line, typeOnly)
    }
  }

  private emitAddSub(l: Compiled, r: Compiled, isSub: boolean, typeOnly: boolean): Compiled {
    const op = isSub ? '-' : '+'
    const bothReal = l.type === 'real' && r.type === 'real'
    if (bothReal) {
      return { code: typeOnly ? '' : `(${l.code} ${op} ${r.code})`, type: 'real' }
    }
    if (typeOnly) return { code: '', type: 'complex' }
    return { code: `(${toComplex(l.code, l.type)} ${op} ${toComplex(r.code, r.type)})`, type: 'complex' }
  }

  private emitMul(l: Compiled, r: Compiled, typeOnly: boolean): Compiled {
    const bothReal = l.type === 'real' && r.type === 'real'
    if (bothReal) {
      return { code: typeOnly ? '' : `(${l.code} * ${r.code})`, type: 'real' }
    }
    if (typeOnly) return { code: '', type: 'complex' }
    if (l.type === 'complex' && r.type === 'complex') return { code: `cmul(${l.code}, ${r.code})`, type: 'complex' }
    // complex * real or real * complex: GLSL scalar-vector broadcast is exactly right here.
    return { code: `(${l.code} * ${r.code})`, type: 'complex' }
  }

  private emitDiv(l: Compiled, r: Compiled, typeOnly: boolean): Compiled {
    const bothReal = l.type === 'real' && r.type === 'real'
    if (bothReal) {
      return { code: typeOnly ? '' : `(${l.code} / ${r.code})`, type: 'real' }
    }
    if (typeOnly) return { code: '', type: 'complex' }
    if (l.type === 'complex' && r.type === 'complex') return { code: `cdiv(${l.code}, ${r.code})`, type: 'complex' }
    if (l.type === 'complex' && r.type === 'real') return { code: `(${l.code} / ${r.code})`, type: 'complex' } // divide both components — correct
    return { code: `cdiv(${toComplex(l.code, l.type)}, ${r.code})`, type: 'complex' } // real / complex
  }

  private emitMod(l: Compiled, r: Compiled, line: number, typeOnly: boolean): Compiled {
    if (l.type !== 'real' || r.type !== 'real') throw new DslError(`'%' is only supported between two real numbers`, line)
    return { code: typeOnly ? '' : `mod(${l.code}, ${r.code})`, type: 'real' }
  }

  /** Shared by the `**` operator and the `pow()` builtin. Uses exact repeated-squaring for compile-time-known integer exponents (also avoids exp/log round-trip error), falling back to exp/log-based pow otherwise. */
  private emitPower(leftExpr: Expr, rightExpr: Expr, env: TypeEnv, typeOnly: boolean, line: number, opName: string): Compiled {
    const l = this.compileExpr(leftExpr, env, typeOnly)
    const r = this.compileExpr(rightExpr, env, typeOnly)
    if (l.type === 'bool' || r.type === 'bool') {
      throw new DslError(`'${opName}' cannot be used with a boolean value`, line)
    }

    const literalInt = tryLiteralInt(rightExpr)
    const isIntExponent = literalInt !== null && Math.abs(literalInt) <= 64

    if (isIntExponent) {
      const n = literalInt as number
      const resultType: GlslType = l.type === 'complex' ? 'complex' : 'real'
      if (typeOnly) return { code: '', type: resultType }
      if (n === 0) {
        // z**0 == 1 by convention, regardless of base.
        const code = resultType === 'complex' ? 'vec2(1.0, 0.0)' : '1.0'
        return { code, type: resultType }
      }
      if (resultType === 'complex') {
        return { code: `cpowInt(${l.code}, ${n})`, type: 'complex' }
      }
      return { code: `pow(${l.code}, ${formatFloat32(n)})`, type: 'real' }
    }

    // Generic fallback: non-integer or non-literal exponent.
    const bothReal = l.type === 'real' && r.type === 'real'
    if (typeOnly) return { code: '', type: bothReal ? 'real' : 'complex' }
    if (bothReal) return { code: `pow(${l.code}, ${r.code})`, type: 'real' }
    return { code: `cpow(${toComplex(l.code, l.type)}, ${toComplex(r.code, r.type)})`, type: 'complex' }
  }

  private compileCompare(expr: Extract<Expr, { kind: 'compare' }>, env: TypeEnv, typeOnly: boolean): Compiled {
    const l = this.compileExpr(expr.left, env, typeOnly)
    const r = this.compileExpr(expr.right, env, typeOnly)
    if (l.type === 'bool' && r.type === 'bool') {
      if (expr.op !== '==' && expr.op !== '!=') {
        throw new DslError(`'${expr.op}' cannot compare boolean values (only == and != can)`, expr.line)
      }
      return { code: typeOnly ? '' : `(${l.code} ${expr.op} ${r.code})`, type: 'bool' }
    }
    if (l.type !== 'real' || r.type !== 'real') {
      throw new DslError(
        `'${expr.op}' requires two real numbers — got ${describeType(l.type)} and ${describeType(r.type)}. Use abs(z), arg(z), z.real or z.imag to get a real value from a complex one.`,
        expr.line,
      )
    }
    return { code: typeOnly ? '' : `(${l.code} ${expr.op} ${r.code})`, type: 'bool' }
  }

  private compileCall(expr: Extract<Expr, { kind: 'call' }>, env: TypeEnv, typeOnly: boolean): Compiled {
    const { callee, args, line } = expr
    const emit = (code: string) => (typeOnly ? '' : code)

    if (callee === 'pow') {
      requireArgc(callee, args, 2, line)
      return this.emitPower(args[0], args[1], env, typeOnly, line, 'pow()')
    }

    const compiledArgs = args.map((a) => this.compileExpr(a, env, typeOnly))

    switch (callee) {
      case 'abs': {
        requireArgc(callee, args, 1, line)
        const a = compiledArgs[0]
        if (a.type === 'bool') throw new DslError(`abs() cannot take a boolean argument`, line)
        return a.type === 'complex' ? { code: emit(`cabs(${a.code})`), type: 'real' } : { code: emit(`abs(${a.code})`), type: 'real' }
      }
      case 'arg':
      case 'phase': {
        requireArgc(callee, args, 1, line)
        const a = compiledArgs[0]
        if (a.type === 'bool') throw new DslError(`${callee}() cannot take a boolean argument`, line)
        if (a.type === 'complex') return { code: emit(`carg(${a.code})`), type: 'real' }
        return { code: emit(`(${a.code} < 0.0 ? 3.14159265358979323846 : 0.0)`), type: 'real' }
      }
      case 'conj': {
        requireArgc(callee, args, 1, line)
        const a = compiledArgs[0]
        if (a.type === 'bool') throw new DslError(`conj() cannot take a boolean argument`, line)
        return a.type === 'complex' ? { code: emit(`conj(${a.code})`), type: 'complex' } : a
      }
      case 're': {
        requireArgc(callee, args, 1, line)
        const a = compiledArgs[0]
        if (a.type === 'bool') throw new DslError(`re() cannot take a boolean argument`, line)
        return a.type === 'complex' ? { code: emit(`(${a.code}).x`), type: 'real' } : a
      }
      case 'im': {
        requireArgc(callee, args, 1, line)
        const a = compiledArgs[0]
        if (a.type === 'bool') throw new DslError(`im() cannot take a boolean argument`, line)
        return a.type === 'complex' ? { code: emit(`(${a.code}).y`), type: 'real' } : { code: emit('0.0'), type: 'real' }
      }
      case 'complex':
        requireArgc(callee, args, 2, line)
        expectType(compiledArgs[0], 'real', callee, line)
        expectType(compiledArgs[1], 'real', callee, line)
        return { code: emit(`vec2(${compiledArgs[0].code}, ${compiledArgs[1].code})`), type: 'complex' }
      case 'min':
      case 'max':
      case 'clamp': {
        const n = callee === 'clamp' ? 3 : 2
        requireArgc(callee, args, n, line)
        for (const a of compiledArgs) expectType(a, 'real', callee, line)
        return { code: emit(`${callee}(${compiledArgs.map((a) => a.code).join(', ')})`), type: 'real' }
      }
      default:
        break
    }

    if (REAL_ONLY_MATH.includes(callee)) {
      requireArgc(callee, args, 1, line)
      expectType(compiledArgs[0], 'real', callee, line)
      return { code: emit(`${callee}(${compiledArgs[0].code})`), type: 'real' }
    }

    if (OVERLOADED_MATH.includes(callee)) {
      requireArgc(callee, args, 1, line)
      const a = compiledArgs[0]
      if (a.type === 'bool') throw new DslError(`${callee}() cannot take a boolean argument`, line)
      if (a.type === 'real') return { code: emit(`${callee}(${a.code})`), type: 'real' }
      const glslFn = 'c' + callee
      return { code: emit(`${glslFn}(${a.code})`), type: 'complex' }
    }

    throw new DslError(
      `unknown function '${callee}'. Available: abs, arg, conj, re, im, complex, pow, min, max, clamp, floor, ceil, round, sign, sin, cos, tan, exp, log, sqrt`,
      line,
    )
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompiledFractal {
  glsl: string // GLSL source defining user_f, user_rule, user_z0
}

const COMPLEX: GlslType = 'complex'
const REAL: GlslType = 'real'
const BOOL: GlslType = 'bool'

function compileNamedFunction(fn: FunctionDef, paramNames: string[], paramTypes: GlslType[], returnType: GlslType, glslName: string): string {
  if (fn.params.length !== paramNames.length || fn.params.some((p, idx) => p !== paramNames[idx])) {
    throw new DslError(
      `'${fn.name}' must be defined as def ${fn.name}(${paramNames.join(', ')}): — got def ${fn.name}(${fn.params.join(', ')}):`,
      fn.line,
    )
  }
  const env: TypeEnv = new Map()
  paramNames.forEach((name, idx) => env.set(name, paramTypes[idx]))
  const compiler = new FunctionCompiler(env, fn.name)
  const bodyLines = compiler.compileBody(fn, returnType)
  const sig = paramNames.map((name, idx) => `${glslTypeName(paramTypes[idx])} ${name}`).join(', ')
  return [`${glslTypeName(returnType)} ${glslName}(${sig}) {`, ...bodyLines.map(indent), '}'].join('\n')
}

/** Compiles a full Python-mode program (must define f and rule; z0 is optional). */
export function compileProgram(source: string): CompiledFractal {
  const program: Program = parseProgram(source)

  const fFn = program.functions.get('f')
  const ruleFn = program.functions.get('rule')
  const z0Fn = program.functions.get('z0')

  if (!fFn) throw new DslError(`your code must define def f(z, w, c, n): — the iteration function`, 1)
  if (!ruleFn) throw new DslError(`your code must define def rule(z, w, c, n): — the escape/membership rule`, 1)

  const fGlsl = compileNamedFunction(fFn, ['z', 'w', 'c', 'n'], [COMPLEX, COMPLEX, COMPLEX, REAL], COMPLEX, 'user_f')
  const ruleGlsl = compileNamedFunction(ruleFn, ['z', 'w', 'c', 'n'], [COMPLEX, COMPLEX, COMPLEX, REAL], BOOL, 'user_rule')
  const z0Glsl = z0Fn
    ? compileNamedFunction(z0Fn, ['w', 'c'], [COMPLEX, COMPLEX], COMPLEX, 'user_z0')
    : 'vec2 user_z0(vec2 w, vec2 c) {\n  return vec2(0.0, 0.0);\n}'

  return { glsl: [fGlsl, ruleGlsl, z0Glsl].join('\n\n') }
}

/**
 * Compiles Inline-mode expressions into the same GLSL shape Python mode
 * produces. `fExprSrc` is the *complete* right-hand side of z(n) = f(z(n-1))
 * (e.g. "z**2 + w" for Mandelbrot, "z**2 + c" for a Julia set with z0 = w) —
 * it is used as-is, not auto-wrapped, so the same three fields can express
 * either style depending on what the user references.
 */
export function compileInlineMode(fExprSrc: string, ruleExprSrc: string, z0ExprSrc: string): CompiledFractal {
  const fExpr = parseSingleExpr(fExprSrc)
  const ruleExpr = parseSingleExpr(ruleExprSrc)
  const z0Expr = parseSingleExpr(z0ExprSrc)

  const fFn: FunctionDef = {
    name: 'f',
    params: ['z', 'w', 'c', 'n'],
    body: [{ kind: 'return', value: fExpr, line: 1 }],
    line: 1,
  }
  const ruleFn: FunctionDef = {
    name: 'rule',
    params: ['z', 'w', 'c', 'n'],
    body: [{ kind: 'return', value: ruleExpr, line: 1 }],
    line: 1,
  }
  const z0Fn: FunctionDef = {
    name: 'z0',
    params: ['w', 'c'],
    body: [{ kind: 'return', value: z0Expr, line: 1 }],
    line: 1,
  }

  const fGlsl = compileNamedFunction(fFn, ['z', 'w', 'c', 'n'], [COMPLEX, COMPLEX, COMPLEX, REAL], COMPLEX, 'user_f')
  const ruleGlsl = compileNamedFunction(ruleFn, ['z', 'w', 'c', 'n'], [COMPLEX, COMPLEX, COMPLEX, REAL], BOOL, 'user_rule')
  const z0Glsl = compileNamedFunction(z0Fn, ['w', 'c'], [COMPLEX, COMPLEX], COMPLEX, 'user_z0')

  return { glsl: [fGlsl, ruleGlsl, z0Glsl].join('\n\n') }
}
