/**
 * Building a trigger from a line the MUD already sent.
 *
 * The line is cut into tokens; the player picks which of them should be
 * captured rather than matched literally, and the pattern is composed from
 * that choice. Numbers and capitalised words are the usual suspects (an
 * amount, a name), so they are flagged as suggestions, but any word can be
 * captured.
 *
 * Pure and DOM-free so it can be tested headlessly.
 */
import type { TriggerDef } from '../../../shared/types'

export type TokenKind = 'number' | 'word' | 'other'

export interface LineToken {
  text: string
  kind: TokenKind
  /** A likely capture: a number, or a word that starts with a capital. */
  suggested: boolean
}

const TOKEN_RE = /\d+(?:[.,]\d+)*|[A-Za-z][\w']*|\s+|[^\w\s]+/g

/** Cut a line into words, numbers, whitespace and punctuation, in order. */
export function tokenizeLine(text: string): LineToken[] {
  const out: LineToken[] = []
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0]
    let kind: TokenKind = 'other'
    if (/^\d/.test(t)) kind = 'number'
    else if (/^[A-Za-z]/.test(t)) kind = 'word'
    // "You" and "The" open most MUD lines; they are never what someone
    // wants captured, so the first word is not suggested on capitalisation
    // alone.
    const suggested =
      kind === 'number' || (kind === 'word' && out.length > 0 && /^[A-Z]/.test(t))
    out.push({ text: t, kind, suggested })
  }
  return out
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

export interface BuildOptions {
  /** Match only at the start of the line. */
  anchorStart: boolean
  /** Match only at the end of the line. */
  anchorEnd: boolean
}

/**
 * Compose a regex from the tokens, capturing the ones whose index is in
 * `captured`. Runs of whitespace become `\s+` so a line that wraps or pads
 * differently still matches; everything else is literal.
 */
export function buildPattern(
  tokens: LineToken[],
  captured: ReadonlySet<number>,
  opts: BuildOptions
): string {
  let body = ''
  tokens.forEach((tok, i) => {
    if (captured.has(i)) {
      body += tok.kind === 'number' ? '(\\d+)' : tok.kind === 'word' ? "([\\w']+)" : '(.+?)'
    } else if (/^\s+$/.test(tok.text)) {
      body += '\\s+'
    } else {
      body += escapeRegex(tok.text)
    }
  })
  return `${opts.anchorStart ? '^' : ''}${body}${opts.anchorEnd ? '$' : ''}`
}

/** The index of the capture group a token will become, or null. */
export function captureNumber(captured: ReadonlySet<number>, index: number): number | null {
  if (!captured.has(index)) return null
  let n = 0
  for (const i of [...captured].sort((a, b) => a - b)) {
    n++
    if (i === index) return n
  }
  return null
}

export interface MatchPreview {
  count: number
  total: number
  /** The most recent line that would have fired, if any. */
  sample: string | null
  /** The regex failed to compile. */
  error: string | null
}

/**
 * How often a trigger would have fired over recent output. Mirrors the
 * engine's matching (substring or regex, optional case folding) without
 * touching it, so the editor can answer while the pattern is being typed.
 */
export function previewMatches(
  trigger: Pick<TriggerDef, 'pattern' | 'matchType' | 'caseInsensitive'>,
  lines: readonly string[]
): MatchPreview {
  const total = lines.length
  if (!trigger.pattern) return { count: 0, total, sample: null, error: null }
  let test: (line: string) => boolean
  if (trigger.matchType === 'substring') {
    const needle = trigger.caseInsensitive ? trigger.pattern.toLowerCase() : trigger.pattern
    test = (line) => (trigger.caseInsensitive ? line.toLowerCase() : line).includes(needle)
  } else {
    let re: RegExp
    try {
      re = new RegExp(trigger.pattern, trigger.caseInsensitive ? 'i' : '')
    } catch (e) {
      return { count: 0, total, sample: null, error: e instanceof Error ? e.message : String(e) }
    }
    test = (line) => re.test(line)
  }
  let count = 0
  let sample: string | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    if (test(lines[i])) {
      count++
      if (sample === null) sample = lines[i]
    }
  }
  return { count, total, sample, error: null }
}
