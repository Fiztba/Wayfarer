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
import { AutomationEngine, parseSpeedwalk, splitPastedBlock } from './automation/AutomationEngine'
import { ScriptRuntime } from './scripting/ScriptRuntime'
import { settingsManager } from './SettingsManager'
import { uiState } from './uiState'
import { LoginGuesser } from './LoginGuesser'
import { characterList, forCharacter } from './automation/scope.ts'
import { MapModel } from './map/MapModel.ts'
import { MapTracker } from './map/MapTracker.ts'
import { MODEL_ACTION_METHODS } from './map/RemoteMap.ts'
import { gmcpRoomInfo } from './map/protocol.ts'
import { Walker } from './map/Walker.ts'
import { exitOpenCommand, findPath, type WalkStep } from './map/Pathfinder.ts'
import {
  DIR_FULL,
  wordToDirection,
  type Direction,
  type MapRoom,
  type MudMap,
  type PopoutBounds,
  type ServerRoomInfo
} from './map/types.ts'
import type { ScriptDef, SessionEvent } from '../../shared/types'
import type { AgentLine, AgentSendResult, AgentSessionInfo } from '../../shared/agent'
import luaWasmUrl from 'wasmoon/dist/glue.wasm?url'
import { saveFields, restoreFields } from '../../shared/copyover'
const SESSION_STATE = ['name', 'host', 'port', 'profileId', 'charName', 'charNameFromGmcp',
  'lines', 'openSpans', 'promptDone', 'status', 'serverEchoes', 'mccp', 'gmcp', 'msdp', 'mxp', 'msp',
  'lastMssp', 'msdpRoom', 'showCaptures', 'history', 'showMap', 'nextLineId', 'automationReady', 'draft']

export interface Line {
  character?: string | null
  id: number
  spans: Span[]
  kind: 'output' | 'input' | 'system' | 'error' | 'trigger'
  /** Wall-clock time the line was added (for optional timestamps). */
  at: number
}

const MAX_HISTORY = 200
/** Ask before sending a paste larger than this — a mis-paste can be huge. */
const PASTE_CONFIRM_LINES = 200
/** Ceiling on an unterminated line before it is forced closed. */
const MAX_OPEN_SPANS = 256
const MAX_OPEN_CHARS = 8192
/**
 * How a partial line must end to count as a prompt when all the server gave
 * was a pause after it (no GA/EOR): with the marker prompts close on. A pause
 * after prose ("Saving....") is a slow server, and the line is left whole.
 */
const PROMPT_END = /[>\]):?]\s*$/

function scrollbackCap(): number {
  const raw = settingsManager.globalOptions.scrollbackLines
  return Math.min(1_000_000, Math.max(1000, raw || 100_000))
}

/**
 * MSDP exits: a table of direction → destination vnum, or — on MUDs that
 * report it flat — a plain list of the directions that are open.
 */
function msdpExits(raw: unknown): ServerRoomInfo['exits'] | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined
  const exits: NonNullable<ServerRoomInfo['exits']> = {}
  if (Array.isArray(raw)) {
    for (const value of raw) {
      const dir = typeof value === 'string' ? wordToDirection(value) : null
      if (dir) exits[dir] = null
    }
    return exits
  }
  if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const dir = wordToDirection(k)
      if (dir) exits[dir] = v === null || v === undefined || v === '' ? null : `vnum:${v}`
    }
    return exits
  }
  if (typeof raw === 'string') {
    for (const token of raw.split(/[,\s|]+/)) {
      const dir = wordToDirection(token)
      if (dir) exits[dir] = null
    }
    return exits
  }
  return undefined
}

export type SessionStatus = 'connecting' | 'connected' | 'disconnected'

export class SessionStore {
  readonly ready: Promise<void>
  draft = ''
  copyoverPaused = false
  readonly id: string
  name: string
  host: string
  port: number
  profileId: string | null
  /**
   * The character logged in on this session — appended to the tab label.
   * Learned from GMCP (Char.Status / Char.Name) when the MUD provides it;
   * otherwise guessed from the login flow (see LoginGuesser). GMCP always
   * wins over a guess. Cleared on disconnect.
   */
  charName: string | null = null
  private charNameFromGmcp = false
  /** Called when charName changes (the tab bar re-renders). */
  onCharName?: () => void
  private loginGuess = new LoginGuesser()

  private setCharName(name: string | null, fromGmcp: boolean): void {
    if (fromGmcp) this.charNameFromGmcp = true
    else if (this.charNameFromGmcp) return // a guess never overrides GMCP
    if (name === this.charName) return
    this.charName = name
    this.onCharName?.()
    // Lets an agent address the session by the character it is playing.
    if (this.agent) void window.mud.agent.enable(this.id, this.agentInfo()).catch(() => {})
    // Character-scoped items wake up (or go quiet) with the name. Timers
    // re-arm to pick up the ones now active (startTimers, not refreshTimers:
    // that one also reconciles variables against a settings save that did
    // not happen, and would blank live vitals); scripts scoped to this
    // character run now, since connect-time was too early to know it.
    if (this.status === 'connected' && this.automationReady) {
      this.engine.startTimers()
      if (name) this.runStartupScripts(true)
    }
    this.notify()
  }

  lines: Line[] = []
  /** Spans of the current unfinished line (usually the prompt). */
  openSpans: Span[] = []
  /**
   * The open line is a finished prompt, so the next server text starts a new
   * line. Merc-family MUDs send a command's reply with no line break, and
   * when another prompt went out while the command waited, the reply lands
   * on that prompt; split there, triggers anchored with ^ and capture
   * windows see the reply alone. The player's own echo still joins the
   * prompt line, cMUD-style.
   */
  private promptDone = false
  version = 0

  status: SessionStatus = 'connecting'
  serverEchoes = false // true → mask input (passwords)
  mccp = false
  gmcp = false
  msdp = false
  mxp = false
  msp = false
  lastMssp: Record<string, string> | null = null
  readonly sounds = new SoundPlayer()

