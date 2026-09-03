export type Encoding = 'utf8' | 'latin1'

export interface Profile {
  id: string
  name: string
  host: string
  port: number
  tls: boolean
  encoding: Encoding
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface ConnectOptions {
  host: string
  port: number
  tls?: boolean
  encoding?: Encoding
  /** Display name for the session tab. */
  name?: string
  /** Links the session to a profile's settings (triggers, aliases, ...). */
  profileId?: string
}

export interface SessionInfo {
  id: string
  name: string
  host: string
  port: number
}

// ---- Automation (Phase 2/3) ----

/**
 * What an action body means: MUD commands to send, or script code.
 * Older settings files without this field default to 'commands'.
 */
export type ActionLanguage = 'commands' | 'js' | 'lua'

export interface TriggerDef {
  id: string
  label: string
  pattern: string
  matchType: 'substring' | 'regex'
  caseInsensitive: boolean
  /** Commands to send when fired; %1..%9 = regex captures, %0 = whole match. */
  commands: string
  language?: ActionLanguage
  /** Hide the matching line from output. */
  gag: boolean
  /** Recolor the matching line (CSS color, '' = off). */
  highlight: string
  /** Copy the matching line into a named capture window ('' = off). */
  captureWindow?: string
  /** Only active while logged in as one of these characters (comma-separated, any case); blank = any. */
  character?: string
  enabled: boolean
}

export interface AliasDef {
  id: string
  /** First word of input to match, e.g. "gh". */
  name: string
  /** Expansion; %1..%9 = argument words, %0 = the whole argument string. */
  commands: string
  language?: ActionLanguage
  /** Only active while logged in as one of these characters (comma-separated, any case); blank = any. */
  character?: string
  enabled: boolean
}

export interface MacroDef {
  id: string
  /** Normalized key signature, e.g. "F5", "Ctrl+Numpad1", "Alt+G". */
  key: string
  commands: string
  language?: ActionLanguage
  /** Only active while logged in as one of these characters (comma-separated, any case); blank = any. */
  character?: string
  enabled: boolean
}

export interface TimerDef {
  id: string
  label: string
  intervalMs: number
  commands: string
  language?: ActionLanguage
  oneShot: boolean
  /** Only active while logged in as one of these characters (comma-separated, any case); blank = any. */
  character?: string
  enabled: boolean
}

export interface GaugeDef {
  id: string
  /** Short label shown on the bar, e.g. "HP". */
  label: string
  /** Variable holding the current value, e.g. "hp". */
  valueVar: string
  /** Variable holding the max ('' = show the raw number without a bar). */
  maxVar: string
  color: string
  /** Only active while logged in as one of these characters (comma-separated, any case); blank = any. */
  character?: string
  enabled: boolean
}

export interface ScriptDef {
  id: string
  name: string
  language: 'js' | 'lua'
  code: string
  /** Only active while logged in as one of these characters (comma-separated, any case); blank = any.
   *  A character-scoped script runs when that character's name is learned, not at connect. */
  character?: string
  /** Enabled scripts run automatically when a session connects. */
  enabled: boolean
}

export interface SettingsOptions {
  /**
   * Check for and install updates. Off keeps you on the version you have --
   * for anyone who has settled on a build and wants it left alone.
   */
  autoUpdate: boolean
  /** Start logging automatically when a session connects. */
  autoLog: boolean
  /** Clear the input line after sending (default: keep it selected). */
  clearInputOnSend: boolean
  /** Show a timestamp in front of each output line. */
  showTimestamps: boolean
  /** Scrollback buffer size in lines (clamped 1,000–1,000,000). */
  scrollbackLines: number
  /** Play MSP sounds (!!SOUND/!!MUSIC) on servers that negotiate them. */
  soundEnabled: boolean
  /**
   * Send multi-line input (a paste) verbatim: no ';' stacking, alias
   * expansion, @variable substitution or trimming, so indentation and
   * punctuation reach the MUD exactly as written. Off = run every line
   * through the normal command pipeline.
   */
  pasteVerbatim: boolean
  /** Delay between the lines of a multi-line send, in ms (0 = all at once). */
  pasteLineDelayMs: number
}

/**
 * How to recognise a room in one MUD's output.
 *
 * The built-in shapes cover the common codebases and should keep growing, but
 * they can never cover everything, and "modify the source and recompile" is not
 * an answer for most people playing a MUD. A rule lives beside triggers and
 * aliases so it travels the same way they do: one person works out their MUD's
 * format, posts it, everyone else pastes it in.
 *
 * Every field is a regular expression as a string. Anything supplied is tried
 * BEFORE the built-ins, so adding a rule can only ever help -- unless builtins
 * is turned off, which is for the rare MUD whose output a built-in actively
 * misreads.
 */
export interface CaptureRule {
  /** Also try the built-in formats. Default true; turn off only when one of
   *  them actively misfires on this MUD. */
  builtins?: boolean
  /** Exits all on one line. Group 1 is the list of directions. */
  exitsLine?: string
  /** Or: a header that opens a block of one line per exit. */
  exitsHeader?: string
  /** A line inside that block. Group 1 is the direction, group 2 (optional)
   *  is the name of the room it leads to. */
  exitsItem?: string
  /** The room title. Group 1 is the name. Omitted, the title is found by
   *  scanning back from the exits past description prose. */
  title?: string
  /** Decorations to strip off a title -- room flags, per-viewer tags. */
  titleStrip?: string[]
  /** Lines never treated as a title or as description. */
  ignore?: string[]
}

export interface SettingsSet {
  triggers: TriggerDef[]
  aliases: AliasDef[]
  macros: MacroDef[]
  timers: TimerDef[]
  scripts: ScriptDef[]
  gauges: GaugeDef[]
  variables: Record<string, string>
  options: SettingsOptions
  /** How this MUD's rooms are recognised; absent means the built-ins alone. */
  capture?: CaptureRule
}

export function defaultSettings(): SettingsSet {
  return {
    triggers: [],
    aliases: [],
    macros: [],
    timers: [],
    scripts: [],
    gauges: [],
    variables: {},
    options: {
      autoUpdate: true,
      autoLog: false,
      clearInputOnSend: false,
      showTimestamps: false,
      scrollbackLines: 100_000,
      soundEnabled: true,
      pasteVerbatim: true,
      pasteLineDelayMs: 0
    }
  }
}

export type { DirectoryMud, DirectorySnapshot, Liveness, ProbeState } from './directory'
import type { DirectoryMud, DirectorySnapshot } from './directory'

export interface DirectoryResult {
  entries: DirectoryMud[]
  /** When this client last fetched the snapshot. */
  fetchedAt: string | null
  /** When CI built it. Null in the biglist fallback, which has no snapshot. */
  builtAt: string | null
  counts: DirectorySnapshot['counts'] | null
  source: 'live' | 'cache' | 'stale-cache' | 'biglist-fallback' | 'unavailable'
  error?: string
}

export type SessionEvent =
  | { type: 'connected' }
  | { type: 'disconnected'; hadError: boolean }
  | { type: 'error'; message: string }
  | { type: 'text'; data: string }
  | { type: 'prompt' }
  | { type: 'echo'; serverEchoes: boolean }
  | { type: 'gmcp'; package: string; data: unknown }
  | { type: 'mssp'; data: Record<string, string> }
  | { type: 'msdp'; data: Record<string, unknown> }
  | { type: 'compression'; enabled: boolean }
  | { type: 'gmcpEnabled' }
  | { type: 'msdpEnabled' }
  | { type: 'mxpEnabled' }
  | { type: 'mspEnabled' }
