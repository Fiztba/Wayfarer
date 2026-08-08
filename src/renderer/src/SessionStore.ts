/**
 * SessionStore — per-session state kept outside React so no server output is
 * ever lost, even if it arrives before the view mounts. Views subscribe via
 * useSyncExternalStore.
 *
 * Owns this session's AutomationEngine: outgoing input runs through aliases /
 * speedwalk / variables, and every completed output line runs through
 * triggers (gag, highlight, fired commands) before display.
 */
import { AnsiParser, type Span } from './ansi'
import { parseMspLine, playBeep, SoundPlayer } from './sound'
import { AutomationEngine, parseSpeedwalk } from './automation/AutomationEngine'
import { ScriptRuntime } from './scripting/ScriptRuntime'
import { settingsManager } from './SettingsManager'
import { uiState } from './uiState'
import { MapModel } from './map/MapModel.ts'
import { MapTracker } from './map/MapTracker.ts'
import { MODEL_ACTION_METHODS } from './map/RemoteMap.ts'
import { Walker } from './map/Walker.ts'
import { exitOpenCommand, findPath, type WalkStep } from './map/Pathfinder.ts'
import {
  DIR_FULL,
  wordToDirection,
  type Direction,
  type MudMap,
  type ServerRoomInfo
} from './map/types.ts'
import type { ScriptDef, SessionEvent } from '../../shared/types'
import luaWasmUrl from 'wasmoon/dist/glue.wasm?url'

export interface Line {
  id: number
  spans: Span[]
  kind: 'output' | 'input' | 'system' | 'error' | 'trigger'
  /** Wall-clock time the line was added (for optional timestamps). */
  at: number
}

const MAX_HISTORY = 200

function scrollbackCap(): number {
  const raw = settingsManager.globalOptions.scrollbackLines
  return Math.min(1_000_000, Math.max(1000, raw || 100_000))
}

export type SessionStatus = 'connecting' | 'connected' | 'disconnected'

export class SessionStore {
  readonly id: string
  name: string
  host: string
  port: number
  profileId: string | null

  lines: Line[] = []
  /** Spans of the current unfinished line (usually the prompt). */
  openSpans: Span[] = []
  version = 0

  status: SessionStatus = 'connecting'
  serverEchoes = false // true → mask input (passwords)
  mccp = false
  gmcp = false
  mxp = false
  msp = false
  lastMssp: Record<string, string> | null = null
  readonly sounds = new SoundPlayer()

  logging = false
  logPath: string | null = null

  /** Named capture windows (tells, channels, ...) fed by triggers. */
  captureWindows = new Map<string, Line[]>()
  showCaptures = true

  history: string[] = []

  readonly engine: AutomationEngine
  readonly scripts: ScriptRuntime

  // Mapper (hydrated asynchronously; null until the map file loads).
  mapModel: MapModel | null = null
  tracker: MapTracker | null = null
  walker: Walker | null = null
  showMap = false
  private mapKey: string

  private parser = new AnsiParser()
  private nextLineId = 1
  private subs = new Set<() => void>()
  private flushScheduled = false

  constructor(id: string, name: string, host: string, port: number, profileId?: string) {
    this.id = id
    this.name = name
    this.host = host
    this.port = port
    this.profileId = profileId ?? null
    this.scripts = new ScriptRuntime(
      {
        send: (text) => this.engine.processInput(text),
        sendRaw: (text) => window.mud.send(this.id, text),
        echo: (text) => this.addScriptEcho(text),
        echoError: (text) => this.addSystemLine(text, 'error'),
        getVar: (name) => this.engine.variables[name],
        setVar: (name, value) => this.setVariable(name, value),
        beep: (times) => playBeep(times),
        session: () => ({
          name: this.name,
          host: this.host,
          port: this.port,
          connected: this.status === 'connected'
        })
      },
      luaWasmUrl
    )
    this.engine = new AutomationEngine(
      {
        transmit: (command) => this.transmitRaw(command),
        echoTrigger: (command) => this.addTriggerEcho(command),
        echoError: (message) => this.addSystemLine(message, 'error'),
        runScript: (language, code, ctx) => this.scripts.run(language, code, ctx),
        persistVariable: (name, value) => this.queueVariablePersist(name, value),
        onVariablesChanged: () => this.notify()
      },
      () => settingsManager.getSets(this.profileId)
    )
    void settingsManager.ensure(this.profileId)
    this.mapKey = this.profileId ?? `adhoc_${host}_${port}`
    void this.initMap()
    // MXP <VERSION>/<SUPPORT> replies go straight to the wire (not the
    // command pipeline — they are protocol, not player input).
    this.parser.onMxpReply = (text) => window.mud.send(this.id, text)
  }

