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
    // Prompt-shaped prefixes are stripped in case a bare-CR redraw glued the
    // prompt onto the title.
    let name = ''
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const line = stripPromptPrefix(this.recent[i]).trim()
      if (line.length === 0) continue
      if (looksLikeTitle(line)) {
        name = line
        break
      }
    }
    if (!name) {
      // Fall back to the nearest non-empty line even if prose-shaped.
      for (let i = this.recent.length - 1; i >= 0; i--) {
        const line = stripPromptPrefix(this.recent[i]).trim()
        if (line.length > 0) {
          name = line.slice(0, 70)
          break
        }
      }
    }
    this.recent = []
    if (!name) return null
    return { name, exits }
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

export function isMoveFailure(line: string): boolean {
  return MOVE_FAIL_PATTERNS.test(line)
}

export function isClosedDoorFailure(line: string): boolean {
  return DOOR_FAIL_PATTERNS.test(line)
}
