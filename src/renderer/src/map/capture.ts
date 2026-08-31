/**
 * Text capture — recognizing "you are in a room" from raw MUD prose.
 *
 * The exits line is the anchor (its formats are distinctive per codebase);
 * the room title is found by scanning back from it past description prose.
 * A direction token wrapped in parentheses marks a closed door (ROM/Merc
 * convention), which we record as a door on that exit.
 */
import type { CaptureRule } from '../../../shared/types'
import {
  hashText,
  stripPromptPrefix,
  wordToDirection,
  type Direction,
  type RoomDetection
} from './types.ts'

/** Exit-line patterns, tried in order. Capture group 1 = the exits text. */
const EXIT_LINE_PATTERNS: RegExp[] = [
  /^\[\s*(?:Obvious\s+)?Exits?:\s*([^\]]*?)\s*\]/i, // Circle/tba: [ Exits: n e w ]
  /^\s*(?:Obvious\s+)?Exits?:\s*(.+?)\s*\.?\s*$/i, // SMAUG/ROM/Merc: Exits: north east.
  /^\s*There (?:is|are) \w+ obvious exits?:\s*(.+?)\s*\.?\s*$/i // LP-ish prose
]

export interface ExitToken {
  dir: Direction
  door: boolean
  /** Named by MUDs that list each exit with its destination. */
  destName?: string
}

/**
 * A bare exits header with nothing after it, which introduces one line per
 * exit rather than a single list. AwakeMUD CE and kin print:
 *
 *   Obvious exits:
 *   North - Archetypal Chargen - Mage / Shaman Start Room
 *   South - The Path of the Magician
 *
 * Distinguished from the single-line form purely by having no content after
 * the colon, so the two can never both match.
 */
const EXIT_HEADER = /^\s*(?:Obvious\s+)?Exits?:\s*$/i

/**
 * One line of a listed-exits block: a direction, a separator, and the name of
 * the room it leads to. Requiring the first word to be a real direction is
 * what keeps ordinary prose out.
 */
const EXIT_LIST_LINE = /^\s*\(?([A-Za-z]+)\)?\s+[-\u2013:]\s+(.*\S)\s*$/

