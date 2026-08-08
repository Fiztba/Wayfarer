/**
 * Streaming ANSI/SGR parser. Turns raw MUD output into styled spans + newlines,
 * preserving attribute state across chunk boundaries (including partial escape
 * sequences split between packets).
 *
 * Supports 16-color (with classic bold=bright MUD behavior), 256-color, and
 * 24-bit truecolor, plus bold/dim/italic/underline/inverse/strikethrough.
 */

/** Clickable MXP link attached to a span. */
export interface MxpLink {
  /** MUD command to send on click (send tags). */
  command?: string
  /** External URL to open (a tags). */
  url?: string
  hint?: string
  /** Put the command in the input line instead of sending it. */
  prompt?: boolean
  /** Text content accumulated while the tag was open (command fallback). */
  textAcc?: string
}

export interface Span {
  text: string
  style: SpanStyle
  link?: MxpLink
}

export interface SpanStyle {
  color?: string
  background?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  dim?: boolean
}

export type Token = { kind: 'span'; span: Span } | { kind: 'newline' }

// A comfortable dark-terminal palette (based on a softened xterm scheme).
const BASE16 = [
  '#3b4048', // black
  '#e06c75', // red
  '#98c379', // green
  '#e5c07b', // yellow
  '#61afef', // blue
  '#c678dd', // magenta
  '#56b6c2', // cyan
  '#c8ccd4', // white
  '#5c6370', // bright black
  '#ff7b86', // bright red
  '#b5e890', // bright green
  '#ffd68a', // bright yellow
  '#80c7ff', // bright blue
  '#e08aff', // bright magenta
  '#66d9e8', // bright cyan
  '#ffffff' // bright white
]

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]

/** Index of the '>' closing a tag opened at `start` ('<'), honoring quotes; -1 if absent. */
function findTagEnd(text: string, start: number): number {
  let quote: string | null = null
  for (let j = start + 1; j < text.length; j++) {
    const c = text[j]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '>') {
      return j
    } else if (c === '\n' || c === '\r') {
      return -1 // tags never span lines; treat as malformed
    }
  }
  return -1
}

/** Split tag innards into tokens, keeping quoted strings intact. */
function tokenizeTag(s: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: string | null = null
  for (const c of s) {
    if (quote) {
      current += c
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
      current += c
    } else if (/\s/.test(c)) {
      if (current) tokens.push(current)
      current = ''
    } else {
      current += c
    }
  }
  if (current) tokens.push(current)
  return tokens
}

function unquote(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1)
  }
  return s
}

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

function decodeEntity(name: string): string | null {
  if (name in ENTITY_MAP) return ENTITY_MAP[name]
  if (/^#\d{1,5}$/.test(name)) {
    const code = Number(name.slice(1))
    if (code >= 32 && code <= 0x10ffff) return String.fromCodePoint(code)
  }
  return null
}

function color256(n: number): string {
  if (n < 16) return BASE16[n]
  if (n < 232) {
    const i = n - 16
    const r = CUBE_LEVELS[Math.floor(i / 36)]
    const g = CUBE_LEVELS[Math.floor(i / 6) % 6]
    const b = CUBE_LEVELS[i % 6]
    return `rgb(${r},${g},${b})`
  }
  const v = 8 + (n - 232) * 10
  return `rgb(${v},${v},${v})`
}

interface Attrs {
  fg: number | string | null // 0-255 palette index, css string (truecolor), or null (default)
  bg: number | string | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
  strike: boolean
}

const DEFAULT_ATTRS: Attrs = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false
}

export const DEFAULT_FG = '#c8ccd4'
export const DEFAULT_BG = '#0d1117'

export class AnsiParser {
  private attrs: Attrs = { ...DEFAULT_ATTRS }
  private escBuf = '' // holds a partial escape sequence across chunks
  private cachedStyle: SpanStyle | null = null
  // Both \r and \n break lines, but a \r\n or \n\r PAIR is a single break
  // (stock Diku famously sends \n\r). Flags persist across chunks.
  private lastWasCR = false
  private lastWasLF = false

  // ---- MXP state (active only after the server negotiates option 91) ----
  /** Set by the session when MXP is negotiated. */
  mxpEnabled = false
  /** Called with client replies (<VERSION>/<SUPPORT> responses). */
  onMxpReply: ((text: string) => void) | null = null
  private mxpMode = 0 // 0 open, 1 secure, 2 locked, 4 secure-for-one-tag
  private mxpDefault = 0 // applied at each line start (set by lock modes 5/6/7)
  private mxpLink: MxpLink | null = null
  private mxpColorStack: Array<{ fg: number | string | null; bg: number | string | null }> = []

  private mxpSecure(): boolean {
    return this.mxpMode === 1 || this.mxpMode === 4
  }

