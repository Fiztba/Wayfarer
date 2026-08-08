/**
 * AutomationEngine — the per-session heart of triggers, aliases, macros,
 * timers, variables and speedwalking.
 *
 * Input pipeline:  raw input → speedwalk → ';' stacking → alias expansion
 *                  (recursive, depth-capped) → @variable substitution → send
 * Output pipeline: each completed line → trigger matching → gag/highlight
 *                  directives + fired commands (run through the input pipeline)
 *
 * Deliberately DOM-free so it can be exercised headlessly in Node.
 */
import type { SettingsSet, TriggerDef } from '../../../shared/types'

export interface ScriptInvocation {
  matches?: string[]
  line?: string
  gag?: () => void
  highlight?: (color: string) => void
}

export interface EngineHost {
  /** Actually transmit one command to the MUD. */
  transmit(command: string): void
  /** Display an informational line (e.g. commands fired by a trigger). */
  echoTrigger(command: string): void
  /** Display an error line (bad repeat counts, runaway expansions, ...). */
  echoError(message: string): void
  /** Run a JS/Lua action body (Phase 3 scripting). */
  runScript(language: 'js' | 'lua', code: string, ctx: ScriptInvocation): void
  /** Write a variable through to persistent settings (already debounce-safe). */
  persistVariable(name: string, value: string): void
  /** Any variable changed — refresh gauges etc. */
  onVariablesChanged(): void
}

export interface LineDirective {
  gag: boolean
  /** Recolor the whole line with this CSS color, if set. */
  highlight?: string
  /** Capture-window names this line should be copied into. */
  captures?: string[]
}

const MAX_ALIAS_DEPTH = 10
/** Max repetitions for a single #N repeat. */
const MAX_REPEAT = 10_000
/** Max commands transmitted per input/trigger/timer burst (runaway guard). */
const MAX_BURST = 20_000
const DIRECTIONS = ['ne', 'nw', 'se', 'sw', 'n', 's', 'e', 'w', 'u', 'd'] as const