export function parseExitListLine(line: string, rule?: CompiledRule): ExitToken | null {
  const pattern = rule?.exitsItem ?? (rule && !rule.builtins ? null : EXIT_LIST_LINE)
  if (!pattern) return null
  const m = pattern.exec(line)
  if (!m) return null
  const dir = wordToDirection(m[1])
  if (!dir) return null
  const door = /^\s*\(/.test(line)
  const dest = (m[2] ?? '').trim()
  return dest ? { dir, door, destName: dest } : { dir, door }
}

/**
 * Compile a rule's patterns once, discarding any that do not compile.
 *
 * A bad regex is a typo in someone's shared config, not a reason to take the
 * mapper down: the offending field is dropped and the rest still applies.
 */
export interface CompiledRule {
  builtins: boolean
  exitsLine?: RegExp
  exitsHeader?: RegExp
  exitsItem?: RegExp
  title?: RegExp
  titleStrip: RegExp[]
  ignore: RegExp[]
  /** Fields that failed to compile, for the settings UI to show. */
  bad: string[]
}

export function compileRule(rule?: CaptureRule): CompiledRule {
  const bad: string[] = []
  const one = (src: string | undefined, field: string): RegExp | undefined => {
    if (!src) return undefined
    try {
      return new RegExp(src, 'i')
    } catch {
      bad.push(field)
      return undefined
    }
  }
  const many = (list: string[] | undefined, field: string): RegExp[] => {
    const out: RegExp[] = []
    for (const src of list ?? []) {
      const r = one(src, field)
      if (r) out.push(r)
    }
    return out
  }
  return {
    builtins: rule?.builtins !== false,
    exitsLine: one(rule?.exitsLine, 'exitsLine'),
    exitsHeader: one(rule?.exitsHeader, 'exitsHeader'),
    exitsItem: one(rule?.exitsItem, 'exitsItem'),
    title: one(rule?.title, 'title'),
    titleStrip: many(rule?.titleStrip, 'titleStrip'),
    ignore: many(rule?.ignore, 'ignore'),
    bad
  }
}

/** Turn the captured text of a single-line exits list into exits. */
function tokensFromList(body: string): ExitToken[] | null {
  const trimmed = body.trim()
  if (trimmed.length === 0) return []
  const tokens = trimmed.split(/[,\s]+/).filter(Boolean)
  const exits: ExitToken[] = []
  let sawDirection = false
  for (const raw of tokens) {
    let token = raw
    let door = false
    if (/^\(.*\)$/.test(token) || /^\[.*\]$/.test(token)) {
      door = true
      token = token.slice(1, -1)
    }
    token = token.replace(/[^a-zA-Z]/g, '')
    if (token.length === 0) continue
    if (/^(none|and|or)$/i.test(token)) continue
    const dir = wordToDirection(token)
    if (dir) {
      sawDirection = true
      if (!exits.some((e) => e.dir === dir)) exits.push({ dir, door })
    }
  }
  // A line that matched but held no recognisable direction (and was not an
  // explicit "none") is probably prose like "Exits: blocked by rubble".
  if (!sawDirection && !/^\s*none\s*\.?$/i.test(trimmed)) return null
  return exits
}

/** Parse an exits line; null if the line is not an exits line. */
export function parseExitsLine(line: string, rule?: CompiledRule): ExitToken[] | null {
  if (rule?.exitsLine) {
    const m = rule.exitsLine.exec(line)
    if (m) return tokensFromList(m[1] ?? '')
  }
  if (rule && !rule.builtins) return null
  for (const pattern of EXIT_LINE_PATTERNS) {
    const m = pattern.exec(line)
    if (!m) continue
    const exits = tokensFromList(m[1] ?? '')
    if (exits) return exits
  }
  return null
}

/**
 * A prompt sitting on its own line. This is not rare: whenever the MUD sends
 * anything while a prompt is open — a syslog line, a tell, mob activity — the
 * open prompt is terminated and becomes a line of its own, so a prompt very
 * often ends up directly above a room description. Two shapes hold across
 * codebases whatever the player configured the prompt to be: it ends with the
 * input marker, and it is stat glyphs rather than prose. tbaMUD's default
 * "1144H 340M 322V >" satisfies both.
 */
function looksLikePrompt(line: string): boolean {
  const t = line.trim()
  if (t.length === 0) return false
  if (/[>:]$/.test(t)) return true
  return !/[A-Za-z]{3}/.test(t) // no word of real length = no room name either
}

const ROOM_VNUM_PREFIX = /^\[\s*(\d+)\s*\]\s*/
const TRAILING_TAG = /\s*\[[^\][]*\]\s*$/u
/** A trailing room-flag in parentheses, e.g. "... Start Room (Peaceful)".
 *  Bounded and word-only so a room genuinely named "(Somewhere)" survives. */
const TRAILING_FLAG = /\s*\((?:[A-Za-z]+(?:[ /-][A-Za-z]+)*)\)\s*$/
const WHOLLY_BRACKETED = /^\[\s*([^\][]*?)\s*\]$/

/**
 * Undecorate a candidate title line.
 *
 * Circle/tbaMUD dress the title line for staff who have roomflags on:
 *   "[57701] Fizban's Mind[ INDOORS PRIVATE HOUSE ATRIUM ][ Inside ][T 57792]"
 * The trailing tags are per-viewer display, so they can never be part of the
 * room's name — and the leading number is the room's vnum, which is real
 * identity and is handed back to the caller. Undecorating happens BEFORE the
 * title heuristics so a decorated title is judged on the name a player would
 * see; judged raw, the line above is rejected as "too long, too many words"
 * and the mapper falls through to naming the room after description prose.
 */
export function cleanTitleLine(
  line: string,
  extraStrips: RegExp[] = []
): { name: string; vnum: string | null } {
  let t = stripPromptPrefix(line).trim()
  let vnum: string | null = null
  const numbered = ROOM_VNUM_PREFIX.exec(t)
  if (numbered) {
    vnum = numbered[1]
    t = t.slice(numbered[0].length).trim()
  }
  // Strip trailing tags one at a time, but never to nothing: some MUDs wrap
  // the whole title in brackets, and that bracket pair is the title's own.
  for (;;) {
    let next = t.replace(TRAILING_TAG, '').replace(TRAILING_FLAG, '')
    for (const strip of extraStrips) next = next.replace(strip, '')
    if (next === t) break
    if (next.trim().length === 0) {
      const whole = WHOLLY_BRACKETED.exec(t)
      if (whole && whole[1].length > 0) t = whole[1]
      break
    }
    t = next
  }
  return { name: t.trim(), vnum }
}

/** Heuristic: is this line plausible as a room title? */
function looksLikeTitle(line: string): boolean {
  const t = line.trim()
  if (t.length === 0 || t.length > 70) return false
  if (/[.!?,]$/.test(t)) return false // prose sentences end with punctuation
  if (/[.!?] /.test(t)) return false // mid-line sentence break = description prose
  if (/^[a-z]/.test(t)) return false // wrapped continuation lines start lowercase
  if (t.split(/\s+/).length > 9) return false // titles are short; prose wraps long
  if (/^\s*[*>]/.test(t)) return false
  return true
}

/**
 * Streaming detector: feed each completed line; emits a RoomDetection when an
 * exits line is recognized, using recent lines to find the title.
 */
export class RoomCapture {
  private recent: string[] = []
  /** How far back to look for the title. Has to clear the longest description
   *  a MUD prints in one go -- an introductory room can run past twenty lines,
   *  and at twelve the title had already fallen out of the window, so the room
   *  got named after a sentence of prose instead. */
  private static MAX_RECENT = 40
  /** Non-null while inside a listed-exits block (see EXIT_HEADER). */
  private listing: ExitToken[] | null = null
  private rule: CompiledRule = compileRule(undefined)
  private ruleSource: CaptureRule | undefined = undefined

  constructor(rule?: CaptureRule) {
    this.useRule(rule)
  }

  /** Adopt a capture rule, recompiling only when it actually changed. */
  useRule(rule: CaptureRule | undefined): void {
    if (rule === this.ruleSource) return
    this.ruleSource = rule
    this.rule = compileRule(rule)
  }

  /** Fields of the current rule that failed to compile. */
  get badPatterns(): string[] {
    return this.rule.bad
  }

  /** Returns a detection if this line completed one. */
  feedLine(plain: string): RoomDetection | null {
    // Lines the rule says are never part of a room -- channel chatter, status
    // bars, anything that would otherwise be mistaken for a title.
    if (this.rule.ignore.some((r) => r.test(plain))) return null
    // A listed-exits block runs until a line that is not an exit -- normally
    // the blank line before the prompt. Its lines never enter `recent`, so
    // they can never be mistaken for a room title.
    if (this.listing !== null) {
      const one = parseExitListLine(plain, this.rule)
      if (one) {
        if (!this.listing.some((e) => e.dir === one.dir)) this.listing.push(one)
        return null
      }
      const collected = this.listing
      this.listing = null
      return this.complete(collected)
    }
    const header = this.rule.exitsHeader ?? (this.rule.builtins ? EXIT_HEADER : null)
    if (header && header.test(plain)) {
      this.listing = []
      return null
    }
    const exits = parseExitsLine(plain, this.rule)
    if (exits === null) {
      this.recent.push(plain)
      if (this.recent.length > RoomCapture.MAX_RECENT) this.recent.shift()
      return null
    }
    return this.complete(exits)
  }

  /** Build the detection for an exits set that has just been recognised. */
  private complete(exits: ExitToken[]): RoomDetection | null {
    // Scan back past description prose for the nearest title-shaped line.
    // Each candidate is undecorated first (glued prompt, staff vnum/flag
    // tags) so the heuristics judge the name a player would actually read.
    let name = ''
    let vnum: string | null = null
    let titleAt = -1
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const raw = this.recent[i]
      if (looksLikePrompt(raw)) continue
      // An explicit title pattern replaces the heuristics outright: whoever
      // wrote it knows their MUD better than a guess about prose shape does.
      if (this.rule.title) {
        const m = this.rule.title.exec(raw)
        if (!m) continue
        const explicit = cleanTitleLine(m[1] ?? m[0], this.rule.titleStrip)
        if (explicit.name.length === 0) continue
        name = explicit.name
        vnum = explicit.vnum
        titleAt = i
        break
      }
      const candidate = cleanTitleLine(raw, this.rule.titleStrip)
      if (candidate.name.length === 0) continue
      if (looksLikeTitle(candidate.name)) {
        name = candidate.name
        vnum = candidate.vnum
        titleAt = i
        break
      }
    }
    if (!name) {
      // Fall back to the nearest non-empty line even if prose-shaped — but
      // still never a prompt, which would otherwise win this scan outright.
      for (let i = this.recent.length - 1; i >= 0; i--) {
        const raw = this.recent[i]
        if (looksLikePrompt(raw)) continue
        const candidate = cleanTitleLine(raw, this.rule.titleStrip)
        if (candidate.name.length > 0) {
          name = candidate.name.slice(0, 70)
          vnum = candidate.vnum
          break
        }
      }
    }
    // The description is the unbroken prose directly under the title. Stopping
    // at the first blank line is what keeps it stable: objects and mobs are
    // printed after that blank (or after the exits line), so picking something
    // up must not change what the room looks like to the mapper.
    let descHash: string | undefined
    if (titleAt >= 0) {
      const body: string[] = []
      for (let i = titleAt + 1; i < this.recent.length; i++) {
        const line = stripPromptPrefix(this.recent[i]).trim()
        if (line.length === 0) break
        body.push(line)
      }
      if (body.length > 0) {
        const hash = hashText(body.join(' '))
        if (hash) descHash = hash
      }
    }

    this.recent = []
    if (!name) return null
    // A vnum on the title line is the server's own room id, and it shares the
    // "vnum:" namespace with the MSDP report so the two agree about identity.
    return vnum ? { name, exits, descHash, serverId: `vnum:${vnum}` } : { name, exits, descHash }
  }

  reset(): void {
    this.recent = []
    this.listing = null
  }
}

