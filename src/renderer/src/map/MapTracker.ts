/**
 * MapTracker — figures out where the player is and (in map mode) grows the
 * map as they explore.
 *
 * Identity sources, most to least authoritative:
 *   1. Server room ids (GMCP Room.Info / MSDP ROOM)
 *   2. Dead reckoning: pending movement commands + text room detections
 *
 * Trust model: pause-and-flag. On contradiction the tracker sets lost=true
 * and STOPS creating/linking rooms until the player re-syncs (clicks
 * "I am here" or walks somewhere recognizable). It never guesses into the map.
 */
import type { MapModel } from './MapModel.ts'
import { RoomCapture, isMoveFailure, isClosedDoorFailure } from './capture.ts'
import {
  DIR_DELTA,
  normalizeRoomName,
  OPPOSITE,
  wordToDirection,
  type Direction,
  type MapRoom,
  type RoomDetection,
  type ServerRoomInfo
} from './types.ts'

export type TrackerMode = 'map' | 'follow' | 'off'

interface PendingMove {
  dir: Direction
  at: number
}

const PENDING_CAP = 30
const PENDING_TTL_MS = 15_000

export interface TrackerHost {
  /** Informational output to the session (system-style line). */
  info(text: string): void
}

export class MapTracker {
  mode: TrackerMode = 'map'
  lost = false
  currentRoomId: string | null = null

  private model: MapModel
  private host: TrackerHost
  private capture = new RoomCapture()
  private pending: PendingMove[] = []
  private lastOpenDir: Direction | null = null
  private subs = new Set<() => void>()

  constructor(model: MapModel, host: TrackerHost) {
    this.model = model
    this.host = host
    // Resume where the player last was; the first room description after
    // login re-verifies (mismatch → unique-fingerprint snap or lost flag).
    const last = model.map.lastRoomId
    if (last && model.room(last)) this.currentRoomId = last
  }

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  private notify(): void {
    this.model.setLastRoom(this.currentRoomId)
    // An armed #zone is fulfilled once we're standing in that zone.
    if (this.model.pendingZoneId && this.currentRoom?.zoneId === this.model.pendingZoneId) {
      this.model.pendingZoneId = null
    }
    for (const fn of this.subs) fn()
  }

  /**
   * Zone for a newly created room: an armed #zone wins once, then rooms
   * inherit the zone of the room they were entered from, falling back to the
   * active zone for seeds/manual anchors.
   */
  private zoneForNewRoom(from: MapRoom | null): string {
    const pending = this.model.pendingZoneId
    if (pending && this.map.zones.some((z) => z.id === pending)) {
      this.model.pendingZoneId = null
      return pending
    }
    return from?.zoneId ?? this.model.activeZoneId
  }

  get currentRoom(): MapRoom | null {
    return this.model.room(this.currentRoomId)
  }

  setMode(mode: TrackerMode): void {
    this.mode = mode
    this.notify()
  }

  /** Manual re-sync: "I am here". Clears lost. */
  setCurrentRoom(roomId: string | null): void {
    this.currentRoomId = roomId
    this.lost = false
    this.pending = []
    this.notify()
  }

  private markLost(reason: string): void {
    if (!this.lost) {
      this.lost = true
      this.host.info(`Mapper lost: ${reason} Right-click your room on the map → "I am here".`)
    }
    this.pending = []
    this.notify()
  }

  // ---- inputs -------------------------------------------------------------

  /** Every command actually transmitted to the MUD passes through here. */
  onCommand(command: string): void {
    if (this.mode === 'off') return
    const trimmed = command.trim().toLowerCase()
    const dir = wordToDirection(trimmed)
    if (dir) {
      this.pending.push({ dir, at: Date.now() })
      if (this.pending.length > PENDING_CAP) this.pending.shift()
      return
    }
    // "open <thing> <dir>" — a door exists on that exit.
    const open = /^open\s+\S+\s+(\w+)$/.exec(trimmed)
    if (open) {
      const openDir = wordToDirection(open[1])
      if (openDir) {
        this.lastOpenDir = openDir
        if (this.currentRoomId && !this.lost) {
          this.model.setDoor(this.currentRoomId, openDir, true)
        }
      }
    }
  }

  /** Every completed output line passes through here. */
  onLine(plain: string): void {
    if (this.mode === 'off') return
    this.expirePending()

    if (isMoveFailure(plain)) {
      const failed = this.pending.shift()
      if (failed && isClosedDoorFailure(plain) && this.currentRoomId && !this.lost) {
        // Door in the way: record it (and a stub exit) without moving.
        this.model.setDoor(this.currentRoomId, failed.dir, true)
      }
      return
    }

    const detection = this.capture.feedLine(plain)
    if (detection) this.handleDetection(detection)
  }

