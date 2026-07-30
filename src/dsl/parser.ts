import { tokenize, Token } from './lexer'
import { DslError } from './errors'
import { Expr, Stmt, FunctionDef, Program, BinOp, CompareOp } from './ast'

const COMPARE_OPS = new Set(['<', '<=', '>', '>=', '==', '!='])

class Parser {
  private tokens: Token[]
  private pos = 0

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]
  }

  private at(type: Token['type'], value?: string): boolean {
    const t = this.peek()
    return t.type === type && (value === undefined || t.value === value)
  }

  private advance(): Token {
    const t = this.tokens[this.pos]
    if (this.pos < this.tokens.length - 1) this.pos++
    return t
  }

  private expect(type: Token['type'], value?: string): Token {
    if (!this.at(type, value)) {
      const t = this.peek()
      const wanted = value ?? type
      throw new DslError(`expected '${wanted}' but found '${t.value || t.type}'`, t.line)
    }
    return this.advance()
  }

  parseProgram(): Program {
    const functions = new Map<string, FunctionDef>()
    while (!this.at('EOF')) {
      while (this.at('NEWLINE')) this.advance()
      if (this.at('EOF')) break
      const fn = this.parseFunctionDef()
      functions.set(fn.name, fn)
      while (this.at('NEWLINE')) this.advance()
    }
    return { functions }
  }

  private parseFunctionDef(): FunctionDef {
    const defTok = this.expect('KEYWORD', 'def')
    const nameTok = this.expect('NAME')
    this.expect('OP', '(')
    const params: string[] = []
    if (!this.at('OP', ')')) {
      params.push(this.expect('NAME').value)
      while (this.at('OP', ',')) {
        this.advance()
        params.push(this.expect('NAME').value)
      }
    }
    this.expect('OP', ')')
    this.expect('OP', ':')
    const body = this.parseBlock()
    return { name: nameTok.value, params, body, line: defTok.line }
  }

  private parseBlock(): Stmt[] {
    this.expect('NEWLINE')
    this.expect('INDENT')
    const stmts: Stmt[] = []
    while (!this.at('DEDENT') && !this.at('EOF')) {
      if (this.at('NEWLINE')) {
        this.advance()
        continue
      }
      stmts.push(this.parseStmt())
    }
    this.expect('DEDENT')
    if (stmts.length === 0) {
      throw new DslError('block cannot be empty', this.peek().line)
    }
    return stmts
  }

  private parseStmt(): Stmt {
    const t = this.peek()
    if (t.type === 'KEYWORD' && t.value === 'return') {
      this.advance()
      const value = this.parseExpr()
      this.expect('NEWLINE')
      return { kind: 'return', value, line: t.line }
    }
    if (t.type === 'KEYWORD' && t.value === 'if') {
      return this.parseIf()
    }
    if (t.type === 'KEYWORD' && t.value === 'for') {
      return this.parseFor()
    }
    if (t.type === 'NAME') {
      // Assignment: NAME '=' expr
      const nameTok = this.advance()
      this.expect('OP', '=')
      const value = this.parseExpr()
      this.expect('NEWLINE')
      return { kind: 'assign', name: nameTok.value, value, line: nameTok.line }
    }
    throw new DslError(`unexpected token '${t.value || t.type}'`, t.line)
  }

  private parseIf(): Stmt {
    const ifTok = this.expect('KEYWORD', 'if')
    const branches: { test: Expr; body: Stmt[] }[] = []
    const test = this.parseExpr()
    this.expect('OP', ':')
    const body = this.parseBlock()
    branches.push({ test, body })
    let orelse: Stmt[] | null = null
    while (this.at('KEYWORD', 'elif')) {
      this.advance()
      const elifTest = this.parseExpr()
      this.expect('OP', ':')
      const elifBody = this.parseBlock()
      branches.push({ test: elifTest, body: elifBody })
    }
    if (this.at('KEYWORD', 'else')) {
      this.advance()
      this.expect('OP', ':')
      orelse = this.parseBlock()
    }
    return { kind: 'if', branches, orelse, line: ifTok.line }
  }

  private parseFor(): Stmt {
    const forTok = this.expect('KEYWORD', 'for')
    const varName = this.expect('NAME').value
    this.expect('KEYWORD', 'in')
    this.expect('KEYWORD', 'range')
    this.expect('OP', '(')
    const countTok = this.expect('NUMBER')
    const count = parseInt(countTok.value, 10)
    if (!Number.isInteger(count) || count < 0 || count > 10000) {
      throw new DslError('range() bound must be a non-negative integer literal no greater than 10000 (loops must be statically bounded to compile to GPU code)', countTok.line)
    }
    this.expect('OP', ')')
    this.expect('OP', ':')
    const body = this.parseBlock()
    return { kind: 'for', varName, count, body, line: forTok.line }
  }

  // ---- Expressions (Pratt parser, ascending precedence) ----
  // ternary (lowest) -> or -> and -> not -> comparison -> add/sub -> mul/div/mod -> power (right-assoc) -> unary -> postfix (attr/call) -> atom

  parseExpr(): Expr {
    return this.parseTernary()
  }

  /** Rejects anything left over after an expression — e.g. a stray '=' from an accidental assignment. */
  expectExprEnd(): void {
    if (this.at('NEWLINE') || this.at('EOF')) return
    const t = this.peek()
    throw new DslError(`unexpected '${t.value || t.type}' after expression`, t.line)
  }

  private parseTernary(): Expr {
    const line = this.peek().line
    const thenBranch = this.parseOr()
    if (this.at('KEYWORD', 'if')) {
      this.advance()
      const test = this.parseOr()
      this.expect('KEYWORD', 'else')
      const orelse = this.parseTernary()
      return { kind: 'ternary', test, then: thenBranch, orelse, line }
    }
    return thenBranch
  }

  private parseOr(): Expr {
    let left = this.parseAnd()
    while (this.at('KEYWORD', 'or')) {
      const t = this.advance()
      const right = this.parseAnd()
      left = { kind: 'logical', op: 'or', left, right, line: t.line }
    }
    return left
  }

  private parseAnd(): Expr {
    let left = this.parseNot()
    while (this.at('KEYWORD', 'and')) {
      const t = this.advance()
      const right = this.parseNot()
      left = { kind: 'logical', op: 'and', left, right, line: t.line }
    }
    return left
  }

  private parseNot(): Expr {
    if (this.at('KEYWORD', 'not')) {
      const t = this.advance()
      const operand = this.parseNot()
      return { kind: 'unary', op: 'not', operand, line: t.line }
    }
    return this.parseComparison()
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive()
    while (this.at('OP') && COMPARE_OPS.has(this.peek().value)) {
      const t = this.advance()
      const right = this.parseAdditive()
      left = { kind: 'compare', op: t.value as CompareOp, left, right, line: t.line }
    }
    return left
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative()
    while (this.at('OP', '+') || this.at('OP', '-')) {
      const t = this.advance()
      const right = this.parseMultiplicative()
      left = { kind: 'binary', op: t.value as BinOp, left, right, line: t.line }
    }
    return left
  }

  private parseMultiplicative(): Expr {
    let left = this.parsePower()
    while (this.at('OP', '*') || this.at('OP', '/') || this.at('OP', '%')) {
      const t = this.advance()
      const right = this.parsePower()
      left = { kind: 'binary', op: t.value as BinOp, left, right, line: t.line }
    }
    return left
  }

  private parsePower(): Expr {
    const left = this.parseUnary()
    if (this.at('OP', '**')) {
      const t = this.advance()
      const right = this.parsePower() // right-associative
      return { kind: 'binary', op: '**', left, right, line: t.line }
    }
    return left
  }

  private parseUnary(): Expr {
    if (this.at('OP', '-')) {
      const t = this.advance()
      const operand = this.parseUnary()
      return { kind: 'unary', op: '-', operand, line: t.line }
    }
    return this.parsePostfix()
  }

  private parsePostfix(): Expr {
    let expr = this.parseAtom()
    for (;;) {
      if (this.at('OP', '.')) {
        const t = this.advance()
        const attrTok = this.expect('NAME')
        if (attrTok.value !== 'real' && attrTok.value !== 'imag') {
          throw new DslError(`unknown attribute '.${attrTok.value}' (only .real and .imag are supported)`, attrTok.line)
        }
        expr = { kind: 'attr', obj: expr, attr: attrTok.value, line: t.line }
        continue
      }
      break
    }
    return expr
  }

  private parseAtom(): Expr {
    const t = this.peek()

    if (t.type === 'NUMBER') {
      this.advance()
      return { kind: 'num', value: parseFloat(t.value), line: t.line }
    }
    if (t.type === 'IMAG') {
      this.advance()
      return { kind: 'imag', value: parseFloat(t.value), line: t.line }
    }
    if (t.type === 'KEYWORD' && t.value === 'True') {
      this.advance()
      return { kind: 'bool', value: true, line: t.line }
    }
    if (t.type === 'KEYWORD' && t.value === 'False') {
      this.advance()
      return { kind: 'bool', value: false, line: t.line }
    }
    if (t.type === 'OP' && t.value === '(') {
      this.advance()
      const expr = this.parseExpr()
      this.expect('OP', ')')
      return expr
    }
    if (t.type === 'NAME') {
      this.advance()
      if (this.at('OP', '(')) {
        this.advance()
        const args: Expr[] = []
        if (!this.at('OP', ')')) {
          args.push(this.parseExpr())
          while (this.at('OP', ',')) {
            this.advance()
            args.push(this.parseExpr())
          }
        }
        this.expect('OP', ')')
        return { kind: 'call', callee: t.value, args, line: t.line }
      }
      return { kind: 'name', name: t.value, line: t.line }
    }

    throw new DslError(`unexpected token '${t.value || t.type}'`, t.line)
  }
}

/** Parses a full DSL source file (one or more `def` blocks) into a Program AST. */
export function parseProgram(source: string): Program {
  const tokens = tokenize(source)
  return new Parser(tokens).parseProgram()
}

/** Parses a single standalone expression (used for Inline-mode fields). */
export function parseSingleExpr(source: string, line = 1): Expr {
  // Inline-mode fields are one-liners with no indentation structure, so we
  // synthesize just enough token stream to reuse the same expression grammar.
  const tokens = tokenize(source.trim() + '\n')
  const p = new Parser(tokens)
  const expr = p.parseExpr()
  p.expectExprEnd()
  void line
  return expr
}