/** Movement-failure lines that mean the pending move did NOT happen. */
const MOVE_FAIL_PATTERNS =
  /alas, you cannot go that way|you can'?t go that way|you cannot go there|there is no exit|you can'?t go in that direction|seems to be closed|is closed\.?$|the .{1,30} is closed|you slam into a wall/i

/** Closed-door subset of the failures (marks a door on the attempted exit). */
const DOOR_FAIL_PATTERNS = /seems to be closed|is closed\.?$|the .{1,30} is closed/i

/**
 * The noun the MUD used for the thing in the way. A door is only called "door"
 * on some MUDs — Dawn of Demise calls the one out of Knat's town square a
 * grate, so `open door down` answers "You see no door here." and the auto-open
 * gives up on a door that was never locked. The refusal names it for us.
 */
const DOOR_NAME_PATTERNS = [
  /^\s*the\s+([a-z][a-z' -]{0,28}?)\s+(?:seems to be|appears to be|is)\s+(?:closed|shut)/i,
  /^\s*a\s+([a-z][a-z' -]{0,28}?)\s+(?:blocks|bars)\s+your\s+way/i
]

export function isMoveFailure(line: string): boolean {
  return MOVE_FAIL_PATTERNS.test(line)
}

export function isClosedDoorFailure(line: string): boolean {
  return DOOR_FAIL_PATTERNS.test(line)
}

/** Name of the closed thing, lowercased, or null if the line doesn't say. */
export function closedDoorName(line: string): string | null {
  for (const pattern of DOOR_NAME_PATTERNS) {
    const m = pattern.exec(line)
    if (m) {
      const name = m[1].trim().toLowerCase()
      if (name.length > 0) return name
    }
  }
  return null
}