  /** Structured room info from GMCP/MSDP — authoritative identity. */
  onServerRoom(info: ServerRoomInfo): void {
    if (this.mode === 'off') return
    this.expirePending()
    const existing = this.model.findByServerId(info.serverId)
    const move = this.pending.shift()
    this.pending = [] // server info supersedes any queued guesses

    if (existing) {
      // Known room: link the path that got us here if it was unmapped.
      if (move && this.currentRoomId && this.mode === 'map' && !this.lost) {
        const from = this.model.room(this.currentRoomId)
        if (from && this.model.exitOf(from, move.dir)?.to == null) {
          this.model.linkRooms(from.id, move.dir, existing.id, true)
        }
      }
      this.currentRoomId = existing.id
      this.lost = false
      if (info.name && existing.name !== info.name) {
        this.model.updateRoom(existing.id, { name: info.name })
      }
      this.notify()
      return
    }

    if (this.mode !== 'map') {
      this.markLost('an unknown room (follow mode does not create rooms).')
      return
    }

    // New room, authoritative id. Server area names are authoritative for
    // zones; otherwise inherit from the room we came from.
    const from = move && !this.lost ? this.model.room(this.currentRoomId) : null
    const zoneId = info.areaName ? this.model.createZone(info.areaName) : this.zoneForNewRoom(from)
    const pos =
      from && move ? this.model.placeFrom(from, move.dir) : { x: 0, y: 0, z: 0 }
    const room = this.model.createRoom({
      name: info.name ?? 'Unknown room',
      serverId: info.serverId,
      zoneId,
      ...pos
    })
    if (info.exits) {
      for (const [dirWord, destSid] of Object.entries(info.exits)) {
        const dir = wordToDirection(dirWord)
        if (!dir) continue
        const exit = this.model.ensureExit(room.id, dir)
        if (destSid) {
          const dest = this.model.findByServerId(String(destSid))
          if (dest) exit.to = dest.id
        }
      }
    }
    if (from && move) this.model.linkRooms(from.id, move.dir, room.id, true)
    this.currentRoomId = room.id
    this.lost = false
    this.notify()
  }

  // ---- text-based dead reckoning ------------------------------------------

  private handleDetection(det: RoomDetection): void {
    const dirs = det.exits.map((e) => e.dir)
    const move = this.pending.shift()
    const current = this.model.room(this.currentRoomId)

    if (this.lost) {
      // While lost we only re-anchor on an unambiguous fingerprint.
      const matches = this.model.findByFingerprint(det.name, dirs)
      if (matches.length === 1) {
        this.currentRoomId = matches[0].id
        this.lost = false
        this.host.info(`Mapper re-synced at "${matches[0].name}".`)
        this.notify()
      }
      return
    }

    if (move && current) {
      const exit = this.model.exitOf(current, move.dir)
      if (exit?.to) {
        const dest = this.model.room(exit.to)
        if (dest && this.roomMatches(dest, det)) {
          this.currentRoomId = dest.id
          this.refreshExits(dest, det)
          this.syncName(dest, det)
          this.notify()
          return
        }
        // The link may be a wrong guess (reverse links are heuristic, and MUD
        // geometry is often asymmetric). On solid evidence, correct the exit
        // and follow the player instead of going lost.
        const fixes = this.model.findByFingerprint(det.name, dirs)
        const fixed = this.pickArrival(fixes, current, move.dir)
        if (fixed) {
          this.model.linkRooms(current.id, move.dir, fixed.id, false)
          this.currentRoomId = fixed.id
          this.refreshExits(fixed, det)
          this.host.info(
            `Mapper corrected the ${move.dir} exit of "${current.name}" → "${fixed.name}".`
          )
          this.notify()
          return
        }
        this.markLost(
          `expected "${dest?.name ?? '?'}" ${move.dir} of "${current.name}" but saw "${det.name}".`
        )
        return
      }
      // Unmapped direction from a known room.
      if (this.mode === 'map') {
        // Re-entry check: walking into a room we already know via an exit we
        // hadn't traversed yet. Identical room names are normal, so arrival
        // context (back-links, then grid position) disambiguates; only a
        // still-unresolvable match creates a new room. The reverse link is
        // only added when the return path is unclaimed or already ours:
        // `s` from A landing in B does NOT imply `n` from B returns to A.
        const candidates = this.model.findByFingerprint(det.name, dirs)
        const known = this.pickArrival(candidates, current, move.dir)
        if (known) {
          const back = this.model.exitOf(known, OPPOSITE[move.dir])
          const twoWay = back !== undefined && (back.to === null || back.to === current.id)
          this.model.linkRooms(current.id, move.dir, known.id, twoWay)
          this.currentRoomId = known.id
          this.refreshExits(known, det)
          this.syncName(known, det)
          this.notify()
          return
        }
        if (candidates.length > 0) {
          this.host.info(
            `Mapper: created a new "${det.name}" — ${candidates.length + 1} rooms with identical name/exits will exist. If this is really one of them, merge (right-click) or use 🧹.`
          )
        }
        const pos = this.model.placeFrom(current, move.dir)
        const room = this.model.createRoom({
          name: det.name,
          ...pos,
          zoneId: this.zoneForNewRoom(current)
        })
        this.applyDetectedExits(room, det)
        // Two-way link only if the new room reports the return exit.
        const hasReturn = dirs.includes(OPPOSITE[move.dir])
        this.model.linkRooms(current.id, move.dir, room.id, hasReturn)
        this.currentRoomId = room.id
        this.notify()
      } else {
        this.markLost(`moved ${move.dir} into unmapped territory.`)
      }
      return
    }

    if (current) {
      // No movement pending: probably a "look" — confirm we match.
      if (this.roomMatches(current, det)) {
        this.refreshExits(current, det)
        this.syncName(current, det)
        this.notify()
      } else {
        // Teleport/recall/death: try unambiguous snap, else flag.
        const matches = this.model.findByFingerprint(det.name, dirs)
        if (matches.length === 1) {
          this.currentRoomId = matches[0].id
          this.notify()
        } else {
          this.markLost(`arrived somewhere unrecognized ("${det.name}").`)
        }
      }
      return
    }

    // No current room at all (fresh session).
    const matches = this.model.findByFingerprint(det.name, dirs)
    if (matches.length === 1) {
      this.currentRoomId = matches[0].id
      this.notify()
    } else if (matches.length === 0 && this.mode === 'map' && Object.keys(this.map.rooms).length === 0) {
      // Seed the very first room of a fresh map.
      const room = this.model.createRoom({
        name: det.name,
        x: 0,
        y: 0,
        z: 0,
        zoneId: this.zoneForNewRoom(null)
      })
      this.applyDetectedExits(room, det)
      this.currentRoomId = room.id
      this.host.info(`Mapping started at "${det.name}".`)
      this.notify()
    }
    // Ambiguous or non-empty map: stay unanchored quietly until certain.
  }