  parse(input: string): Token[] {
    const tokens: Token[] = []
    let text = this.escBuf + input
    this.escBuf = ''
    let plain = ''

    const flushPlain = () => {
      if (plain) {
        const span: Span = { text: plain, style: this.style() }
        if (this.mxpLink) {
          span.link = this.mxpLink
          this.mxpLink.textAcc = (this.mxpLink.textAcc ?? '') + plain
        }
        tokens.push({ kind: 'span', span })
        plain = ''
      }
    }

    const emitNewline = () => {
      flushPlain()
      tokens.push({ kind: 'newline' })
      this.mxpMode = this.mxpDefault
    }

    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (ch === '\x1b') {
        this.lastWasCR = false
        this.lastWasLF = false
        const consumed = this.tryConsumeEscape(text, i, flushPlain)
        if (consumed === -1) {
          // Incomplete escape at end of chunk; save the tail for next time.
          this.escBuf = text.slice(i)
          break
        }
        i = consumed
      } else if (ch === '\r') {
        // MUDs redraw prompts with a bare CR; treating it as a line break
        // keeps prompt text from fusing onto whatever follows.
        if (this.lastWasLF) {
          this.lastWasLF = false // second half of an \n\r pair
        } else {
          emitNewline()
          this.lastWasCR = true
        }
      } else if (ch === '\n') {
        if (this.lastWasCR) {
          this.lastWasCR = false // second half of an \r\n pair
        } else {
          emitNewline()
          this.lastWasLF = true
        }
      } else if (ch === '\x00' || ch === '\x07') {
        // Ignore NUL, BEL.
      } else if (this.mxpEnabled && this.mxpSecure() && ch === '<') {
        this.lastWasCR = false
        this.lastWasLF = false
        const end = findTagEnd(text, i)
        if (end === -1) {
          // Tag split across chunks; keep the tail for next time.
          this.escBuf = text.slice(i)
          break
        }
        flushPlain()
        this.handleMxpTag(text.slice(i + 1, end), tokens, emitNewline)
        if (this.mxpMode === 4) this.mxpMode = this.mxpDefault // one tag only
        i = end
      } else if (this.mxpEnabled && this.mxpMode !== 2 && ch === '&') {
        this.lastWasCR = false
        this.lastWasLF = false
        const semi = text.indexOf(';', i)
        if (semi === -1 && text.length - i < 10) {
          this.escBuf = text.slice(i)
          break
        }
        if (semi !== -1 && semi - i <= 8) {
          const decoded = decodeEntity(text.slice(i + 1, semi))
          if (decoded !== null) {
            plain += decoded
            i = semi
            continue
          }
        }
        plain += ch
      } else {
        this.lastWasCR = false
        this.lastWasLF = false
        plain += ch
      }
    }
    flushPlain()
    return tokens
  }

  /**
   * Attempt to consume an escape sequence starting at index i (text[i] === ESC).
   * Returns the index of the final consumed character, or -1 if incomplete.
   */
  private tryConsumeEscape(text: string, i: number, flushPlain: () => void): number {
    if (i + 1 >= text.length) return -1
    const kind = text[i + 1]

    if (kind === '[') {
      // CSI sequence: ESC [ params final-byte(0x40-0x7e)
      for (let j = i + 2; j < text.length; j++) {
        const c = text.charCodeAt(j)
        if (c >= 0x40 && c <= 0x7e) {
          if (text[j] === 'm') {
            flushPlain()
            this.applySgr(text.slice(i + 2, j))
          } else if (text[j] === 'z' && this.mxpEnabled) {
            // MXP line-mode tag: ESC[#z
            this.applyMxpLineMode(parseInt(text.slice(i + 2, j), 10) || 0)
          }
          // All other CSI sequences (cursor movement etc.) are ignored.
          return j
        }
      }
      return -1
    }

    if (kind === ']') {
      // OSC sequence: terminated by BEL or ST (ESC \)
      for (let j = i + 2; j < text.length; j++) {
        if (text[j] === '\x07') return j
        if (text[j] === '\x1b' && text[j + 1] === '\\') return j + 1
      }
      return -1
    }

    // Two-character escape (ESC + single char): consume and ignore.
    return i + 1
  }

  private applySgr(params: string): void {
    this.cachedStyle = null
    const parts = params.length === 0 ? [0] : params.split(';').map((p) => parseInt(p, 10) || 0)
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      const a = this.attrs
      if (p === 0) Object.assign(a, DEFAULT_ATTRS)
      else if (p === 1) a.bold = true
      else if (p === 2) a.dim = true
      else if (p === 3) a.italic = true
      else if (p === 4) a.underline = true
      else if (p === 7) a.inverse = true
      else if (p === 9) a.strike = true
      else if (p === 21 || p === 22) {
        a.bold = false
        a.dim = false
      } else if (p === 23) a.italic = false
      else if (p === 24) a.underline = false
      else if (p === 27) a.inverse = false
      else if (p === 29) a.strike = false
      else if (p >= 30 && p <= 37) a.fg = p - 30
      else if (p === 39) a.fg = null
      else if (p >= 40 && p <= 47) a.bg = p - 40
      else if (p === 49) a.bg = null
      else if (p >= 90 && p <= 97) a.fg = p - 90 + 8
      else if (p >= 100 && p <= 107) a.bg = p - 100 + 8
      else if (p === 38 || p === 48) {
        const isFg = p === 38
        if (parts[i + 1] === 5 && parts.length > i + 2) {
          const idx = Math.min(255, Math.max(0, parts[i + 2]))
          if (isFg) a.fg = idx
          else a.bg = idx
          i += 2
        } else if (parts[i + 1] === 2 && parts.length > i + 4) {
          const css = `rgb(${parts[i + 2] & 255},${parts[i + 3] & 255},${parts[i + 4] & 255})`
          if (isFg) a.fg = css
          else a.bg = css
          i += 4
        }
      }
    }
  }

  // ---- MXP ----------------------------------------------------------------

  private applyMxpLineMode(n: number): void {
    if (n === 0 || n === 1 || n === 2 || n === 4) this.mxpMode = n
    else if (n === 3) {
      // Reset: close open tags, back to the default mode.
      this.mxpLink = null
      this.mxpColorStack = []
      this.mxpMode = this.mxpDefault
    } else if (n === 5) {
      this.mxpDefault = 0
      this.mxpMode = 0
    } else if (n === 6) {
      this.mxpDefault = 1
      this.mxpMode = 1
    } else if (n === 7) {
      this.mxpDefault = 2
      this.mxpMode = 2
    }
  }

  private handleMxpTag(inner: string, tokens: Token[], emitNewline: () => void): void {
    const raw = inner.trim()
    if (raw.length === 0 || raw.startsWith('!')) return
    const closing = raw.startsWith('/')
    const parts = tokenizeTag(closing ? raw.slice(1) : raw)
    if (parts.length === 0) return
    const name = parts[0].toLowerCase()
    const attrs = new Map<string, string>()
    const bare: string[] = []
    const flags = new Set<string>()
    for (const part of parts.slice(1)) {
      const eq = part.indexOf('=')
      if (eq > 0) attrs.set(part.slice(0, eq).toLowerCase(), unquote(part.slice(eq + 1)))
      else if (part.toLowerCase() === 'prompt') flags.add('prompt')
      else bare.push(unquote(part))
    }
    const a = this.attrs
    this.cachedStyle = null

    switch (name) {
      case 'send':
        if (closing) {
          const link = this.mxpLink
          if (link) {
            const textContent = (link.textAcc ?? '').trim()
            if (!link.command) link.command = textContent
            else if (link.command.includes('&text;')) {
              link.command = link.command.replace(/&text;/g, textContent)
            }
          }
          this.mxpLink = null
        } else {
          this.mxpLink = {
            command: attrs.get('href') ?? bare[0],
            hint: attrs.get('hint'),
            prompt: flags.has('prompt'),
            textAcc: ''
          }
        }
        break
      case 'a':
        if (closing) {
          const link = this.mxpLink
          if (link && !link.url) link.url = (link.textAcc ?? '').trim()
          this.mxpLink = null
        } else {
          this.mxpLink = { url: attrs.get('href') ?? bare[0], textAcc: '' }
        }
        break
      case 'b':
      case 'strong':
        a.bold = !closing
        break
      case 'i':
      case 'em':
        a.italic = !closing
        break
      case 'u':
        a.underline = !closing
        break
      case 's':
      case 'strike':
        a.strike = !closing
        break
      case 'color':
      case 'c':
      case 'font': {
        if (closing) {
          const prev = this.mxpColorStack.pop()
          if (prev) {
            a.fg = prev.fg
            a.bg = prev.bg
          }
        } else {
          this.mxpColorStack.push({ fg: a.fg, bg: a.bg })
          const fore = attrs.get('fore') ?? attrs.get('color') ?? bare[0]
          const back = attrs.get('back') ?? bare[1]
          if (fore) a.fg = fore
          if (back) a.bg = back
        }
        break
      }
      case 'br':
        emitNewline()
        break
      case 'version':
        this.onMxpReply?.('\x1b[1z<VERSION MXP=1.0 CLIENT=Wayfarer VERSION=0.1.0>')
        break
      case 'support':
        this.onMxpReply?.(
          '\x1b[1z<SUPPORTS +send +a +b +i +u +s +em +strong +color +c +font +br +version +support>'
        )
        break
      default:
        // Unknown/unsupported tag: swallow the tag, keep its content.
        break
    }
    void tokens
  }

  private resolve(c: number | string | null, isFg: boolean, bold: boolean): string | undefined {
    if (c === null) return undefined
    if (typeof c === 'string') return c
    // Classic MUD behavior: bold + base color = bright variant.
    if (isFg && bold && c < 8) return BASE16[c + 8]
    return color256(c)
  }

  private style(): SpanStyle {
    if (this.cachedStyle) return this.cachedStyle
    const a = this.attrs
    let color = this.resolve(a.fg, true, a.bold)
    let background = this.resolve(a.bg, false, false)
    if (a.inverse) {
      const fg = color ?? DEFAULT_FG
      const bg = background ?? DEFAULT_BG
      color = bg
      background = fg
    }
    const s: SpanStyle = {}
    if (color) s.color = color
    if (background) s.background = background
    if (a.bold) s.bold = true
    if (a.dim) s.dim = true
    if (a.italic) s.italic = true
    if (a.underline) s.underline = true
    if (a.strike) s.strike = true
    this.cachedStyle = s
    return s
  }
}
