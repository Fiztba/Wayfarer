/**
 * Text capture — recognizing "you are in a room" from raw MUD prose.
 *
 * The exits line is the anchor (its formats are distinctive per codebase);
 * the room title is found by scanning back from it past description prose.
 * A direction token wrapped in parentheses marks a closed door (ROM/Merc
 * convention), which we record as a door on that exit.
 */
import {
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
}

/** Parse an exits line; null if the line is not an exits line. */
export function parseExitsLine(line: string): ExitToken[] | null {
  for (const pattern of EXIT_LINE_PATTERNS) {
    const m = pattern.exec(line)
    if (!m) continue
    const body = m[1].trim()
    if (body.length === 0) return [] // "Exits: none" style
    const tokens = body.split(/[,\s]+/).filter(Boolean)
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
    // A line that matched but contained no recognizable direction (and wasn't
    // an explicit "none") is probably prose like "Exits: blocked by rubble".
    if (!sawDirection && !/^\s*none\s*\.?$/i.test(body)) return null
    return exits
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
export function cleanTitleLine(line: string): { name: string; vnum: string | null } {
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
    const next = t.replace(TRAILING_TAG, '')
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
  private static MAX_RECENT = 12

  /** Returns a detection if this line completed one. */
  feedLine(plain: string): RoomDetection | null {
    const exits = parseExitsLine(plain)
    if (exits === null) {
      this.recent.push(plain)
      if (this.recent.length > RoomCapture.MAX_RECENT) this.recent.shift()
      return null
    }
    // Scan back past description prose for the nearest title-shaped line.
    // Each candidate is undecorated first (glued prompt, staff vnum/flag
    // tags) so the heuristics judge the name a player would actually read.
    let name = ''
    let vnum: string | null = null
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const raw = this.recent[i]
      if (looksLikePrompt(raw)) continue
      const candidate = cleanTitleLine(raw)
      if (candidate.name.length === 0) continue
      if (looksLikeTitle(candidate.name)) {
        name = candidate.name
        vnum = candidate.vnum
        break
      }
    }
    if (!name) {
      // Fall back to the nearest non-empty line even if prose-shaped — but
      // still never a prompt, which would otherwise win this scan outright.
      for (let i = this.recent.length - 1; i >= 0; i--) {
        const raw = this.recent[i]
        if (looksLikePrompt(raw)) continue
        const candidate = cleanTitleLine(raw)
        if (candidate.name.length > 0) {
          name = candidate.name.slice(0, 70)
          vnum = candidate.vnum
          break
        }
      }
    }
    this.recent = []
    if (!name) return null
    // A vnum on the title line is the server's own room id, and it shares the
    // "vnum:" namespace with the MSDP report so the two agree about identity.
    return vnum ? { name, exits, serverId: `vnum:${vnum}` } : { name, exits }
  }

  reset(): void {
    this.recent = []
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
