import { DslError } from './errors'

export type TokenType =
  | 'NUMBER'
  | 'IMAG'
  | 'NAME'
  | 'KEYWORD'
  | 'OP'
  | 'NEWLINE'
  | 'INDENT'
  | 'DEDENT'
  | 'EOF'

export interface Token {
  type: TokenType
  value: string
  line: number
}

const KEYWORDS = new Set([
  'def', 'return', 'if', 'elif', 'else', 'for', 'in', 'range',
  'and', 'or', 'not', 'True', 'False',
])

// Longest-match-first so e.g. '**' beats '*' and '<=' beats '<'.
const OPERATORS = ['**', '//', '==', '!=', '<=', '>=', '->', '(', ')', ':', ',', '.', '+', '-', '*', '/', '%', '=', '<', '>']

/**
 * Tokenizes the DSL source, which uses Python-style significant indentation.
 * Blank lines and lines that are only a comment are skipped entirely. Newlines
 * inside parentheses are treated as whitespace (so call args can wrap), matching
 * Python's implicit line-joining rule.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  const indentStack = [0]
  let parenDepth = 0
  let atLineStart = true
  let line = 1

  const src = source.replace(/\t/g, '    ') // treat tabs as 4 spaces
  let i = 0

  const peekChar = () => src[i]

  while (i < src.length) {
    if (atLineStart && parenDepth === 0) {
      // Measure indentation of this line.
      const lineStart = i
      let col = 0
      while (src[i] === ' ') {
        col++
        i++
      }
      // Skip blank lines and comment-only lines without touching indent stack.
      if (src[i] === '\n' || src[i] === undefined) {
        if (src[i] === '\n') {
          line++
          i++
        }
        continue
      }
      if (src[i] === '#') {
        while (i < src.length && src[i] !== '\n') i++
        continue
      }
      void lineStart
      if (col > indentStack[indentStack.length - 1]) {
        indentStack.push(col)
        tokens.push({ type: 'INDENT', value: '', line })
      } else {
        while (col < indentStack[indentStack.length - 1]) {
          indentStack.pop()
          tokens.push({ type: 'DEDENT', value: '', line })
        }
        if (col !== indentStack[indentStack.length - 1]) {
          throw new DslError('unindent does not match any outer indentation level', line)
        }
      }
      atLineStart = false
      continue
    }

    const ch = peekChar()

    if (ch === undefined) break

    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }

    if (ch === '\n') {
      i++
      if (parenDepth === 0) {
        tokens.push({ type: 'NEWLINE', value: '', line })
        atLineStart = true
      }
      line++
      continue
    }

    if (ch === ' ' || ch === '\r') {
      i++
      continue
    }

    if (ch === '(') {
      parenDepth++
      tokens.push({ type: 'OP', value: '(', line })
      i++
      continue
    }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
      tokens.push({ type: 'OP', value: ')', line })
      i++
      continue
    }

    // Numbers: 123, 3.14, .5, 2j, 3.5j
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const start = i
      while (/[0-9]/.test(src[i] ?? '')) i++
      if (src[i] === '.') {
        i++
        while (/[0-9]/.test(src[i] ?? '')) i++
      }
      if (src[i] === 'e' || src[i] === 'E') {
        i++
        if (src[i] === '+' || src[i] === '-') i++
        while (/[0-9]/.test(src[i] ?? '')) i++
      }
      const text = src.slice(start, i)
      if (src[i] === 'j' || src[i] === 'J') {
        i++
        tokens.push({ type: 'IMAG', value: text, line })
      } else {
        tokens.push({ type: 'NUMBER', value: text, line })
      }
      continue
    }

    // Names / keywords
    if (/[A-Za-z_]/.test(ch)) {
      const start = i
      while (/[A-Za-z0-9_]/.test(src[i] ?? '')) i++
      const text = src.slice(start, i)
      tokens.push({ type: KEYWORDS.has(text) ? 'KEYWORD' : 'NAME', value: text, line })
      continue
    }

    // Operators (longest match first)
    const opMatch = OPERATORS.find((op) => src.startsWith(op, i))
    if (opMatch) {
      tokens.push({ type: 'OP', value: opMatch, line })
      i += opMatch.length
      continue
    }

    throw new DslError(`unexpected character '${ch}'`, line)
  }

  // Close out any trailing logical line / open indents.
  if (tokens.length && tokens[tokens.length - 1].type !== 'NEWLINE') {
    tokens.push({ type: 'NEWLINE', value: '', line })
  }
  while (indentStack.length > 1) {
    indentStack.pop()
    tokens.push({ type: 'DEDENT', value: '', line })
  }
  tokens.push({ type: 'EOF', value: '', line })

  return tokens
}