  /** All outgoing traffic funnels through here so the mapper sees it. */
  private transmitRaw(command: string): void {
    window.mud.send(this.id, command)
    this.tracker?.onCommand(command)
  }

  // ---- mapper -------------------------------------------------------------

  private async initMap(): Promise<void> {
    // One MapModel per map key, shared across sessions: two tabs on the same
    // world edit the same live map instead of clobbering each other's saves.
    let modelPromise = mapModelRegistry.get(this.mapKey)
    if (!modelPromise) {
      modelPromise = (async () => {
        const raw = (await window.mud.map.load(this.mapKey)) as MudMap | null
        return new MapModel(raw, (map) => window.mud.map.save(this.mapKey, map))
      })()
      mapModelRegistry.set(this.mapKey, modelPromise)
    }
    const model = await modelPromise
    const tracker = new MapTracker(model, {
      info: (text) => this.addSystemLine(text, 'system'),
      onMoveFailed: (dir, closedDoor) => this.handleMoveFailed(dir, closedDoor)
    })
    this.walker = new Walker(tracker, {
      transmit: (command) => this.transmitRaw(command),
      info: (text) => this.addSystemLine(text, 'system'),
      error: (text) => this.addSystemLine(text, 'error')
    })
    this.mapModel = model
    this.tracker = tracker
    if (tracker.currentRoom) {
      this.addSystemLine(
        `Mapper: resuming at "${tracker.currentRoom.name}" — your first room description re-verifies this.`,
        'system'
      )
    }
    const push = () => this.pushMirrorState()
    model.subscribe(push)
    tracker.subscribe(push)
    this.notify()
  }

  toggleMap(): void {
    this.showMap = !this.showMap
    this.notify()
  }

  /**
   * A movement bounced. Closed door (even a hidden one the map doesn't show):
   * open it and retry the move once. Anything else — or a door that stays
   * shut — halts any active walk with the reason.
   */
  private lastAutoOpen: { dir: Direction; at: number } | null = null

  private handleMoveFailed(dir: Direction, closedDoor: boolean): void {
    if (!closedDoor) {
      this.walker?.notifyStepFailed(`the way ${DIR_FULL[dir]} is blocked`)
      return
    }
    const now = Date.now()
    if (this.lastAutoOpen && this.lastAutoOpen.dir === dir && now - this.lastAutoOpen.at < 4000) {
      // We already tried once — probably locked.
      this.lastAutoOpen = null
      this.addSystemLine(`Auto-open ${DIR_FULL[dir]} didn't work — the door may be locked.`, 'error')
      this.walker?.notifyStepFailed(`the door ${DIR_FULL[dir]} won't open`)
      return
    }
    this.lastAutoOpen = { dir, at: now }
    const room = this.tracker?.currentRoom
    const exit = room && this.mapModel ? this.mapModel.exitOf(room, dir) : undefined
    const doorName = exit?.doorName?.trim() || 'door'
    this.addSystemLine(`Blocked by a door ${DIR_FULL[dir]} — opening it and retrying.`, 'system')
    this.transmitRaw(`open ${doorName} ${DIR_FULL[dir]}`)
    this.transmitRaw(dir)
  }

