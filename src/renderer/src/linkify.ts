/**
 * Web addresses in plain output text -- "see https://tbamud.com/docs" or
 * "our forum is at forum.example.org" -- found so the renderer can make them
 * clickable. MXP links are a different thing: the server marks those up.
 *
 * Conservative on purpose. A bare host with no scheme only counts with a
 * well-known top-level domain, so "e.g." and "file.txt" stay text; a port
 * is not taken on a bare host, since "tbamud.com:9091" is a MUD, not a
 * web page, and the link is to the site alone; an address inside an email
 * is left alone; and trailing punctuation belongs to the sentence, not the
 * link, including a closing bracket the link did not open.
 */

import type { Span } from './ansi.ts'

export interface TextLink {
  /** Offsets into the text: [start, end). */
  start: number
  end: number
  /** What to open: the text itself, given a scheme when it had none. */
  href: string
}

export type LinkPart = { text: string; href?: string }

/** Detect on the assembled line, then project destinations back onto its styles.
 * Explicit MXP links are boundaries and retain their server-provided behavior.
 */
export function splitSpanLinks(spans: Span[]): LinkPart[][] {
  const text = spans.map(s => s.link ? ' '.repeat(s.text.length) : s.text).join('')
  const links = findLinks(text)
  let offset = 0
  let first = 0
  return spans.map(span => {
    const start = offset
    const end = offset += span.text.length
    while (first < links.length && links[first].end <= start) first++
    const parts: LinkPart[] = []
    let at = start
    for (let i = first; i < links.length && links[i].start < end; i++) {
      const link = links[i]
      const left = Math.max(start, link.start)
      const right = Math.min(end, link.end)
      if (left > at) parts.push({ text: span.text.slice(at - start, left - start) })
      parts.push({ text: span.text.slice(left - start, right - start), href: link.href })
      at = right
    }
    if (at < end) parts.push({ text: span.text.slice(at - start) })
    return parts.length ? parts : [{ text: span.text }]
  })
}

const TLDS = [
  'com', 'net', 'org', 'io', 'gov', 'edu', 'mil', 'info', 'biz', 'co', 'us', 'uk', 'ca', 'au', 'nz',
  'de', 'fr', 'nl', 'be', 'se', 'no', 'dk', 'fi', 'pl', 'cz', 'at', 'ch', 'it', 'es', 'pt', 'ie', 'eu',
  'ru', 'jp', 'kr', 'cn', 'in', 'br', 'mx', 'ar', 'za', 'me', 'tv', 'gg', 'dev', 'app', 'xyz', 'club',
  'games', 'game', 'online', 'site', 'tech', 'wiki', 'blog', 'space', 'zone', 'world', 'live', 'chat'
]

const URL_RE = new RegExp(
  [
    // With a scheme: anything up to whitespace or a quote/bracket that never
    // belongs in a pasted URL.
    'https?:\\/\\/[^\\s<>"\'`]+',
    // www. without a scheme.
    'www\\.[^\\s<>"\'`]+',
    // A bare host with a known TLD, then an optional path. The lookahead
    // keeps "example.community" and "example.com.au" from stopping at .com.
    `(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS.join('|')})(?![a-z0-9-]|\\.[a-z])(?:\\/[^\\s<>"'\`]*)?`
  ].join('|'),
  'gi'
)

/** Characters a sentence leaves after a link that were never part of it. */
const TRAILING = /[.,;:!?'")\]}>]+$/

export function findLinks(text: string): TextLink[] {
  const out: TextLink[] = []
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text)) !== null) {
    let start = m.index
    let raw = m[0]
    // Not the start of a word: "xhttp://" or the domain part of an email.
    const before = start > 0 ? text[start - 1] : ' '
    if (/[a-z0-9@._-]/i.test(before)) continue
    // Trailing sentence punctuation, and any ')' the link did not open.
    for (;;) {
      const trimmed = raw.replace(TRAILING, '')
      if (trimmed === raw) break
      // A ')' that closes a '(' inside the link (Wikipedia style) stays.
      if (raw.endsWith(')') && count(trimmed + ')', '(') >= count(trimmed + ')', ')')) {
        raw = trimmed + ')'
        break
      }
      raw = trimmed
    }
    if (raw.length === 0) continue
    // A bare host needs at least a letter in its last label to be a site.
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    out.push({ start, end: start + raw.length, href })
    URL_RE.lastIndex = start + raw.length
  }
  return out
}

function count(s: string, ch: string): number {
  let n = 0
  for (const c of s) if (c === ch) n++
  return n
}

/** Text split into plain runs and links, in order, for rendering. */
export function splitLinks(text: string): Array<{ text: string; href?: string }> {
  const links = findLinks(text)
  if (links.length === 0) return [{ text }]
  const parts: Array<{ text: string; href?: string }> = []
  let at = 0
  for (const l of links) {
    if (l.start > at) parts.push({ text: text.slice(at, l.start) })
    parts.push({ text: text.slice(l.start, l.end), href: l.href })
    at = l.end
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}