/** Split on ';' but never inside {braces}, so groups travel intact. */
export function splitCommands(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '{') {
      depth++
      current += ch
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1)
      current += ch
    } else if (ch === ';' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

/**
 * Parse "#N rest" / "#N {group}" / "#N@DELAY {group}" repeat syntax.
 * DELAY: "500ms", "2s", "1.5s", "1m", or a bare number (milliseconds).
 * Returns null if the input is not a repeat.
 */
export function parseRepeat(
  input: string
): { count: number; delayMs: number; body: string } | null {
  const m = /^#(\d+)(?:@(\d+(?:\.\d+)?)(ms|s|m)?)?\s*([\s\S]*)$/.exec(input)
  if (!m) return null
  let body = m[4].trim()
  if (body.startsWith('{') && body.endsWith('}')) body = body.slice(1, -1)
  let delayMs = 0
  if (m[2] !== undefined) {
    const value = parseFloat(m[2])
    const unit = m[3] ?? 'ms'
    delayMs = unit === 'm' ? value * 60_000 : unit === 's' ? value * 1000 : value
  }
  return { count: Number(m[1]), delayMs: Math.round(delayMs), body }
}

/** Parse a speedwalk string like ".3n2eu" → ['n','n','n','e','e','u']; null if not one. */
export function parseSpeedwalk(input: string): string[] | null {
  if (!input.startsWith('.') || input.length < 2) return null
  const body = input.slice(1).toLowerCase().replace(/\s+/g, '')
  const steps: string[] = []
  let i = 0
  while (i < body.length) {
    let count = 0
    while (i < body.length && body[i] >= '0' && body[i] <= '9') {
      count = count * 10 + (body.charCodeAt(i) - 48)
      i++
    }
    const dir = DIRECTIONS.find((d) => body.startsWith(d, i))
    if (!dir) return null // not a speedwalk after all (e.g. ".chat hi")
    i += dir.length
    const times = Math.min(count === 0 ? 1 : count, 100)
    for (let k = 0; k < times; k++) steps.push(dir)
  }
  return steps.length > 0 ? steps : null
}

/** Substitute %0..%9 in a template. %0 = all args joined; %1.. = positional. */
export function substituteArgs(template: string, args: string[], all: string): string {
  return template.replace(/%(\d)/g, (_m, d: string) => {
    const n = Number(d)
    if (n === 0) return all
    return args[n - 1] ?? ''
  })
}

/** Substitute @name variables. "@@" escapes a literal "@". */
export function substituteVars(text: string, vars: Record<string, string>): string {
  return text
    .replace(/@@/g, '\x00')
    .replace(/@(\w+)/g, (m, name: string) => (name in vars ? vars[name] : m))
    .replace(/\x00/g, '@')
}

export class AutomationEngine {
  private host: EngineHost
  private getSets: () => SettingsSet[]
  private regexCache = new Map<string, RegExp | null>()
  private timerHandles: ReturnType<typeof setTimeout>[] = []
  private timersRunning = false

  constructor(host: EngineHost, getSets: () => SettingsSet[]) {
    this.host = host
    this.getSets = getSets
  }

  /**
   * Live variable overlay. Fast-changing values (prompt vitals, script state)
   * land here immediately; persistence to the settings file is debounced by
   * the host so a busy prompt can't hammer the disk.
   */
  private runtimeVars: Record<string, string> = {}

  /** Merged variables: global < profile < runtime overlay. */
  get variables(): Record<string, string> {
    const sets = this.getSets()
    const merged: Record<string, string> = {}
    for (let i = sets.length - 1; i >= 0; i--) Object.assign(merged, sets[i].variables)
    Object.assign(merged, this.runtimeVars)
    return merged
  }

  /** Set a variable; persist=false keeps it session-only (live vitals). */
  setVar(name: string, value: string, persist = true): void {
    const clean = name.replace(/\W/g, '')
    if (!clean) return
    if (this.runtimeVars[clean] === value) return
    this.runtimeVars[clean] = value
    if (persist) this.host.persistVariable(clean, value)
    this.host.onVariablesChanged()
  }

  // ---- input pipeline -----------------------------------------------------

  private burstBudget = MAX_BURST
  private burstWarned = false

  private resetBurst(): void {
    this.burstBudget = MAX_BURST
    this.burstWarned = false
  }

  private emit(command: string): void {
    if (this.burstBudget-- <= 0) {
      if (!this.burstWarned) {
        this.burstWarned = true
        this.host.echoError(
          `Expansion stopped after ${MAX_BURST} commands (runaway #repeat or alias loop?).`
        )
      }
      return
    }
    this.host.transmit(command)
  }

  processInput(raw: string): void {
    this.resetBurst()
    this.runCommandString(raw, 0)
  }

  private runCommandString(text: string, depth: number): void {
    if (depth > MAX_ALIAS_DEPTH) {
      this.emit(text)
      return
    }
    const speedwalk = parseSpeedwalk(text.trim())
    if (speedwalk) {
      for (const step of speedwalk) this.emit(step)
      return
    }
    for (const part of splitCommands(text)) {
      this.runSingleCommand(part, depth)
    }
  }

  private runSingleCommand(command: string, depth: number): void {
    const trimmed = command.trim()
    if (trimmed.length === 0) {
      // A bare empty command is still meaningful to MUDs (repeat prompt).
      this.emit('')
      return
    }

    // #var name value — set a variable from plain commands (great in triggers:
    // pattern "^<(\d+)hp (\d+)mv" with commands "#var hp %1;#var mv %2").
    if (/^#var\b/i.test(trimmed)) {
      const m = /^#var\s+(\w+)\s*([\s\S]*)$/i.exec(trimmed)
      if (m) {
        this.setVar(m[1], substituteVars(m[2].trim(), this.variables))
      } else {
        this.host.echoError('Usage: #var <name> <value>')
      }
      return
    }

    // #stop cancels all running paced repeats.
    if (/^#stop$/i.test(trimmed)) {
      const n = this.cancelPacedRepeats()
      this.host.echoTrigger(
        n > 0 ? `stopped ${n} paced repeat${n === 1 ? '' : 's'}` : 'no paced repeats running'
      )
      return
    }

    // #N repeat: "#100 {sneak;hide}", "#5 kill rat", "#100@500ms {sneak;hide}".
    if (trimmed.startsWith('#')) {
      const repeat = parseRepeat(trimmed)
      if (repeat) {
        if (repeat.body.length === 0) return
        if (repeat.count > MAX_REPEAT) {
          this.host.echoError(`#repeat count capped at ${MAX_REPEAT}.`)
        }
        const count = Math.min(repeat.count, MAX_REPEAT)
        if (repeat.delayMs >= 10 && count > 1) {
          this.startPacedRepeat(count, repeat.delayMs, repeat.body, depth)
          return
        }
        for (let i = 0; i < count && this.burstBudget > 0; i++) {
          this.runCommandString(repeat.body, depth + 1)
        }
        return
      }
    }

    // {group}: braces protect ';' from the splitter; unwrap and recurse.
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      this.runCommandString(trimmed.slice(1, -1), depth + 1)
      return
    }

    const spaceIdx = trimmed.indexOf(' ')
    const word = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
    const argString = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1)

    for (const set of this.getSets()) {
      const alias = set.aliases.find((a) => a.enabled && a.name === word)
      if (alias) {
        const args = argString.length > 0 ? argString.split(/\s+/) : []
        const lang = alias.language ?? 'commands'
        if (lang !== 'commands') {
          this.host.runScript(lang, alias.commands, {
            matches: [argString, ...args],
            line: trimmed
          })
          return
        }
        const expanded = substituteArgs(alias.commands, args, argString)
        this.runCommandString(expanded, depth + 1)
        return
      }
    }
    this.emit(substituteVars(trimmed, this.variables))
  }

  // ---- output pipeline ----------------------------------------------------

  /** Run triggers against a completed output line. */
  processLine(plainText: string): LineDirective {
    this.resetBurst()
    const directive: LineDirective = { gag: false }
    for (const set of this.getSets()) {
      for (const trigger of set.triggers) {
        if (!trigger.enabled || trigger.pattern.length === 0) continue
        const captures = this.matchTrigger(trigger, plainText)
        if (!captures) continue
        if (trigger.gag) directive.gag = true
        if (trigger.highlight) directive.highlight = trigger.highlight
        if (trigger.captureWindow && trigger.captureWindow.trim()) {
          directive.captures ??= []
          const name = trigger.captureWindow.trim()
          if (!directive.captures.includes(name)) directive.captures.push(name)
        }
        if (trigger.commands.trim().length > 0) {
          const lang = trigger.language ?? 'commands'
          if (lang !== 'commands') {
            this.host.runScript(lang, trigger.commands, {
              matches: captures,
              line: plainText,
              gag: () => {
                directive.gag = true
              },
              highlight: (color: string) => {
                directive.highlight = color
              }
            })
          } else {
            const commands = substituteArgs(trigger.commands, captures.slice(1), captures[0])
            this.host.echoTrigger(commands)
            this.runCommandString(commands, 1)
          }
        }
      }
    }
    return directive
  }

  /** Returns [wholeMatch, ...captures] or null. */
  private matchTrigger(trigger: TriggerDef, line: string): string[] | null {
    if (trigger.matchType === 'substring') {
      const haystack = trigger.caseInsensitive ? line.toLowerCase() : line
      const needle = trigger.caseInsensitive ? trigger.pattern.toLowerCase() : trigger.pattern
      return haystack.includes(needle) ? [trigger.pattern] : null
    }
    const cacheKey = `${trigger.caseInsensitive ? 'i' : ''}:${trigger.pattern}`
    let re = this.regexCache.get(cacheKey)
    if (re === undefined) {
      try {
        re = new RegExp(trigger.pattern, trigger.caseInsensitive ? 'i' : '')
      } catch {
        re = null // invalid pattern: never matches
      }
      this.regexCache.set(cacheKey, re)
    }
    if (!re) return null
    const m = re.exec(line)
    return m ? [...m] : null
  }

  clearRegexCache(): void {
    this.regexCache.clear()
  }

  // ---- paced repeats ------------------------------------------------------

  private pacedHandles = new Set<ReturnType<typeof setInterval>>()

  private startPacedRepeat(count: number, delayMs: number, body: string, depth: number): void {
    const delayLabel = delayMs % 1000 === 0 ? `${delayMs / 1000}s` : `${delayMs}ms`
    this.host.echoTrigger(`repeating ×${count} every ${delayLabel} — type #stop to cancel`)
    let remaining = count
    let handle: ReturnType<typeof setInterval> | null = null
    const tick = () => {
      this.resetBurst()
      this.runCommandString(body, depth + 1)
      remaining--
      if (remaining <= 0 && handle !== null) {
        clearInterval(handle)
        this.pacedHandles.delete(handle)
        this.host.echoTrigger('paced repeat finished')
      }
    }
    tick() // first iteration fires immediately
    if (remaining <= 0) return
    handle = setInterval(tick, delayMs)
    this.pacedHandles.add(handle)
  }

  /** Cancel all running paced repeats; returns how many were cancelled. */
  cancelPacedRepeats(): number {
    const n = this.pacedHandles.size
    for (const h of this.pacedHandles) clearInterval(h)
    this.pacedHandles.clear()
    return n
  }

  // ---- macros -------------------------------------------------------------

  /** Try to handle a key signature; returns true if a macro fired. */
  runMacro(signature: string): boolean {
    for (const set of this.getSets()) {
      const macro = set.macros.find((m) => m.enabled && m.key === signature)
      if (macro) {
        this.resetBurst()
        const lang = macro.language ?? 'commands'
        if (lang !== 'commands') this.host.runScript(lang, macro.commands, {})
        else this.runCommandString(macro.commands, 1)
        return true
      }
    }
    return false
  }

  // ---- timers -------------------------------------------------------------

  startTimers(): void {
    this.stopTimers()
    this.timersRunning = true
    for (const set of this.getSets()) {
      for (const timer of set.timers) {
        if (!timer.enabled || timer.intervalMs < 100) continue
        const lang = timer.language ?? 'commands'
        const run =
          lang !== 'commands'
            ? () => this.host.runScript(lang, timer.commands, {})
            : () => {
                this.resetBurst()
                this.runCommandString(timer.commands, 1)
              }
        const handle = timer.oneShot
          ? setTimeout(run, timer.intervalMs)
          : setInterval(run, timer.intervalMs)
        this.timerHandles.push(handle)
      }
    }
  }

  stopTimers(): void {
    for (const h of this.timerHandles) {
      clearTimeout(h)
      clearInterval(h)
    }
    this.timerHandles = []
    this.timersRunning = false
  }

  /** Re-arm timers after settings change, but only if they were running. */
  refreshTimers(): void {
    if (this.timersRunning) this.startTimers()
    this.clearRegexCache()
  }
}

/** Normalize a KeyboardEvent into a macro signature, or null if unusable. */
export function keyEventSignature(e: {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}): string | null {
  const key = e.key
  if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return null

  let base: string | null = null
  if (/^F\d{1,2}$/.test(key)) base = key
  else if (e.code.startsWith('Numpad')) base = e.code
  else if (key.length === 1) {
    // Plain printable keys are only usable with Ctrl or Alt held.
    if (!e.ctrlKey && !e.altKey) return null
    base = key.length === 1 ? key.toUpperCase() : key
  } else if (['Escape', 'Tab', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete'].includes(key)) {
    // Bare special keys are allowed only with a modifier so we don't
    // steal normal editing behavior.
    if (!e.ctrlKey && !e.altKey) return null
    base = key
  }
  if (!base) return null

  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(base)
  return parts.join('+')
}