  /** Speedwalk steps with map knowledge where it exists (doors pre-opened,
   *  arrivals confirmed) and open expectations where it doesn't. */
  private buildSpeedwalkSteps(dirs: Direction[]): WalkStep[] {
    const steps: WalkStep[] = []
    let room = this.tracker?.currentRoom ?? null
    for (const dir of dirs) {
      const exit = room && this.mapModel ? this.mapModel.exitOf(room, dir) : undefined
      steps.push({
        command: dir,
        openCommand: exit?.door ? exitOpenCommand(exit) : undefined,
        toRoomId: exit?.to ?? null
      })
      room = exit?.to && this.mapModel ? this.mapModel.room(exit.to) : null
    }
    return steps
  }

  /** Pathfind + walk to a room; reports problems as session lines. */
  walkTo(roomId: string, fast = false): void {
    if (!this.mapModel || !this.tracker || !this.walker) return
    if (!this.tracker.currentRoomId || this.tracker.lost) {
      this.addSystemLine('Cannot walk: the mapper does not know where you are (#lost to fix).', 'error')
      return
    }
    const path = findPath(this.mapModel, this.tracker.currentRoomId, roomId)
    if (path === null) {
      this.addSystemLine('No known path to there.', 'error')
      return
    }
    const dest = this.mapModel.room(roomId)
    this.walker.start(path, dest?.name ?? 'destination', fast)
  }

  // ---- mirror to pop-out windows ------------------------------------------

  private mirrorTimer: ReturnType<typeof setTimeout> | null = null

  private pushMirrorState(): void {
    if (this.mirrorTimer) return
    this.mirrorTimer = setTimeout(() => {
      this.mirrorTimer = null
      if (!this.mapModel || !this.tracker) return
      window.mud.map.pushState(this.id, {
        map: this.mapModel.map,
        activeZoneId: this.mapModel.activeZoneId,
        currentRoomId: this.tracker.currentRoomId,
        lost: this.tracker.lost,
        mode: this.tracker.mode,
        name: this.name
      })
    }, 200)
  }

  mirrorHello(): void {
    this.pushMirrorState()
  }

  applyMapAction(action: unknown): void {
    const a = action as {
      type?: string
      method?: string
      args?: unknown[]
      roomId?: string
      fast?: boolean
    }
    if (a.type === 'walkTo' && a.roomId) {
      this.walkTo(a.roomId, a.fast ?? false)
      return
    }
    if (!this.mapModel || !this.tracker) return
    if (a.type === 'tracker' && (a.method === 'setMode' || a.method === 'setCurrentRoom')) {
      const fn = this.tracker[a.method] as (...args: unknown[]) => void
      fn.apply(this.tracker, a.args ?? [])
      return
    }
    if (a.type === 'model' && a.method && MODEL_ACTION_METHODS.has(a.method)) {
      const target = this.mapModel as unknown as Record<string, (...args: unknown[]) => void>
      const fn = target[a.method]
      if (typeof fn === 'function') fn.apply(this.mapModel, a.args ?? [])
    }
  }

  // ---- mapper commands (#map, #go, #wp, #zone, #lost) ---------------------

