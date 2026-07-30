// AST node definitions for the Fractal Forge DSL — a constrained, Python-flavored
// language for defining complex-number iteration functions and escape rules.
// Every node carries a source line for error reporting.

export type Expr =
  | { kind: 'num'; value: number; line: number } // real literal, e.g. 2, 3.5
  | { kind: 'imag'; value: number; line: number } // imaginary literal, e.g. 3j -> 0+3i
  | { kind: 'bool'; value: boolean; line: number }
  | { kind: 'name'; name: string; line: number }
  | { kind: 'attr'; obj: Expr; attr: 'real' | 'imag'; line: number } // z.real / z.imag
  | { kind: 'unary'; op: '-' | 'not'; operand: Expr; line: number }
  | { kind: 'binary'; op: BinOp; left: Expr; right: Expr; line: number }
  | { kind: 'compare'; op: CompareOp; left: Expr; right: Expr; line: number }
  | { kind: 'logical'; op: 'and' | 'or'; left: Expr; right: Expr; line: number }
  | { kind: 'call'; callee: string; args: Expr[]; line: number }
  | { kind: 'ternary'; test: Expr; then: Expr; orelse: Expr; line: number }

export type BinOp = '+' | '-' | '*' | '/' | '**' | '%'
export type CompareOp = '<' | '<=' | '>' | '>=' | '==' | '!='

export type Stmt =
  | { kind: 'assign'; name: string; value: Expr; line: number }
  | { kind: 'return'; value: Expr; line: number }
  | {
      kind: 'if'
      branches: { test: Expr; body: Stmt[] }[] // if + elifs
      orelse: Stmt[] | null
      line: number
    }
  | { kind: 'for'; varName: string; count: number; body: Stmt[]; line: number }

export interface FunctionDef {
  name: string
  params: string[]
  body: Stmt[]
  line: number
}

export interface Program {
  functions: Map<string, FunctionDef>
}
