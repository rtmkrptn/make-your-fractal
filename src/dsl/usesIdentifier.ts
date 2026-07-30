import { tokenize } from './lexer'

/**
 * Whether `name` appears as a standalone identifier in `source`. Uses the
 * real tokenizer (so e.g. `c` inside `cos(...)` doesn't count) and falls
 * back to a word-boundary regex if the source doesn't tokenize cleanly
 * (expected while the user is mid-edit).
 */
export function usesIdentifier(source: string, name: string): boolean {
  try {
    return tokenize(source).some((t) => t.type === 'NAME' && t.value === name)
  } catch {
    return new RegExp(`\\b${name}\\b`).test(source)
  }
}