  /** Returns true if the input was a mapper command (consumed). */
  private tryMapperCommand(raw: string): boolean {
    const m = /^#(map|go!?|wp|waypoint|zone|lost)(?:\s+(.*))?$/i.exec(raw.trim())
    if (!m) return false
    const verb = m[1].toLowerCase()
    const arg = (m[2] ?? '').trim()

    if (verb === 'map') {
      this.toggleMap()
      return true
    }
    if (!this.mapModel || !this.tracker) {
      this.addSystemLine('Map still loading — try again in a moment.', 'error')
      return true
    }
    if (verb === 'lost') {
      this.tracker.setCurrentRoom(null)
      this.showMap = true
      this.addSystemLine(
        'Position cleared. Right-click your room on the map → "I am here" (or walk somewhere with a unique name).',
        'system'
      )
      this.notify()
      return true
    }
    if (verb === 'go' || verb === 'go!') {
      if (!arg) {
        this.addSystemLine('Usage: #go <waypoint>   (#go! = fast walk). #wp list shows waypoints.', 'system')
        return true
      }
      const room = this.mapModel.waypoint(arg)
      if (!room) {
        this.addSystemLine(`No waypoint named "${arg}". #wp list shows them.`, 'error')
        return true
      }
      this.walkTo(room.id, verb === 'go!')
      return true
    }
    if (verb === 'wp' || verb === 'waypoint') {
      const sub = /^(add|del|delete|remove|list)?\s*(.*)$/i.exec(arg)
      const op = (sub?.[1] ?? 'list').toLowerCase()
      const name = (sub?.[2] ?? '').trim()
      if (op === 'add') {
        if (!name) this.addSystemLine('Usage: #wp add <name> — names the room you are in.', 'system')
        else if (!this.tracker.currentRoomId || this.tracker.lost)
          this.addSystemLine('Cannot add waypoint: position unknown.', 'error')
        else {
          this.mapModel.setWaypoint(name, this.tracker.currentRoomId)
          this.addSystemLine(`Waypoint "${name}" set here. Walk back anytime with #go ${name}.`, 'system')
        }
      } else if (op === 'del' || op === 'delete' || op === 'remove') {
        if (this.mapModel.removeWaypoint(name)) this.addSystemLine(`Waypoint "${name}" removed.`, 'system')
        else this.addSystemLine(`No waypoint named "${name}".`, 'error')
      } else {
        const list = this.mapModel.map.waypoints
        this.addSystemLine(
          list.length === 0
            ? 'No waypoints yet. #wp add <name> creates one where you stand.'
            : 'Waypoints: ' + list.map((w) => w.name).join(', '),
          'system'
        )
      }
      return true
    }
    if (verb === 'zone') {
      if (!arg || arg.toLowerCase() === 'list') {
        const names = this.mapModel.map.zones
          .map((z) => (z.id === this.mapModel!.activeZoneId ? `[${z.name}]` : z.name))
          .join(', ')
        this.addSystemLine(`Zones: ${names}  ·  #zone <name> switches/creates.`, 'system')
      } else {
        const id = this.mapModel.createZone(arg)
        this.mapModel.setActiveZone(id)
        this.mapModel.setPendingZone(id)
        this.addSystemLine(
          `Zone armed: ${arg}. The next room you map starts it; rooms after that inherit their neighbor's zone.`,
          'system'
        )
      }
      return true
    }
    return false
  }

  /** Runtime set + debounced persistence (fast-path used by scripts too). */
  setVariable(name: string, value: string): void {
    this.engine.setVar(name, value)
  }

  private pendingVars = new Map<string, string>()
  private varPersistTimer: ReturnType<typeof setTimeout> | null = null

  /** Batch variable writes so prompt-driven updates don't hammer the disk. */
  private queueVariablePersist(name: string, value: string): void {
    this.pendingVars.set(name, value)
    this.varPersistTimer ??= setTimeout(() => {
      this.varPersistTimer = null
      const batch = Object.fromEntries(this.pendingVars)
      this.pendingVars.clear()
      const scope = this.profileId
      const set = settingsManager.getScope(scope)
      void settingsManager.save(scope, {
        ...set,
        variables: { ...set.variables, ...batch }
      })
    }, 3000)
  }

  /** Run one script immediately (used by the settings panel's Run button). */
  runScriptNow(script: ScriptDef): void {
    this.addSystemLine(`Running script "${script.name}"…`, 'system')
    this.scripts.run(script.language, script.code, {})
  }

