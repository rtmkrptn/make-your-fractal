// A single error type used across lexing, parsing, and compiling so the UI
// can show one consistent "line N: message" banner regardless of which
// stage caught the problem.
export class DslError extends Error {
  line: number
  constructor(message: string, line: number) {
    super(`Line ${line}: ${message}`)
    this.line = line
    this.name = 'DslError'
  }
}