  /** Running merge of the flat MSDP room variables (see handleMsdpForMap). */
  private msdpRoom: {
    vnum?: string
    name?: string
    area?: string
    exits?: ServerRoomInfo['exits']
  } = {}
  private msdpRoomFlush: ReturnType<typeof setTimeout> | null = null

  logging = false
  logPath: string | null = null
  private loggingPending = false

  /** Agent control (#agent on): a program on this computer may type here and
   *  read the session's text. Deliberately not carried across an update. */
  agent = false
  private agentPending = false
  private agentPromptSent = ''

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
  /** Which map this session reads and writes: its profile, or host and port. */
  readonly mapKey: string

  private parser = new AnsiParser()
  private nextLineId = 1
  private subs = new Set<() => void>()
  private flushScheduled = false
  private disposed = false
  private connectionGeneration = 0
  private automationReady = false

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
        onVariablesChanged: () => this.notify(),
        characterName: () => this.charName
      },
      () => settingsManager.getSets(this.profileId)
    )
    void settingsManager.ensure(this.profileId).catch((err) => {
      if (!this.disposed) this.addSystemLine(`Could not load settings: ${String(err)}`, 'error')
    })
    this.mapKey = this.profileId ?? `adhoc_${host}_${port}`
    this.ready = this.initMap()
    // MXP <VERSION>/<SUPPORT> replies go straight to the wire (not the
    // command pipeline — they are protocol, not player input).
    this.parser.onMxpReply = (text) => window.mud.send(this.id, text)
  }

  /** All outgoing traffic funnels through here so the mapper sees it. */
  private transmitRaw(command: string): void {
    if (this.copyoverPaused) return
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
    let model: MapModel
    try {
      model = await modelPromise
    } catch (err) {
      // A failed load must not be cached: drop it so the next session on this
      // world retries instead of inheriting a rejected promise forever.
      mapModelRegistry.delete(this.mapKey)
      this.addSystemLine(`Mapper: could not load the map (${String(err)}).`, 'error')
      return
    }
    if (this.disposed) return
    if (model.loadWarning) {
      this.addSystemLine(`Mapper: ${model.loadWarning}`, 'error')
    }
    const tracker = new MapTracker(model, {
      characterName: () => this.charName,
      info: (text) => this.addSystemLine(text, 'system'),
      // Profile set first, then global: a MUD-specific rule wins, and a
      // global one can still act as a default across worlds.
      captureRule: () => settingsManager.getSets(this.profileId).find((x) => x.capture)?.capture,
      onMoveFailed: (dir, closedDoor, doorName) =>
        this.handleMoveFailed(dir, closedDoor, doorName)
    })
    this.walker = new Walker(tracker, {
      transmit: (command) => this.transmitRaw(command),
      info: (text) => this.addSystemLine(text, 'system'),
      error: (text) => this.addSystemLine(text, 'error')
    })
    this.mapModel = model
    this.tracker = tracker
    // Come back the way this MUD was left. With no remembered state -- first
    // time here, or a map made before the pane state was persisted -- open it
    // if there is already a map worth showing.
    this.showMap = model.map.paneOpen ?? Object.keys(model.map.rooms).length > 0
    // ...and reopen the pop-out on whichever monitor it was left on. Main
    // ignores bounds that no longer land on an attached display.
    if (model.map.popout) {
      void window.mud.map.popout(this.id, this.name, model.map.popout)
    }
    if (tracker.currentRoom) {
      this.addSystemLine(
        `Mapper: resuming at "${tracker.currentRoom.name}" — your first room description re-verifies this.`,
        'system'
      )
    }
    const push = () => this.pushMirrorState()
    // The model outlives this session (it is shared via mapModelRegistry), so
    // its subscription must be undone in dispose() or the tab keeps pushing.
    this.mapUnsubs = [model.subscribe(push), tracker.subscribe(push)]
    this.notify()
  }

  toggleMap(): void {
    this.setMapVisible(!this.showMap)
  }

  /** Main process reporting where this session's pop-out map window sits, or
   *  null once the user closes it (quitting does not count as closing). */
  notePopoutBounds(bounds: PopoutBounds | null): void {
    this.mapModel?.setPopout(bounds)
  }

  /** Show or hide the map pane and remember the choice for this MUD. */
  private setMapVisible(open: boolean): void {
    this.showMap = open
    this.mapModel?.setPaneOpen(open)
    this.notify()
  }

  /**
   * A movement bounced. Closed door (even a hidden one the map doesn't show):
   * open it and retry the move once. Anything else — or a door that stays
   * shut — halts any active walk with the reason.
   */
  private lastAutoOpen: { dir: Direction; at: number; tries: number } | null = null

  private handleMoveFailed(dir: Direction, closedDoor: boolean, doorName?: string): void {
    if (!closedDoor) {
      this.walker?.notifyStepFailed(`the way ${DIR_FULL[dir]} is blocked`)
      return
    }
    const now = Date.now()
    const tried =
      this.lastAutoOpen && this.lastAutoOpen.dir === dir && now - this.lastAutoOpen.at < 4000
        ? this.lastAutoOpen.tries
        : 0
    if (tried >= 2) {
      // Both forms bounced — genuinely locked, or named something we can't guess.
      this.lastAutoOpen = null
      this.addSystemLine(`Auto-open ${DIR_FULL[dir]} didn't work — the door may be locked.`, 'error')
      this.walker?.notifyStepFailed(`the door ${DIR_FULL[dir]} won't open`)
      return
    }
    const room = this.tracker?.currentRoom
    const exit = room && this.mapModel ? this.mapModel.exitOf(room, dir) : undefined
    const name = doorName?.trim() || exit?.doorName?.trim()
    // Bare direction first: `open down` needs no noun and is accepted across
    // Diku/SMAUG derivatives, where `open door down` fails outright on any MUD
    // that calls the thing something else — a grate, a gate, a hatch. Only if
    // that bounces do we name it, by which point the refusal has usually said
    // what it is.
    const command =
      tried === 0 ? `open ${DIR_FULL[dir]}` : `open ${name || 'door'} ${DIR_FULL[dir]}`
    this.lastAutoOpen = { dir, at: now, tries: tried + 1 }
    this.addSystemLine(
      tried === 0
        ? `Blocked by a door ${DIR_FULL[dir]} — opening it and retrying.`
        : `Still shut — trying "${command}".`,
      'system'
    )
    this.transmitRaw(command)
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
    if (!this.tracker.currentRoomId || this.tracker.lost || this.tracker.speculative) {
      this.addSystemLine('Cannot auto-walk until the mapper confirms your position. Keep exploring manually or use “I am here”.', 'error')
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
  private mapUnsubs: (() => void)[] = []

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
        speculative: this.tracker.speculative,
        confidence: this.tracker.confidence,
        serverDriven: this.tracker.serverDriven,
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

  /** One line on what a tidy did, or why it did nothing. */
  describeTidy(r: ReturnType<MapModel['tidyZone']>): string {
    const say = (s: { contrary: number; through: number; long: number }): string =>
      `${s.through} through rooms, ${s.contrary} off-axis, ${s.long} long`
    if (!r.applied) {
      return `Left the zone as it is: no layout was found that lies less (now ${say(r.before)}; best attempt ${say(r.attempted)}). #map tidy! applies the attempt anyway; #map untidy puts it back.`
    }
    const moved = Object.keys(r.moves).length
    return `Tidied ${moved} rooms: ${say(r.before)} → ${say(r.after)}. #map untidy puts them back.`
  }

  /**
   * #zone set / fill / undo: sort rooms into zones by text, for a map that
   * grew up in one zone. "set" moves the room you stand in, "fill" floods
   * out from it through rooms of the same zone; "@ <room>" aims either at
   * every room with that name (or that id) instead.
   */
  private zoneCommand(op: string, rest: string): void {
    const model = this.mapModel!
    const tracker = this.tracker!
    if (op === 'undo') {
      const n = model.undoZoneMove()
      this.addSystemLine(n === null ? 'No zone move to undo.' : `Put ${n} rooms back in their old zones.`, n === null ? 'error' : 'system')
      return
    }
    const [zoneName, target] = rest.split(/\s+@\s+/, 2).map((s) => s.trim())
    if (!zoneName) {
      this.addSystemLine(`Usage: #zone ${op} <zone name> [@ <room name>]. Without @ it starts from the room you are in.`, 'system')
      return
    }
    let starts: MapRoom[]
    if (target) {
      const wanted = target.toLowerCase()
      const rooms = Object.values(model.map.rooms)
      starts = rooms.filter((r) => r.id === target)
      if (starts.length === 0) starts = rooms.filter((r) => r.name.toLowerCase() === wanted)
      if (starts.length === 0) {
        this.addSystemLine(`No room called "${target}" on the map.`, 'error')
        return
      }
    } else {
      const here = tracker.lost ? null : tracker.currentRoom
      if (!here) {
        this.addSystemLine('Position unknown: stand somewhere the map knows, or aim with @ <room name>.', 'error')
        return
      }
      starts = [here]
    }
    const zoneId = model.createZone(zoneName)
    const zone = model.map.zones.find((z) => z.id === zoneId)!.name
    const ids = starts.map((r) => r.id)
    const named = target && starts.length > 1 ? ` (${starts.length} rooms are called "${starts[0].name}")` : ''
    if (op === 'set') {
      const moved = model.moveRoomsToZone(ids, zoneId)
      this.addSystemLine(
        moved === 0
          ? `Already in ${zone}${named}.`
          : `Moved ${moved} room${moved === 1 ? '' : 's'} to ${zone}${named}. #zone undo puts ${moved === 1 ? 'it' : 'them'} back.`,
        'system'
      )
    } else {
      const { moved, stoppedAt } = model.fillZone(ids, zoneId)
      const walls = stoppedAt.map((id) => model.map.zones.find((z) => z.id === id)?.name).filter(Boolean)
      this.addSystemLine(
        `Filled ${zone}: moved ${moved} room${moved === 1 ? '' : 's'}${named}.` +
          (walls.length > 0 ? ` Stopped at rooms in ${walls.join(', ')}.` : '') +
          (moved > 0 ? ' #zone undo puts them back.' : ''),
        'system'
      )
    }
    // Standing in the zone: show it, and keep new rooms here in it.
    if (!target && tracker.currentRoom?.zoneId === zoneId) {
      model.setActiveZone(zoneId)
      model.setPendingZone(zoneId)
    }
    this.notify()
  }

  /** Returns true if the input was a mapper command (consumed). */
  private tryMapperCommand(raw: string): boolean {
    const m = /^#(map|go!?|wp|waypoint|zone|lost)(?:\s+(.*))?$/i.exec(raw.trim())
    if (!m) return false
    const verb = m[1].toLowerCase()
    const arg = (m[2] ?? '').trim()

    const tidy = /^(tidy!?|untidy)(?:\s+(.+))?$/i.exec(arg)
    if (verb === 'map' && tidy) {
      if (!this.mapModel || !this.tracker) {
        this.addSystemLine('Map still loading — try again in a moment.', 'error')
        return true
      }
      if (tidy[1].toLowerCase() === 'untidy') {
        const n = this.mapModel.undoTidy()
        this.addSystemLine(n === null ? 'No tidy to undo.' : `Put ${n} rooms back where they were.`, n === null ? 'error' : 'system')
        return true
      }
      const current = this.tracker.currentRoom
      // "#map tidy Town of Knat" tidies a zone by name, wherever you stand.
      const named = tidy[2] ? this.mapModel.zoneByName(tidy[2]) : null
      if (tidy[2] && !named) {
        this.addSystemLine(`No zone called "${tidy[2].trim()}". #zone list shows them.`, 'error')
        return true
      }
      const zoneId = named?.id ?? current?.zoneId ?? this.mapModel.activeZoneId
      if (!zoneId) {
        this.addSystemLine('No zone to tidy — stand in one, or pick it on the map.', 'error')
        return true
      }
      const anchor = current && current.zoneId === zoneId ? current.id : null
      const result = this.mapModel.tidyZone(zoneId, anchor, tidy[1].endsWith('!'))
      this.addSystemLine(this.describeTidy(result), result.applied ? 'system' : 'error')
      return true
    }
    if (verb === 'map' && /^here$/i.test(arg)) {
      if (!this.mapModel || !this.tracker) {
        this.addSystemLine('Map still loading — try again in a moment.', 'error')
        return true
      }
      const known = this.tracker.currentRoom
      if (known && !this.tracker.lost) {
        this.addSystemLine(`The mapper already has you in ${known.name}.`, 'system')
        return true
      }
      // The keyboard's "Add room here and set my position", for when the
      // mapper has lost you somewhere it has never seen (a teleport, a
      // portal): a fresh room on a clear spot, then a look to fill in its
      // name, description and exits.
      const zoneId = this.mapModel.activeZoneId
      const level = Object.values(this.mapModel.map.rooms).filter((r) => r.zoneId === zoneId && r.z === 0)
      const x = level.length > 0 ? Math.max(...level.map((r) => r.x)) + 3 : 0
      const room = this.mapModel.createRoom({ name: 'New room', zoneId, x, y: 0, z: 0 })
      this.tracker.setCurrentRoom(room.id)
      this.addSystemLine('Mapping from here: this room is on the map now. Looking to fill in its details.', 'system')
      this.echoInput('look')
      this.engine.processInput('look')
      return true
    }
    if (verb === 'map') {
      this.toggleMap()
      return true
    }
    if (!this.mapModel || !this.tracker) {
      this.addSystemLine('Map still loading — try again in a moment.', 'error')
      return true
    }
    if (verb === 'unmerge') {
      // The escape hatch that lets merging happen automatically at all: a bad
      // merge is much harder to notice than a duplicate, so one is always
      // reversible.
      const restored = this.mapModel.undoLastMerge()
      if (restored) {
        this.addSystemLine(`Put "${restored.name}" back as a separate room.`, 'system')
      } else {
        this.addSystemLine('No merge to undo.', 'error')
      }
      return true
    }
    if (verb === 'lost') {
      this.tracker.setCurrentRoom(null)
      this.setMapVisible(true)
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
      const op = /^(set|fill|undo)(?:\s+(.*))?$/i.exec(arg)
      if (op) {
        this.zoneCommand(op[1].toLowerCase(), (op[2] ?? '').trim())
        return true
      }
      if (!arg || arg.toLowerCase() === 'list') {
        const names = this.mapModel.map.zones
          .map((z) => (z.id === this.mapModel!.activeZoneId ? `[${z.name}]` : z.name))
          .join(', ')
        this.addSystemLine(
          `Zones: ${names}  ·  #zone <name> switches/creates · #zone set|fill <name> [@ <room>] sorts rooms · #zone undo`,
          'system'
        )
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
    this.varPersistTimer ??= setTimeout(() => this.flushVariables(), 3000)
  }

  /** Write the batched variables into the scope's settings file. */
  private flushVariables(): Promise<void> | void {
    this.varPersistTimer = null
    if (this.pendingVars.size === 0) return
    const scope = this.profileId
    if (!settingsManager.isLoaded(scope)) {
      // Saving now would write defaults over the profile's real settings
      // file. The values already live in the engine, so hold them and try
      // again once the scope has come in.
      this.varPersistTimer = setTimeout(() => this.flushVariables(), 3000)
      return
    }
    const batch = Object.fromEntries(this.pendingVars)
    this.pendingVars.clear()
    const set = settingsManager.getScope(scope)
    return settingsManager.save(scope, {
      ...set,
      variables: { ...set.variables, ...batch }
    })
  }

  /** Run one script immediately (used by the settings panel's Run button). */
  runScriptNow(script: ScriptDef): void {
    this.addSystemLine(`Running script "${script.name}"…`, 'system')
    this.scripts.run(script.language, script.code, {})
  }

  /**
   * Run the scripts that start on their own. At connect the character is
   * not known yet, so scripts scoped to one wait; when the name arrives
   * this runs again for those alone (`scopedOnly`), so nothing runs twice.
   */
  private runStartupScripts(scopedOnly = false): void {
    for (const set of settingsManager.getSets(this.profileId)) {
      for (const script of set.scripts) {
        if (!script.enabled) continue
        const scoped = characterList(script.character).length > 0
        if (scopedOnly !== scoped) continue
        if (!forCharacter(script.character, this.charName)) continue
        this.scripts.run(script.language, script.code, {})
      }
    }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  getVersion = (): number => this.version

  toggleTriggers(): void {
    this.engine.triggersPaused = !this.engine.triggersPaused
    this.notify()
  }

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
    if (this.disposed) return
    switch (event.type) {
      case 'connected':
        this.status = 'connected'
        this.addSystemLine(`Connected to ${this.host}:${this.port}`, 'system')
        this.startAutomation()
        break
      case 'disconnected':
        this.status = 'disconnected'
        this.connectionGeneration++
        this.automationReady = false
        if (this.msdpRoomFlush !== null) clearTimeout(this.msdpRoomFlush)
        this.msdpRoomFlush = null
        this.engine.stopTimers()
        this.engine.cancelPacedRepeats()
        this.cancelBlock()
        this.walker?.cancel(false)
        this.tracker?.reset()
        this.sounds.stopAll()
        this.closeOpenLine()
        this.syncAgentPrompt()
        this.charNameFromGmcp = false
        this.loginGuess.reset()
        this.setCharName(null, false)
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
        // An inferred one (a pause, no GA/EOR) must also look like a prompt.
        if (
          this.openSpans.length > 0 &&
          (!event.inferred || PROMPT_END.test(this.openSpans.map((s) => s.text).join('')))
        ) {
          this.promptDone = true
        }
        this.notify()
        break
      case 'echo':
        this.serverEchoes = event.serverEchoes
        // Password masking ending is the "you're past the password" signal
        // the login guesser waits for before it trusts a candidate name.
        if (!event.serverEchoes) {
          const confirmed = this.loginGuess.onMaskEnd()
          if (confirmed) this.setCharName(confirmed, false)
        }
        this.notify()
        break
      case 'compression':
        this.mccp = event.enabled
        this.notify()
        break
      case 'msdpEnabled':
        this.msdp = true
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
        this.handleGmcpCharName(event.package, event.data)
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

  private startAutomation(): void {
    this.engine.resetTimerHistory()
    const generation = ++this.connectionGeneration
    const start = (): void => {
      if (this.disposed || this.status !== 'connected' || generation !== this.connectionGeneration) return
      this.automationReady = true
      this.engine.startTimers()
      this.runStartupScripts()
      if (this.charName) this.runStartupScripts(true)
      if (this.mergedAutoLog() && !this.logging) void this.toggleLogging()
    }
    if (settingsManager.isLoaded(null) && settingsManager.isLoaded(this.profileId)) start()
    else void settingsManager.ensure(this.profileId).then(start).catch((err) => {
      if (!this.disposed) this.addSystemLine(`Could not start automation: ${String(err)}`, 'error')
    })
  }

  /** GMCP Char.Status / Char.Name → the character's name for the tab label. */
  private handleGmcpCharName(pkg: string, data: unknown): void {
    if (!/^char\.(status|name)$/i.test(pkg)) return
    if (typeof data !== 'object' || data === null) return
    const d = data as Record<string, unknown>
    // Char.Name uses "name"; Char.Status uses "name" on most servers, some
    // put it under "character".
    const raw = d.name ?? d.character
    if (typeof raw !== 'string') return
    const name = raw.trim()
    if (!name) return
    this.setCharName(name, true)
  }

  /**
   * Fallback for MUDs without GMCP: infer the character name from the login
   * exchange. Fed every outbound line together with the server text that
   * preceded it, and told when password masking starts/stops.
   */
  private feedLoginGuess(sent: string): void {
    if (this.charNameFromGmcp) return
    // The server text we're answering: the open prompt spans, else the last
    // completed line.
    let promptText = this.openSpans.map((s) => s.text).join('')
    if (!promptText.trim()) {
      const last = this.lines[this.lines.length - 1]
      promptText = last?.spans.map((s) => s.text).join('') ?? ''
    }
    const guess = this.loginGuess.onSend(promptText, sent)
    if (guess) this.setCharName(guess, false)
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
    const info = gmcpRoomInfo(pkg, data)
    if (info) this.tracker?.onServerRoom(info)
  }

  /**
   * MSDP room reports → authoritative tracker input.
   *
   * Two rival conventions exist and a MUD implements one or the other:
   *   1. a single ROOM table holding VNUM/NAME/AREA/EXITS, and
   *   2. the flat variables from KaVir's protocol snippet — ROOM_VNUM,
   *      ROOM_NAME, ROOM_EXITS, AREA_NAME — which is what tbaMUD and the
   *      rest of the DikuMUD family report.
   *
   * The flat form needs accumulating. MSDPUpdate sends each dirty variable
   * in its own subnegotiation, and only variables that CHANGED: walking
   * between two identically-named rooms reports ROOM_VNUM by itself. So the
   * fields are merged into a running record — unchanged ones carry forward —
   * and flushed once the batch settles.
   */
  private handleMsdpForMap(data: Record<string, unknown>): void {
    const room = data.ROOM
    if (typeof room === 'object' && room !== null) {
      const r = room as Record<string, unknown>
      const vnum = r.VNUM ?? r.vnum
      if (vnum === undefined || vnum === null || vnum === '') return
      this.tracker?.onServerRoom({
        serverId: `vnum:${vnum}`,
        name: typeof r.NAME === 'string' ? r.NAME : undefined,
        areaName: typeof r.AREA === 'string' ? r.AREA : undefined,
        exits: msdpExits(r.EXITS ?? r.exits)
      })
      return
    }

    let touched = false
    const vnum = data.ROOM_VNUM
    if (vnum !== undefined && vnum !== null && vnum !== '') {
      this.msdpRoom.vnum = String(vnum)
      touched = true
    }
    if (typeof data.ROOM_NAME === 'string' && data.ROOM_NAME !== '') {
      this.msdpRoom.name = data.ROOM_NAME
      touched = true
    }
    if (typeof data.AREA_NAME === 'string' && data.AREA_NAME !== '') {
      this.msdpRoom.area = data.AREA_NAME
      touched = true
    }
    if ('ROOM_EXITS' in data) {
      this.msdpRoom.exits = msdpExits(data.ROOM_EXITS)
      touched = true
    }
    if (!touched || this.msdpRoomFlush !== null) return
    this.msdpRoomFlush = setTimeout(() => {
      this.msdpRoomFlush = null
      const { vnum: id, name, area, exits } = this.msdpRoom
      if (id === undefined) return // name/area without an id identifies nothing
      this.tracker?.onServerRoom({ serverId: `vnum:${id}`, name, areaName: area, exits })
    }, 0)
  }

  // ---- input --------------------------------------------------------------

  /** Re-dial the same host in the same tab: scrollback, map, and settings stay. */
  reconnect(): void {
    if (this.status !== 'disconnected') {
      this.addSystemLine('Already connected.', 'system')
      return
    }
    this.status = 'connecting'
    this.cancelBlock()
    this.serverEchoes = false
    this.mccp = false
    this.gmcp = false
    this.msdp = false
    this.mxp = false
    this.msp = false
    // Fresh protocol state: the new connection renegotiates everything.
    if (this.msdpRoomFlush !== null) clearTimeout(this.msdpRoomFlush)
    this.msdpRoomFlush = null
    this.msdpRoom = {}
    this.parser = new AnsiParser()
    this.parser.onMxpReply = (text) => window.mud.send(this.id, text)
    this.addSystemLine(`Reconnecting to ${this.host}:${this.port}…`, 'system')
    void window.mud.reconnect(this.id)
    this.notify()
  }

  /** Send user input through the automation pipeline (or raw when masked). */
  sendInput(input: string, masked: boolean): void {
    if (this.copyoverPaused) return
    if (masked) {
      window.mud.send(this.id, input)
      return
    }
    // Multi-line input is a pasted block, not a command: it goes out line by
    // line with its formatting intact instead of through the pipeline.
    const lines = splitPastedBlock(input)
    if (lines.length > 1) {
      this.sendBlock(lines)
      return
    }
    const raw = lines[0]
    this.feedLoginGuess(raw)
    if (/^#help$/i.test(raw.trim())) {
      uiState.openHelp?.()
      return
    }
    if (/^#rec(onnect)?$/i.test(raw.trim())) {
      this.reconnect()
      return
    }
    // #char [name]: say, or set by hand, who is logged in. Character-scoped
    // triggers and aliases depend on the name, and a MUD that speaks no
    // GMCP only ever gives the login guesser a guess to work with.
    const charCmd = /^#char(?:acter)?(?:\s+(.*))?$/i.exec(raw.trim())
    if (charCmd) {
      const wanted = (charCmd[1] ?? '').trim()
      if (wanted) {
        this.setCharName(wanted, true) // by hand beats a guess, like GMCP
        this.addSystemLine(`Character set to ${wanted}: items scoped to that name are active.`, 'system')
      } else {
        this.addSystemLine(
          this.charName
            ? `Logged in as ${this.charName}${this.charNameFromGmcp ? '' : ' (guessed from the login)'}.`
            : 'Character unknown: items scoped to a character are inactive. #char <name> sets it.',
          'system'
        )
      }
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
    if (/^#stop$/i.test(raw.trim())) {
      if (this.walker?.walking) this.walker.cancel()
      this.cancelBlock()
      // fall through: engine also cancels paced repeats
    }
    this.echoInput(raw)
    this.engine.processInput(raw)
  }

  // ---- pasted blocks ------------------------------------------------------

  /** Pending timer while a paced multi-line send is still draining. */
  private blockTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Send an already-split multi-line block, one line per transmission.
   *
   * Verbatim (the default) means exactly that: no ';' stacking, no alias
   * expansion, no @variable substitution, no speedwalk/#repeat parsing and —
   * the point of the exercise — no trimming, so indentation survives. It also
   * skips the mapper, because a "n" inside a script is text, not a step. That
   * is what makes it safe to write a trigedit script in a real editor and
   * paste the whole thing into the MUD's OLC editor.
   *
   * With "paste verbatim" turned off every line runs through the normal
   * command pipeline instead, which is what you want when the block is a list
   * of commands rather than script text.
   */
  sendBlock(lines: string[]): void {
    if (this.status === 'disconnected') {
      this.addSystemLine(`Not connected — ${lines.length} pasted lines were not sent.`, 'error')
      this.notify()
      return
    }
    if (
      lines.length > PASTE_CONFIRM_LINES &&
      !window.confirm(
        `Send ${lines.length} lines to ${this.name}?\n\n` +
          'Each one is transmitted as a separate line of input. ' +
          'Cancel if you pasted this by accident.'
      )
    ) {
      return
    }
    this.cancelBlock()
    const verbatim = settingsManager.globalOptions.pasteVerbatim
    const delay = Math.min(5000, Math.max(0, settingsManager.globalOptions.pasteLineDelayMs || 0))
    let sent = 0

    /** Send lines[sent] (advancing it); false if the session dropped first. */
    const sendOne = (): boolean => {
      if (this.status === 'disconnected') {
        this.addSystemLine(
          `Connection closed — stopped after ${sent} of ${lines.length} pasted lines.`,
          'error'
        )
        this.notify()
        return false
      }
      const line = lines[sent++]
      this.echoInput(line)
      if (verbatim) window.mud.send(this.id, line)
      else this.engine.processInput(line)
      return true
    }

    if (delay === 0) {
      while (sent < lines.length) {
        if (!sendOne()) break
      }
      return
    }
    this.addSystemLine(
      `Sending ${lines.length} lines, one every ${delay}ms — #stop cancels.`,
      'system'
    )
    const tick = (): void => {
      this.blockTimer = null
      if (!sendOne() || sent >= lines.length) return
      this.blockTimer = setTimeout(tick, delay)
    }
    tick()
  }

  /** Cancel a paced paste that is still draining; true if one was running. */
  cancelBlock(): boolean {
    if (this.blockTimer === null) return false
    clearTimeout(this.blockTimer)
    this.blockTimer = null
    this.addSystemLine('Paste cancelled.', 'system')
    this.notify()
    return true
  }

  // ---- output -------------------------------------------------------------

  private appendOutput(data: string): void {
    for (const token of this.parser.parse(data)) {
      if (token.kind === 'newline') {
        this.completeLine()
      } else {
        if (this.promptDone) this.completeLine()
        this.openSpans.push(token.span)
        // A line that never ends (a broken server, or a huge unterminated
        // dump) would otherwise grow without bound; break it here.
        if (this.openSpans.length > MAX_OPEN_SPANS || this.openLineLength() > MAX_OPEN_CHARS) {
          this.completeLine()
        }
      }
    }
    this.syncAgentPrompt()
    this.notify()
  }

  private openLineLength(): number {
    let n = 0
    for (const s of this.openSpans) n += s.text.length
    return n
  }

  async flushWorld(): Promise<void> {
    if (this.varPersistTimer) clearTimeout(this.varPersistTimer)
    if (settingsManager.isLoaded(this.profileId)) await this.flushVariables()
    this.mapModel?.flush()
    if (this.mapModel) await window.mud.map.persist(this.mapKey, this.mapModel.map)
  }

  async snapshot() {
    const scripts = this.scripts.snapshot() // Check compatibility before stopping work.
    this.copyoverPaused = true
    this.engine.stopTimers()
    this.engine.cancelPacedRepeats()
    this.cancelBlock()
    this.walker?.cancel(false)
    await this.ready
    // Let a pending MSDP batch finish before capturing tracker state.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await this.flushWorld()
    const state = saveFields(this, SESSION_STATE)
    if (this.serverEchoes) state.draft = ''
    return { id: this.id, state, parser: this.parser.snapshot(), login: this.loginGuess.snapshot(),
      engine: this.engine.snapshot(), scripts, tracker: this.tracker?.snapshot(),
      captures: [...this.captureWindows], logging: this.logging }
  }
  /** `moved`: the session came from another window, whose log is still open in main. */
  async restore(snapshot: Awaited<ReturnType<SessionStore['snapshot']>>, opts?: { moved?: { logPath: string | null } }) {
    await this.ready
    restoreFields(this, SESSION_STATE, snapshot.state)
    this.parser.restore(snapshot.parser)
    this.loginGuess.restore(snapshot.login)
    this.engine.restore(snapshot.engine)
    this.scripts.restore(snapshot.scripts)
    this.captureWindows = new Map(snapshot.captures)
    if (snapshot.tracker) this.tracker?.restore(snapshot.tracker)
    this.copyoverPaused = true
    if (opts?.moved) {
      // Same log file: starting it again would split the log in two.
      this.logging = snapshot.logging
      this.logPath = snapshot.logging ? opts.moved.logPath : null
    } else if (snapshot.logging) {
      // Restart logging without reprocessing historical lines or login scripts.
      await this.toggleLogging()
    }
    this.notify()
  }
  resumeCopyover(): void {
    this.copyoverPaused = false
    if (this.status === 'connected' && this.automationReady) this.engine.startTimers()
    this.notify()
  }

  private logLine(text: string, channel?: string): void {
    window.mud.log.line(this.id, text, { world: this.name, profileId: this.profileId, character: this.charName, channel })
  }

  private completeLine(): void {
    let spans = this.openSpans
    this.openSpans = []
    this.promptDone = false
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
    // Before the triggers run, so a trigger's echo follows the line that fired
    // it; and gagged lines too, since a gag only hides text from the screen.
    this.agentLine('output', plain)
    const directive = this.engine.processLine(plain)
    if (this.logging) this.logLine(plain)
    if (directive.highlight) {
      const color = directive.highlight
      spans = spans.map((s) => ({ ...s, style: { ...s.style, color } }))
    }
    if (directive.captures) {
      for (const windowName of directive.captures) {
        if (this.logging) this.logLine(plain, windowName)
        let buffer = this.captureWindows.get(windowName)
        if (!buffer) {
          buffer = []
          this.captureWindows.set(windowName, buffer)
        }
        buffer.push({ id: this.nextLineId++, spans, kind: 'output', at: Date.now(), character: this.charName })
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
    this.promptDone = false
    if (this.logging) this.logLine(spans.map((s) => s.text).join(''))
    this.agentLine('input', spans.map((s) => s.text).join(''))
    this.syncAgentPrompt()
    this.notify()
  }

  private addTriggerEcho(command: string): void {
    this.pushLine({
      id: this.nextLineId++,
      spans: [{ text: `» ${command}`, style: { color: '#8b949e', italic: true } }],
      kind: 'trigger'
    })
    this.agentLine('trigger', command)
    this.notify()
  }

  private addScriptEcho(text: string): void {
    this.pushLine({
      id: this.nextLineId++,
      spans: [{ text, style: { color: '#c678dd' } }],
      kind: 'trigger'
    })
    if (this.logging) this.logLine(text)
    this.agentLine('script', text)
    this.notify()
  }

  addSystemLine(text: string, kind: 'system' | 'error'): void {
    const color = kind === 'error' ? '#ff7b86' : '#56b6c2'
    this.pushLine({
      id: this.nextLineId++,
      spans: [{ text: `— ${text} —`, style: { color, italic: true } }],
      kind
    })
    if (this.logging) this.logLine(`--- ${text} ---`)
    this.agentLine(kind, text)
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
    if (this.disposed || this.loggingPending) return
    this.loggingPending = true
    const generation = this.connectionGeneration
    try {
      if (this.logging) {
        this.logging = false
        await window.mud.log.stop(this.id)
        this.addSystemLine('Logging stopped.', 'system')
        this.logPath = null
      } else {
        const file = await window.mud.log.start(this.id, this.name)
        if (this.disposed || generation !== this.connectionGeneration) {
          await window.mud.log.stop(this.id)
          return
        }
        this.logging = true
        this.logPath = file
        this.addSystemLine(`Logging to ${file}`, 'system')
      }
    } catch (err) {
      if (!this.disposed) this.addSystemLine(`Logging failed: ${String(err)}`, 'error')
    } finally {
      this.loggingPending = false
      this.notify()
    }
  }

  // ---- agent control ------------------------------------------------------

  /**
   * #agent [on|off], typed by the player. SessionView sends it here from the
   * input line and nowhere else: a link or trigger from the server must
   * never be able to hand the session to another program.
   */
  agentCommand(raw: string): void {
    const m = /^#agent(?:\s+(on|off))?$/i.exec(raw.trim())
    if (!m) {
      this.addSystemLine('Usage: #agent on, #agent off, or #agent to see which.', 'error')
    } else if (m[1]) {
      void this.setAgent(m[1].toLowerCase() === 'on')
      return
    } else {
      this.addSystemLine(
        this.agent
          ? 'Agent control is on for this session. #agent off stops it.'
          : 'Agent control is off. #agent on lets a program on this computer play this session.',
        'system'
      )
    }
    this.notify()
  }

  async setAgent(on: boolean): Promise<void> {
    if (this.disposed || this.agentPending || on === this.agent) return
    this.agentPending = true
    try {
      if (on) {
        await window.mud.agent.enable(this.id, this.agentInfo())
        if (this.disposed) {
          void window.mud.agent.disable(this.id)
          return
        }
        this.agent = true
        this.agentPromptSent = ''
        this.addSystemLine(
          'Agent control on: a program on this computer can now type in this session and read its text. #agent off stops it.',
          'system'
        )
        this.syncAgentPrompt()
      } else {
        this.agent = false
        await window.mud.agent.disable(this.id)
        this.addSystemLine('Agent control off.', 'system')
      }
    } catch (err) {
      if (!this.disposed) this.addSystemLine(`Agent control failed: ${String(err)}`, 'error')
    } finally {
      this.agentPending = false
      this.notify()
    }
  }

  /** A command from the agent bridge: run it as if typed, or say why not. */
  agentSend(text: string): AgentSendResult {
    if (!this.agent || this.disposed) return { ok: false, error: 'Agent control is off for this session.' }
    if (this.copyoverPaused) return { ok: false, error: 'Wayfarer is installing an update; try again in a moment.' }
    if (this.status !== 'connected') {
      return { ok: false, error: 'The session is not connected. The player reconnects and logs in from Wayfarer.' }
    }
    if (this.serverEchoes) return { ok: false, error: 'The game is asking for a password. The player types it in Wayfarer.' }
    // Multi-line text would become a pasted block, which can stop for a
    // confirmation dialog nobody is there to answer.
    if (/[\r\n]/.test(text)) return { ok: false, error: 'One command at a time.' }
    const trimmed = text.trim()
    if (/^#agent\b/i.test(trimmed)) return { ok: false, error: 'Only the player can change agent control.' }
    // A reconnect can run a stored login script: logging in stays with the player.
    if (/^#rec(onnect)?$/i.test(trimmed)) return { ok: false, error: 'Reconnecting is left to the player.' }
    if (/^#help$/i.test(trimmed)) return { ok: false, error: "#help opens Wayfarer's help window; use the game's own help." }
    this.sendInput(text, false)
    return { ok: true }
  }

  /**
   * The keeper carried this connection across an update but the snapshot
   * had no screen for it. It is still open, so show it as connected and say
   * why the scrollback is empty.
   */
  adoptStray(): void {
    this.status = 'connected'
    this.addSystemLine(
      "Wayfarer couldn't bring back this session's screen after the update, but the connection stayed open. Carry on here, or close the tab to disconnect.",
      'system'
    )
  }

  /** The session moved here from another window with agent control on: it carries on, quietly. */
  resumeAgent(): void {
    if (this.disposed) return
    this.agent = true
    this.agentPromptSent = ''
    void window.mud.agent.enable(this.id, this.agentInfo()).catch(() => {})
    this.syncAgentPrompt()
  }

  private agentInfo(): AgentSessionInfo {
    return { name: this.name, character: this.charName }
  }

  /** Synchronous on purpose: notify() waits for a frame, and a hidden window gets none. */
  private agentLine(kind: AgentLine['kind'], text: string): void {
    if (this.agent) window.mud.agent.line(this.id, { kind, text })
  }

  /** Tell the bridge when the unfinished last line, usually the prompt, changes. */
  private syncAgentPrompt(): void {
    if (!this.agent) return
    const text = this.openSpans.map((s) => s.text).join('')
    if (text === this.agentPromptSent) return
    this.agentPromptSent = text
    window.mud.agent.prompt(this.id, text)
  }

  /**
   * Stop everything this window runs for the session. `moved`: the session
   * lives on in another window, so its log and agent control stay open.
   */
  dispose(opts?: { moved?: boolean }): void {
    if (this.disposed) return
    this.disposed = true
    const moved = opts?.moved === true
    if (this.agent) {
      this.agent = false
      if (!moved) void window.mud.agent.disable(this.id)
    }
    this.connectionGeneration++
    this.engine.stopTimers()
    this.engine.cancelPacedRepeats()
    if (this.blockTimer !== null) clearTimeout(this.blockTimer)
    if (this.mirrorTimer !== null) clearTimeout(this.mirrorTimer)
    if (this.msdpRoomFlush !== null) clearTimeout(this.msdpRoomFlush)
    if (this.varPersistTimer !== null) clearTimeout(this.varPersistTimer)
    if (settingsManager.isLoaded(this.profileId)) this.flushVariables()
    this.walker?.cancel(false)
    for (const unsub of this.mapUnsubs) unsub()
    this.mapUnsubs = []
    this.tracker?.dispose()
    this.sounds.stopAll()
    this.mapModel?.flush()
    this.scripts.dispose()
    if (this.logging && !moved) void window.mud.log.stop(this.id)
  }
}

/** Registry of live sessions; App routes IPC events here. */
export const sessionStores = new Map<string, SessionStore>()

/** One shared MapModel per map key (kept across reconnects and tab closes). */
const mapModelRegistry = new Map<string, Promise<MapModel>>()
/** Restore is allowed only after all tabs for the world close. */
export function forgetWorldMap(profileId: string): void { mapModelRegistry.delete(profileId) }

// Flush debounced map and variable writes before the renderer disappears,
// and stop session-owned work just as when closing an individual tab.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    for (const store of sessionStores.values()) store.dispose()
  })
}