  private get map() {
    return this.model.map
  }

  /**
   * Choose which fingerprint candidate we actually arrived in, given that we
   * walked `dir` out of `current`. MUDs reuse room names freely (a courtyard
   * wall can be three identical "Southern Outer Courtyard"s), so a name match
   * ALONE — even a unique one — is never trusted. Positive corroboration is
   * required:
   *   1. exactly one candidate whose return exit already points at us, else
   *   2. exactly one candidate sitting along `dir` nearby (same zone/level).
   * Returns null otherwise — creating a (mergeable) duplicate is recoverable;
   * a wrong link actively misleads.
   */
  private pickArrival(candidates: MapRoom[], current: MapRoom, dir: Direction): MapRoom | null {
    const others = candidates.filter((c) => c.id !== current.id)
    if (others.length === 0) return null

    const backLinked = others.filter(
      (c) => this.model.exitOf(c, OPPOSITE[dir])?.to === current.id
    )
    if (backLinked.length === 1) return backLinked[0]

    // Exact grid adjacency only: one step in `dir`. Anything further away is
    // NOT adjacent — a visible gap on a grid map means a room in between that
    // simply hasn't been mapped yet, and a twin across the gap must not
    // capture the arrival.
    const [dx, dy, dz] = DIR_DELTA[dir]
    const adjacent = others.filter(
      (c) =>
        c.zoneId === current.zoneId &&
        c.x === current.x + dx &&
        c.y === current.y + dy &&
        c.z === current.z + dz
    )
    if (adjacent.length === 1) return adjacent[0]
    return null
  }

  /** Loose match: same name; exits may differ (doors, hidden exits).
   *  Normalized so rooms captured with a glued prompt prefix still match. */
  private roomMatches(room: MapRoom, det: RoomDetection): boolean {
    return normalizeRoomName(room.name) === normalizeRoomName(det.name)
  }

  /** Heal a stored name that differs from the clean detected one. */
  private syncName(room: MapRoom, det: RoomDetection): void {
    if (room.name !== det.name && this.roomMatches(room, det)) {
      this.model.updateRoom(room.id, { name: det.name })
    }
  }

  private applyDetectedExits(room: MapRoom, det: RoomDetection): void {
    for (const e of det.exits) {
      const exit = this.model.ensureExit(room.id, e.dir)
      if (e.door) exit.door = true
    }
  }

  /** Add newly visible exits/doors to a known room without removing any. */
  private refreshExits(room: MapRoom, det: RoomDetection): void {
    this.applyDetectedExits(room, det)
  }

  private expirePending(): void {
    const now = Date.now()
    this.pending = this.pending.filter((p) => now - p.at < PENDING_TTL_MS)
  }
}