  private runStartupScripts(): void {
    for (const set of settingsManager.getSets(this.profileId)) {
      for (const script of set.scripts) {
        if (script.enabled) this.scripts.run(script.language, script.code, {})
      }
    }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  getVersion = (): number => this.version

  private notify(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    requestAnimationFrame(() => {
      this.flushScheduled = false
      this.version++
      for (const fn of this.subs) fn()
    })
  }

  handleEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'connected':
        this.status = 'connected'
        this.addSystemLine(`Connected to ${this.host}:${this.port}`, 'system')
        this.engine.startTimers()
        this.runStartupScripts()
        if (this.mergedAutoLog() && !this.logging) void this.toggleLogging()
        break
      case 'disconnected':
        this.status = 'disconnected'
        this.engine.stopTimers()
        this.engine.cancelPacedRepeats()
        this.walker?.cancel(false)
        this.sounds.stopAll()
        this.closeOpenLine()
        this.addSystemLine(
          event.hadError ? 'Connection lost.' : 'Disconnected.',
          event.hadError ? 'error' : 'system'
        )
        if (this.logging) void this.toggleLogging()
        break
      case 'error':
        this.addSystemLine(event.message, 'error')
        break
      case 'text':
        this.appendOutput(event.data)
        break
      case 'prompt':
        // GA/EOR marks end-of-prompt; leave openSpans as the visible prompt.
        this.notify()
        break
      case 'echo':
        this.serverEchoes = event.serverEchoes
        this.notify()
        break
      case 'compression':
        this.mccp = event.enabled
        this.notify()
        break
      case 'gmcpEnabled':
        this.gmcp = true
        this.notify()
        break
      case 'mxpEnabled':
        this.mxp = true
        this.parser.mxpEnabled = true
        this.notify()
        break
      case 'mspEnabled':
        this.msp = true
        this.notify()
        break
      case 'mssp':
        this.lastMssp = event.data
        this.notify()
        break
      case 'gmcp':
        this.handleGmcpForMap(event.package, event.data)
        this.handleGmcpVitals(event.package, event.data)
        break
      case 'msdp':
        this.handleMsdpForMap(event.data)
        this.handleMsdpVitals(event.data)
        break
    }
  }

  private mergedAutoLog(): boolean {
    return settingsManager.getSets(this.profileId).some((s) => s.options.autoLog)
  }

  /** GMCP Char.Vitals / Char.Status → live variables (session-only). */
  private handleGmcpVitals(pkg: string, data: unknown): void {
    if (!/^char\.(vitals|status)$/i.test(pkg)) return
    if (typeof data !== 'object' || data === null) return
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number') {
        this.engine.setVar(key.toLowerCase(), String(value), false)
      }
    }
  }

  /** MSDP scalar reports (HEALTH, MANA, ...) → live variables (session-only). */
  private handleMsdpVitals(data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
      if (key === 'ROOM') continue
      if (typeof value === 'string' || typeof value === 'number') {
        this.engine.setVar(key.toLowerCase(), String(value), false)
      }
    }
  }

  /** GMCP Room.Info → authoritative tracker input. */
  private handleGmcpForMap(pkg: string, data: unknown): void {
    if (!/^room\.info$/i.test(pkg) || typeof data !== 'object' || data === null) return
    const d = data as Record<string, unknown>
    const num = d.num ?? d.number ?? d.id
    if (num === undefined || num === null) return
    const exits: ServerRoomInfo['exits'] = {}
    if (typeof d.exits === 'object' && d.exits !== null) {
      for (const [k, v] of Object.entries(d.exits as Record<string, unknown>)) {
        const dir = wordToDirection(k)
        if (dir) exits[dir] = v === null || v === undefined ? null : `gmcp:${v}`
      }
    }
    this.tracker?.onServerRoom({
      serverId: `gmcp:${num}`,
      name: typeof d.name === 'string' ? d.name : undefined,
      areaName: typeof d.area === 'string' ? d.area : undefined,
      exits
    })
  }

  /** MSDP ROOM report (tbaMUD-style) → authoritative tracker input. */
  private handleMsdpForMap(data: Record<string, unknown>): void {
    const room = data.ROOM
    if (typeof room !== 'object' || room === null) return
    const r = room as Record<string, unknown>
    const vnum = r.VNUM ?? r.vnum
    if (vnum === undefined || vnum === null || vnum === '') return
    const exits: ServerRoomInfo['exits'] = {}
    const rawExits = r.EXITS ?? r.exits
    if (typeof rawExits === 'object' && rawExits !== null) {
      for (const [k, v] of Object.entries(rawExits as Record<string, unknown>)) {
        const dir = wordToDirection(k)
        if (dir) exits[dir] = v === null || v === undefined || v === '' ? null : `vnum:${v}`
      }
    }
    this.tracker?.onServerRoom({
      serverId: `vnum:${vnum}`,
      name: typeof r.NAME === 'string' ? r.NAME : undefined,
      areaName: typeof r.AREA === 'string' ? r.AREA : undefined,
      exits
    })
  }

  // ---- input --------------------------------------------------------------

  /** Re-dial the same host in the same tab: scrollback, map, and settings stay. */
  reconnect(): void {
    if (this.status !== 'disconnected') {
      this.addSystemLine('Already connected.', 'system')
      return
    }
    this.status = 'connecting'
    this.serverEchoes = false
    this.mccp = false
    this.gmcp = false
    this.mxp = false
    this.msp = false
    // Fresh protocol state: the new connection renegotiates everything.
    this.parser = new AnsiParser()
    this.parser.onMxpReply = (text) => window.mud.send(this.id, text)
    this.addSystemLine(`Reconnecting to ${this.host}:${this.port}…`, 'system')
    void window.mud.reconnect(this.id)
    this.notify()
  }

  /** Send user input through the automation pipeline (or raw when masked). */
  sendInput(raw: string, masked: boolean): void {
    if (masked) {
      window.mud.send(this.id, raw)
      return
    }
    if (/^#help$/i.test(raw.trim())) {
      uiState.openHelp?.()
      return
    }
    if (/^#rec(onnect)?$/i.test(raw.trim())) {
      this.reconnect()
      return
    }
    if (this.tryMapperCommand(raw)) return
    if (this.status === 'disconnected') {
      if (raw.trim() === '') {
        this.reconnect()
      } else {
        this.addSystemLine(
          'Not connected — press Enter on an empty line (or 🔌 Reconnect) to reconnect.',
          'error'
        )
      }
      return
    }
    // Dot-speedwalks run as CONFIRMED walks when the mapper knows where we
    // are: each step waits for arrival, hidden doors get auto-opened, and a
    // real blockage halts instead of desyncing the rest of the route.
    const speedwalk = parseSpeedwalk(raw.trim())
    if (
      speedwalk &&
      this.walker &&
      this.mapModel &&
      this.tracker &&
      this.tracker.currentRoomId &&
      !this.tracker.lost &&
      this.tracker.mode !== 'off'
    ) {
      this.echoInput(raw)
      this.walker.start(
        this.buildSpeedwalkSteps(speedwalk as Direction[]),
        `the end of ${raw.trim()}`,
        false
      )
      return
    }
    if (/^#stop$/i.test(raw.trim()) && this.walker?.walking) {
      this.walker.cancel()
      // fall through: engine also cancels paced repeats
    }
    this.echoInput(raw)
    this.engine.processInput(raw)
  }

  // ---- output -------------------------------------------------------------

  private appendOutput(data: string): void {
    for (const token of this.parser.parse(data)) {
      if (token.kind === 'newline') {
        this.completeLine()
      } else {
        this.openSpans.push(token.span)
      }
    }
    this.notify()
  }

  private completeLine(): void {
    let spans = this.openSpans
    this.openSpans = []
    const plain = spans.map((s) => s.text).join('')
    // MSP sound triggers are protocol, not prose: play and swallow.
    if (this.msp) {
      const msp = parseMspLine(plain)
      if (msp) {
        if (settingsManager.globalOptions.soundEnabled) this.sounds.play(msp)
        return
      }
    }
    this.tracker?.onLine(plain)
    const directive = this.engine.processLine(plain)
    if (this.logging) window.mud.log.line(this.id, plain)
    if (directive.highlight) {
      const color = directive.highlight
      spans = spans.map((s) => ({ text: s.text, style: { ...s.style, color } }))
    }
    if (directive.captures) {
      for (const windowName of directive.captures) {
        let buffer = this.captureWindows.get(windowName)
        if (!buffer) {
          buffer = []
          this.captureWindows.set(windowName, buffer)
        }
        buffer.push({ id: this.nextLineId++, spans, kind: 'output', at: Date.now() })
        if (buffer.length > 2000) buffer.splice(0, buffer.length - 2000)
      }
    }
    if (directive.gag) return
    this.pushLine({ id: this.nextLineId++, spans, kind: 'output' })
  }

  clearCaptureWindow(name: string): void {
    this.captureWindows.delete(name)
    this.notify()
  }

  toggleCaptures(): void {
    this.showCaptures = !this.showCaptures
    this.notify()
  }

  /** Echo a command the user typed. Appends to the open prompt line, cMUD-style. */
  echoInput(text: string): void {
    const spans = [...this.openSpans, { text, style: { color: '#ffd68a' } }]
    this.pushLine({ id: this.nextLineId++, spans, kind: 'input' })
    this.openSpans = []
    if (this.logging) window.mud.log.line(this.id, spans.map((s) => s.text).join(''))
    this.notify()
  }

  private addTriggerEcho(command: string): void {
    this.pushLine({
      id: this.nextLineId++,
      spans: [{ text: `» ${command}`, style: { color: '#8b949e', italic: true } }],
      kind: 'trigger'
    })
    this.notify()
  }

  private addScriptEcho(text: string): void {
    this.pushLine({
      id: this.nextLineId++,
      spans: [{ text, style: { color: '#c678dd' } }],
      kind: 'trigger'
    })
    if (this.logging) window.mud.log.line(this.id, text)
    this.notify()
  }

  addSystemLine(text: string, kind: 'system' | 'error'): void {
    const color = kind === 'error' ? '#ff7b86' : '#56b6c2'
    this.pushLine({
      id: this.nextLineId++,
      spans: [{ text: `— ${text} —`, style: { color, italic: true } }],
      kind
    })
    if (this.logging) window.mud.log.line(this.id, `--- ${text} ---`)
    this.notify()
  }

  private closeOpenLine(): void {
    if (this.openSpans.length > 0) {
      this.completeLine()
    }
  }

  private pushLine(line: Omit<Line, 'at'>): void {
    this.lines.push({ ...line, at: Date.now() })
    // Trim in chunks (not per line) so a full buffer doesn't shift the whole
    // array on every arrival.
    const cap = scrollbackCap()
    if (this.lines.length > cap + 500) {
      this.lines.splice(0, this.lines.length - cap)
    }
  }

  pushHistory(command: string): void {
    if (command && this.history[this.history.length - 1] !== command) {
      this.history.push(command)
      if (this.history.length > MAX_HISTORY) this.history.shift()
    }
  }

  // ---- logging ------------------------------------------------------------

  async toggleLogging(): Promise<void> {
    if (this.logging) {
      this.logging = false
      await window.mud.log.stop(this.id)
      this.addSystemLine('Logging stopped.', 'system')
      this.logPath = null
    } else {
      const file = await window.mud.log.start(this.id, this.name)
      this.logging = true
      this.logPath = file
      this.addSystemLine(`Logging to ${file}`, 'system')
    }
    this.notify()
  }

  dispose(): void {
    this.engine.stopTimers()
    this.engine.cancelPacedRepeats()
    this.walker?.cancel(false)
    this.sounds.stopAll()
    this.mapModel?.flush()
    this.scripts.dispose()
    if (this.logging) void window.mud.log.stop(this.id)
  }
}

/** Registry of live sessions; App routes IPC events here. */
export const sessionStores = new Map<string, SessionStore>()

/** One shared MapModel per map key (kept across reconnects and tab closes). */
const mapModelRegistry = new Map<string, Promise<MapModel>>()
