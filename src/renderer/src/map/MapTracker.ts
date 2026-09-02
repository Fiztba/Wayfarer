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
import type { CaptureRule } from '../../../shared/types'
import type { MapModel } from './MapModel.ts'
import { RoomCapture, closedDoorName, isMoveFailure, isClosedDoorFailure } from './capture.ts'
import {
  DIR_DELTA,
  hashText,
  normalizeRoomName,
  OPPOSITE,
  wordToDirection,
  type Direction,
  type MapRoom,
  type RoomDetection,
  type ServerRoomInfo
} from './types.ts'

import type { TrackerControl } from './RemoteMap.ts'

export type TrackerMode = 'map' | 'follow' | 'off'

interface PendingMove {
  dir: Direction
  at: number
}

/**
 * One reading of where the player might be, while more than one is possible.
 *
 * A hypothesis survives only by continuing to predict MAPPED rooms correctly.
 * The moment it would step through an exit we have never walked, it stops
 * being distinguishable from "somewhere new" and is dropped -- which is what
 * keeps a stale reading from surviving forever on unexplored exits while the
 * player walks genuinely new ground.
 */
interface Hypothesis {
  /** Rooms this reading says we walked through, one per buffered step. */
  path: string[]
  /** Times it predicted a mapped room and the detection matched. */
  corroborations: number
}

/**
 * A run of moves we have deliberately not written down yet, because more than
 * one existing room explained the first one. Nothing reaches the map until it
 * resolves: a duplicate is recoverable, but a wrong link actively misleads.
 */
interface Speculation {
  /** Last room we were certain of. */
  anchorRoomId: string
  /** Rooms that also explained the first step, carried onto the room it
   *  creates if none of them turn out to be right. */
  rivals: string[]
  /** Observations since the anchor, replayed on commit. */
  steps: Array<{ dir: Direction | null; det: RoomDetection }>
  hypotheses: Hypothesis[]
}

/**
 * Safety valve only. Every surviving hypothesis has to corroborate on each
 * step, so the set shrinks or the player is genuinely walking terrain that
 * repeats -- a parapet wall resolves at its far end however long it is. This
 * bound exists so a pathological map cannot buffer without limit.
 */
const SPECULATION_CAP = 30

/**
 * Evidence needed before a room is merged away automatically. Scored so that
 * two independent signals are always required: a shared description is worth
 * 2, and so is each exit both rooms agree leads to the same place. One signal
 * alone never merges -- a bad merge is far harder to spot than a duplicate.
 */
const MERGE_CONFIDENCE = 3

/** Said when a room is created that an existing one could also have been. */
const MSG_DUPE = (name: string, count: number): string =>
  `Mapper: created a new "${name}" — ${count} rooms with identical name/exits will exist. If this is really one of them, merge (right-click) or use 🧹.`

const PENDING_CAP = 30
const PENDING_TTL_MS = 15_000
/** How long after a server id the room's own prose may still arrive. */
const SERVER_TEXT_WINDOW_MS = 3_000

export interface TrackerHost {
  /** This MUD's capture rule, read fresh so edits take effect immediately. */
  captureRule?(): CaptureRule | undefined
  /** Informational output to the session (system-style line). */
  info(text: string): void
  /** A movement command failed; closedDoor = blocked by a shut door, and
   *  doorName is what the MUD called it when it said so. */
  onMoveFailed?(dir: Direction, closedDoor: boolean, doorName?: string): void
}

export class MapTracker implements TrackerControl {
  mode: TrackerMode = 'map'
  lost = false
  currentRoomId: string | null = null

  /** Set while more than one room explains where we are (see Speculation). */
  speculation: Speculation | null = null
  /**
   * True once the MUD has identified a room over a protocol rather than the
   * mapper working it out from the screen. Worth surfacing: the two produce
   * very different maps, and until now there was no way to tell which one was
   * running short of inferring it from the results.
   */
  serverDriven = false
  /** True while draining a settled speculation back through the normal path,
   *  so replayed steps commit instead of opening a fresh speculation. */
  private replaying = false
  /** Guards against reconciliation re-entering itself through notify(). */
  private reconciling = false

  private model: MapModel
  private host: TrackerHost
  private capture = new RoomCapture()
  private pending: PendingMove[] = []
  private lastOpenDir: Direction | null = null
  private subs = new Set<() => void>()
  /**
   * When a server id last settled an arrival. The room text that follows on
   * such a MUD describes that same room, so a detection hard on its heels is
   * a refresh of it rather than a step of its own -- otherwise every queued
   * move would be spent twice, once by the id and once by the prose. Bounded
   * in time so an id with no prose behind it cannot swallow a later step.
   */
  private serverSettledAt = 0
  /** Room prose that arrived before the server's id for it, on a MUD that
   *  reports ids. It is applied to whichever room the id settles on. */
  private heldDetection: { det: RoomDetection; at: number } | null = null

  constructor(model: MapModel, host: TrackerHost) {
    this.model = model
    this.host = host
    // Resume where the player last was; the first room description after
    // login re-verifies (mismatch → unique-fingerprint snap or lost flag).
    const last = model.map.lastRoomId
    if (last && model.room(last)) this.currentRoomId = last
    model.subscribe(() => this.onModelChanged())
  }

  /**
   * The map can lose the room we are standing in from under us -- the player
   * deletes it, or merges it away by hand. A merge names its survivor, so
   * that is simply where we are now; anything else is a position we can no
   * longer vouch for.
   */
  private onModelChanged(): void {
    if (!this.currentRoomId || this.model.room(this.currentRoomId)) return
    const merges = this.model.map.merges
    const last = merges && merges.length > 0 ? merges[merges.length - 1] : null
    if (last && last.dropped.id === this.currentRoomId && this.model.room(last.keptId)) {
      this.currentRoomId = last.keptId
      this.notify()
      return
    }
    this.currentRoomId = null
    this.markLost('your room was removed from the map.')
  }

  /**
   * Forget everything in flight -- queued moves, an open bet, half-captured
   * text -- while keeping the position itself. For the moments the stream is
   * known to be discontinuous: a reconnect, a map swapped underneath us.
   */
  reset(): void {
    this.pending = []
    this.abandonSpeculation()
    this.serverSettledAt = 0
    this.heldDetection = null
    this.capture.reset()
    this.notify()
  }

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  private notify(): void {
    // Doubt is only worth revisiting once the position is settled; mid-guess
    // the evidence is not written down yet anyway.
    if (!this.reconciling && !this.speculation && this.mode === 'map') {
      this.reconciling = true
      try {
        this.reconcile()
      } finally {
        this.reconciling = false
      }
    }
    // Only ever persist a settled position. Restoring a bet on the next
    // session would hand it the confidence it never earned.
    if (!this.speculation) this.model.setLastRoom(this.currentRoomId)
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

  /** True while currentRoomId is a bet rather than a settled position. The map
   *  draws it differently, and Walker must not treat it as having arrived. */
  get speculative(): boolean {
    return this.speculation !== null
  }

  /** Drop a run of unwritten moves. Used whenever something authoritative
   *  overrides the guess -- a server room id, "I am here", a mode change. */
  private abandonSpeculation(): void {
    this.speculation = null
  }

  setMode(mode: TrackerMode): void {
    this.mode = mode
    this.abandonSpeculation()
    this.notify()
  }

  /** Manual re-sync: "I am here". Clears lost. */
  setCurrentRoom(roomId: string | null): void {
    this.abandonSpeculation()
    this.currentRoomId = roomId
    this.lost = false
    this.pending = []
    this.serverSettledAt = 0
    this.notify()
  }

  private markLost(reason: string): void {
    this.abandonSpeculation()
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
    this.capture.useRule(this.host.captureRule?.())
    this.expirePending()

    if (isMoveFailure(plain)) {
      const failed = this.pending.shift()
      if (failed) {
        const closedDoor = isClosedDoorFailure(plain)
        const named = closedDoor ? closedDoorName(plain) : null
        if (closedDoor && this.currentRoomId && !this.lost) {
          // Door in the way: record it (and a stub exit) without moving. The
          // refusal usually names the thing, and that name is what has to be
          // opened -- "grate", not "door".
          this.model.setDoor(this.currentRoomId, failed.dir, true, named ?? undefined)
        }
        this.host.onMoveFailed?.(failed.dir, closedDoor, named ?? undefined)
      }
      return
    }

    const detection = this.capture.feedLine(plain)
    if (!detection) return
    if (detection.serverId) {
      // The title line carried the server's own room id (staff roomflags),
      // so identity is settled the authoritative way before any dead
      // reckoning runs. All the prose has left to offer is exits and a
      // description for the room that settled on.
      this.onServerRoom({ serverId: detection.serverId, name: detection.name })
      this.serverSettledAt = 0
      const room = this.lost ? null : this.currentRoom
      if (room) {
        this.applyDetectedExits(room, detection)
        this.notify()
      }
      return
    }
    this.handleDetection(detection)
  }

  /** Structured room info from GMCP/MSDP — authoritative identity. */
  onServerRoom(info: ServerRoomInfo): void {
    if (this.mode === 'off') return
    const held = this.heldDetection
    this.heldDetection = null
    this.settleServerRoom(info)
    // Prose that got here first was describing this room; now that the id
    // has said which room that is, its exits and description can land.
    if (held && Date.now() - held.at < SERVER_TEXT_WINDOW_MS && !this.lost) {
      const room = this.currentRoom
      if (room && (!held.det.name || held.det.name === room.name)) {
        this.applyDetectedExits(room, held.det)
        this.notify()
      }
    }
  }

  private settleServerRoom(info: ServerRoomInfo): void {
    // An authoritative id settles identity outright, so any run of guesses is
    // moot. Only reachable on MUDs that report room ids, which are exactly the
    // MUDs that never had to guess in the first place.
    this.abandonSpeculation()
    this.serverDriven = true
    this.expirePending()
    const existing = this.model.findByServerId(info.serverId)
    // One arrival answers one move. The rest of the queue stays: a speedwalk
    // has several in flight, and each id that comes back pairs with the next.
    const move = this.pending.shift()
    this.serverSettledAt = Date.now()

    if (existing) {
      // Known room: link the path that got us here if it was unmapped. The
      // room we are already in is a look, whatever move was queued -- that
      // move evidently went nowhere, and linking a room to itself is worse
      // than forgetting it.
      const stayed = existing.id === this.currentRoomId
      if (move && !stayed && this.currentRoomId && this.mode === 'map' && !this.lost) {
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
      this.applyServerDetail(existing.id, info)
      this.notify()
      return
    }

    // Unknown server id — but it may describe a room we already drew from
    // text detection before ids were available. Adopting an existing room is
    // identification, not creation, so it is allowed in every mode.
    const from = move && !this.lost ? this.model.room(this.currentRoomId) : null
    const adopt = (roomId: string): void => {
      this.model.updateRoom(roomId, {
        serverId: info.serverId,
        ...(info.name ? { name: info.name } : {})
      })
      this.currentRoomId = roomId
      this.lost = false
      this.notify()
    }
    if (!move && !this.lost) {
      // Standing still (a look): this is the room we're in.
      const current = this.model.room(this.currentRoomId)
      if (current && !current.serverId && (!info.name || current.name === info.name)) {
        adopt(current.id)
        return
      }
    }
    if (from && move) {
      // We walked an exit that already points at an id-less room: same room.
      const viaId = this.model.exitOf(from, move.dir)?.to
      const via = viaId != null ? this.model.room(viaId) : null
      if (via && !via.serverId) {
        adopt(via.id)
        return
      }
    }

    if (this.mode !== 'map') {
      this.markLost('an unknown room (follow mode does not create rooms).')
      return
    }

    // Genuinely new room, authoritative id. Server area names are
    // authoritative for zones; otherwise inherit from the room we came from.
    const zoneId = info.areaName ? this.model.createZone(info.areaName) : this.zoneForNewRoom(from)
    // The server's own coordinates beat anything placement can infer -- they
    // are the layout the MUD believes in. Rooms sitting at the origin are
    // skipped: a MUD that has no coordinates for a room reports zeroes, and
    // taking those at face value piles the whole world on one square.
    const given = info.coords
    const usable =
      given &&
      Number.isFinite(given.x) &&
      Number.isFinite(given.y) &&
      Number.isFinite(given.z) &&
      !(given.x === 0 && given.y === 0 && given.z === 0)
    const pos = usable
      ? { x: given.x, y: given.y, z: given.z }
      : from && move
        ? this.model.placeFrom(from, move.dir)
        : { x: 0, y: 0, z: 0 }
    const room = this.model.createRoom({
      name: info.name ?? 'Unknown room',
      serverId: info.serverId,
      zoneId,
      ...pos
    })
    this.applyServerDetail(room.id, info)
    if (info.exits) {
      for (const [dirWord, destSid] of Object.entries(info.exits)) {
        const dir = wordToDirection(dirWord)
        if (!dir) continue
        const exit = this.model.ensureExit(room.id, dir)
        if (exit && destSid) {
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

  /** Doors and description reported alongside a room's identity. */
  private applyServerDetail(roomId: string, info: ServerRoomInfo): void {
    for (const dir of info.doors ?? []) this.model.setDoor(roomId, dir, true)
    if (info.description) this.model.addDescHash(roomId, hashText(info.description))
  }

  // ---- text-based dead reckoning ------------------------------------------

  /**
   * The committed path for one arrival: decide it and write it down. Draining
   * a settled speculation replays back through here, so a run of held moves
   * lands exactly as it would have had it never been in doubt.
   */
  private handleMove(current: MapRoom, dir: Direction, det: RoomDetection): void {
    const dirs = det.exits.map((e) => e.dir)
    const exit = this.model.exitOf(current, dir)
    if (exit?.to) {
      const dest = this.model.room(exit.to)
      if (dest && (this.couldBe(dest, det) || this.canLearn(dest, det))) {
        this.currentRoomId = dest.id
        this.refreshExits(dest, det)
        this.syncName(dest, det)
        this.notify()
        return
      }
      // The link may be a wrong guess (reverse links are heuristic, and MUD
      // geometry is often asymmetric). On solid evidence, correct the exit
      // and follow the player instead of going lost. The model has the last
      // word on whether the corrected link is even possible; a refusal there
      // is a contradiction we must not paper over by moving anyway.
      const fixes = this.candidatesFor(det)
      const fixed = this.pickArrival(fixes, current, dir)
      if (fixed && this.model.canLink(current.id, dir, fixed.id)) {
        this.model.linkRooms(current.id, dir, fixed.id, false)
        this.currentRoomId = fixed.id
        this.refreshExits(fixed, det)
        this.host.info(
          `Mapper corrected the ${dir} exit of "${current.name}" → "${fixed.name}".`
        )
        this.notify()
        return
      }
      this.markLost(
        `expected "${dest?.name ?? '?'}" ${dir} of "${current.name}" but saw "${det.name}".`
      )
      return
    }
    // Unmapped direction from a known room.
    //
    // Re-entry check: walking into a room we already know via an exit we
    // hadn't traversed yet. Identical room names are normal, so arrival
    // context disambiguates; only a still-unresolvable match creates.
    //
    // Identification runs in EVERY mode. Adopting a room already on the map
    // is identification, not creation -- the rule onServerRoom already
    // states. Follow mode used to go lost here without even looking, on
    // rooms it knew perfectly well.
    const candidates = this.candidatesFor(det)
    const known = this.pickArrival(candidates, current, dir)
    if (known) {
      if (this.mode === 'map') {
        // The reverse link is only added when the return path is unclaimed
        // or already ours: `s` from A landing in B does NOT imply `n` from
        // B returns to A.
        const back = this.model.exitOf(known, OPPOSITE[dir])
        const twoWay = back !== undefined && (back.to === null || back.to === current.id)
        this.model.linkRooms(current.id, dir, known.id, twoWay)
        this.refreshExits(known, det)
        this.syncName(known, det)
      }
      this.currentRoomId = known.id
      this.notify()
      return
    }
    if (this.mode !== 'map') {
      this.markLost(`moved ${dir} into unmapped territory.`)
      return
    }
    const others = candidates.filter((c) => c.id !== current.id)
    if (others.length > 0 && !this.replaying) {
      // Several rooms could be this one and nothing corroborates yet. Rather
      // than mint a twin on the spot, hold the move unwritten and let the next
      // few steps decide which reading survives.
      this.beginSpeculation(current, dir, det, others)
      return
    }
    if (others.length > 0) {
      this.host.info(MSG_DUPE(det.name, others.length + 1))
    }
    const made = this.createArrival(current, dir, det)
    // Carry the doubt with the room instead of forgetting it. If one of these
    // turns out to be the room we are really in, the reconciler merges it away
    // without ever asking.
    if (others.length > 0) this.model.setRivals(made.id, others.map((o) => o.id))
    this.currentRoomId = made.id
    this.notify()
    return
  }

  private handleDetection(det: RoomDetection): void {
    const dirs = det.exits.map((e) => e.dir)
    // Prose describing a room the server just identified is not a step.
    const current = this.model.room(this.currentRoomId)
    // ...but only prose that names that room. Under a speedwalk the next
    // room's text can land inside the window too, and that one is a step.
    const fromServer =
      Date.now() - this.serverSettledAt < SERVER_TEXT_WINDOW_MS &&
      !!current &&
      (!det.name || det.name === current.name)
    this.serverSettledAt = 0
    if (!fromServer && this.serverDriven && !this.speculation) {
      // On a MUD that reports ids, prose is never a step: the id for this
      // room is on its way (some MUDs print the room before they send the
      // packet), and stepping now would spend a queued move the id needs.
      this.heldDetection = { det, at: Date.now() }
      return
    }
    const move = fromServer ? undefined : this.pending.shift()

    if (this.speculation) {
      this.advanceSpeculation(move, det)
      return
    }

    if (this.lost) {
      // While lost we only re-anchor on an unambiguous fingerprint.
      const matches = this.candidatesFor(det)
      if (matches.length === 1) {
        this.currentRoomId = matches[0].id
        this.lost = false
        this.host.info(`Mapper re-synced at "${matches[0].name}".`)
        this.notify()
        return
      }
      // An empty map has no room to re-anchor onto, so being lost on one is a
      // dead end -- nothing would ever be mapped again, and the advice to
      // right-click your room is impossible when there are none. Start here.
      if (matches.length === 0 && this.mode === 'map' && this.isMapEmpty()) {
        this.lost = false
        this.seedFirstRoom(det)
      }
      return
    }

    if (move && current) {
      this.handleMove(current, move.dir, det)
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
        const matches = this.candidatesFor(det)
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
    const matches = this.candidatesFor(det)
    if (matches.length === 1) {
      this.currentRoomId = matches[0].id
      this.notify()
    } else if (matches.length === 0 && this.mode === 'map' && this.isMapEmpty()) {
      this.seedFirstRoom(det)
    }
    // Ambiguous or non-empty map: stay unanchored quietly until certain.
  }

  private isMapEmpty(): boolean {
    return Object.keys(this.map.rooms).length === 0
  }

  /** Begin a map here. Used both on a fresh map and to recover from being lost
   *  on one that has been emptied. */
  private seedFirstRoom(det: RoomDetection): void {
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

    // 3. exactly one NEIGHBOURING candidate, on the side we moved toward,
    //    holding an unclaimed exit back the way we came. A passage first
    //    walked from its far side has no back-link yet, and greedy placement
    //    may have drawn its room a cell off the one `dir` points at, so
    //    neither test above can fire -- that is how walking `nw` out of "A
    //    Moldy Tunnel" into the already-mapped "A Bright Tunnel" minted a twin
    //    instead of recognising it.
    //
    //    Both guards are load-bearing, and each has a test. Requiring the
    //    candidate to sit on the side we walked toward stops a twin BEHIND us
    //    capturing the arrival. Requiring it to be adjacent stops a twin
    //    further along our own heading capturing it -- that is the gap case,
    //    where the honest reading is an unmapped room in between, so it must
    //    still create. Horizontal moves only; up/down displacement has no
    //    equivalent and exact adjacency already covers it.
    const facing =
      dz !== 0
        ? []
        : others.filter((c) => {
            if (c.zoneId !== current.zoneId || c.z !== current.z) return false
            const ox = c.x - current.x
            const oy = c.y - current.y
            if (Math.max(Math.abs(ox), Math.abs(oy)) !== 1) return false
            if (ox * dx + oy * dy <= 0) return false
            const back = this.model.exitOf(c, OPPOSITE[dir])
            return back !== undefined && back.to === null
          })
    if (facing.length === 1) return facing[0]

    return null
  }

  // ---- reconciliation -----------------------------------------------------

  /**
   * Revisit rooms that had to be created while a rival might have been the
   * real one, now that more of the map is known.
   *
   * This is the half that matters while exploring. Holding a move back only
   * helps when the evidence arrives BEFORE anything is written, which needs
   * the walk to re-enter mapped ground. Evidence that turns up two rooms later
   * -- an exit that lands where a rival's own exit already goes, a description
   * seen again -- arrives too late for that, and is exactly what this consumes.
   */
  private reconcile(): void {
    for (const room of this.model.provisionalRooms()) {
      const alive: MapRoom[] = []
      let best: MapRoom | null = null
      let bestScore = 0
      for (const id of room.rivals ?? []) {
        const rival = this.model.room(id)
        if (!rival) continue
        const score = this.sameRoomScore(room, rival)
        if (score === null) continue // ruled out for good
        alive.push(rival)
        if (score > bestScore) {
          bestScore = score
          best = rival
        }
      }
      this.model.setRivals(
        room.id,
        alive.map((r) => r.id)
      )
      if (alive.length !== 1 || !best || bestScore < MERGE_CONFIDENCE) continue
      const name = best.name
      const standingHere = this.currentRoomId === room.id
      // The older room survives: it carries the links and history.
      this.model.mergeRooms(best.id, room.id)
      if (standingHere) this.currentRoomId = best.id
      this.host.info(
        `Mapper: "${name}" turned out to be a room already on the map — merged the copy away. #unmerge puts it back.`
      )
    }
  }

  /**
   * How much says these two are the same room, or null once something says
   * they cannot be. Descriptions rule out outright, because two rooms that
   * genuinely look different are genuinely different; exits agreeing about
   * where they lead is corroboration, exits disagreeing is a contradiction.
   */
  private sameRoomScore(a: MapRoom, b: MapRoom): number | null {
    const ah = a.descHashes ?? []
    const bh = b.descHashes ?? []
    let score = 0
    if (ah.length > 0 && bh.length > 0) {
      if (!ah.some((h) => bh.includes(h))) return null
      score += 2
    }
    for (const ea of a.exits) {
      if (!ea.dir || !ea.to) continue
      const eb = b.exits.find((e) => e.dir === ea.dir)
      if (!eb || !eb.to) continue
      if (eb.to === ea.to) score += 2
      else if (ea.to !== b.id && eb.to !== a.id) return null
    }
    return score
  }

  // ---- speculation --------------------------------------------------------

  /** Start holding moves back because more than one room explains this one. */
  private beginSpeculation(
    anchor: MapRoom,
    dir: Direction,
    det: RoomDetection,
    candidates: MapRoom[]
  ): void {
    this.speculation = {
      anchorRoomId: anchor.id,
      rivals: candidates.map((c) => c.id),
      steps: [{ dir, det }],
      hypotheses: candidates.map((c) => ({ path: [c.id], corroborations: 0 }))
    }
    // Show a bet only where one is genuinely plausible; otherwise hold at the
    // anchor. A wrong bet draws the player teleporting, which is worse than
    // admitting we are unsure.
    const bet = this.plausibleBet(candidates, anchor, dir)
    if (bet) this.currentRoomId = bet.id
    this.notify()
  }

  /**
   * Which candidate is worth showing while unsure. Deliberately narrow: a
   * neighbour on the side we actually walked toward. A twin behind us would
   * draw the player moving backwards, and one further along our own heading is
   * the gap case, where the honest reading is an unmapped room in between.
   */
  private plausibleBet(candidates: MapRoom[], from: MapRoom, dir: Direction): MapRoom | null {
    const [dx, dy, dz] = DIR_DELTA[dir]
    for (const c of candidates) {
      if (c.zoneId !== from.zoneId) continue
      if (dz !== 0) {
        if (c.z === from.z + dz) return c
        continue
      }
      if (c.z !== from.z) continue
      const ox = c.x - from.x
      const oy = c.y - from.y
      if (Math.max(Math.abs(ox), Math.abs(oy)) !== 1) continue
      if (ox * dx + oy * dy > 0) return c
    }
    return null
  }

  /**
   * Fold one more observation into the open readings.
   *
   * A reading survives only by predicting a room already on the map and being
   * right. Stepping through an exit we have never walked makes it no better
   * than "somewhere new", so it is dropped rather than carried indefinitely --
   * that is what stops a stale reading surviving on unexplored exits forever.
   */
  private advanceSpeculation(move: PendingMove | undefined, det: RoomDetection): void {
    const spec = this.speculation
    if (!spec) return
    spec.steps.push({ dir: move?.dir ?? null, det })

    const survivors: Hypothesis[] = []
    for (const h of spec.hypotheses) {
      const at = this.model.room(h.path[h.path.length - 1])
      if (!at) continue
      if (!move) {
        // A look rather than a move: this reading has to describe the room it
        // claims we are standing in.
        if (this.couldBe(at, det)) {
          survivors.push({ path: [...h.path, at.id], corroborations: h.corroborations + 1 })
        }
        continue
      }
      const exit = this.model.exitOf(at, move.dir)
      if (!exit || exit.to === null) continue
      const dest = this.model.room(exit.to)
      if (!dest || !this.couldBe(dest, det)) continue
      survivors.push({ path: [...h.path, dest.id], corroborations: h.corroborations + 1 })
    }
    spec.hypotheses = survivors

    if (survivors.length === 1) {
      this.settleOn(survivors[0])
      return
    }
    if (survivors.length === 0 || spec.steps.length >= SPECULATION_CAP) {
      this.settleAsNew()
      return
    }
    this.currentRoomId = survivors[0].path[survivors[0].path.length - 1]
    this.notify()
  }

  /** One reading left: write the path it describes, backfilling every room it
   *  walked through on the way. */
  private settleOn(h: Hypothesis): void {
    const spec = this.speculation
    if (!spec) return
    this.speculation = null
    let from = this.model.room(spec.anchorRoomId)
    for (let i = 0; i < spec.steps.length; i++) {
      const step = spec.steps[i]
      const room = this.model.room(h.path[i])
      if (!room) continue
      if (from && step.dir) this.adoptArrival(from, step.dir, room, step.det)
      else {
        this.refreshExits(room, step.det)
        this.syncName(room, step.det)
      }
      from = room
    }
    this.currentRoomId = h.path[h.path.length - 1]
    this.lost = false
    if (spec.steps.length > 1) {
      this.host.info(
        `Mapper: settled on "${this.currentRoom?.name ?? '?'}" — ${spec.steps.length} rooms confirmed, none duplicated.`
      )
    }
    this.notify()
  }

  /** No reading survived: the player really is somewhere new, so replay the
   *  held moves as ordinary mapping. */
  private settleAsNew(): void {
    const spec = this.speculation
    if (!spec) return
    this.speculation = null
    this.host.info(MSG_DUPE(spec.steps[0].det.name, spec.rivals.length + 1))
    const anchor = this.model.room(spec.anchorRoomId)
    if (!anchor) return
    // Step one IS the ambiguity, pinned to the reading that won: a new room.
    // Every later step drains back through the ordinary committed path so it
    // still gets full identification -- which is how the room belonging in a
    // gap gets created and the twin beyond it gets recognised rather than
    // duplicated a second time.
    const first = spec.steps[0]
    if (first.dir) {
      const made = this.createArrival(anchor, first.dir, first.det)
      this.model.setRivals(made.id, spec.rivals)
      this.currentRoomId = made.id
    } else {
      this.currentRoomId = anchor.id
    }
    this.replaying = true
    try {
      for (const step of spec.steps.slice(1)) {
        const at = this.model.room(this.currentRoomId)
        if (!at) break
        if (step.dir) this.handleMove(at, step.dir, step.det)
        else {
          this.refreshExits(at, step.det)
          this.syncName(at, step.det)
        }
      }
    } finally {
      this.replaying = false
    }
    this.notify()
  }

  /** Adopt a room already on the map as the arrival, linking how we got here.
   *  The reverse link is only added when the return path is unclaimed or
   *  already ours: `s` from A landing in B does NOT imply `n` from B is A. */
  private adoptArrival(from: MapRoom, dir: Direction, known: MapRoom, det: RoomDetection): void {
    const back = this.model.exitOf(known, OPPOSITE[dir])
    const twoWay = back !== undefined && (back.to === null || back.to === from.id)
    this.model.linkRooms(from.id, dir, known.id, twoWay)
    this.refreshExits(known, det)
    this.syncName(known, det)
  }

  /** Create the room we just walked into and link it from where we came. */
  private createArrival(from: MapRoom, dir: Direction, det: RoomDetection): MapRoom {
    const pos = this.model.placeFrom(from, dir)
    const room = this.model.createRoom({
      name: det.name,
      ...pos,
      zoneId: this.zoneForNewRoom(from)
    })
    this.applyDetectedExits(room, det)
    // Two-way link only if the new room reports the return exit.
    const hasReturn = det.exits.some((e) => e.dir === OPPOSITE[dir])
    this.model.linkRooms(from.id, dir, room.id, hasReturn)
    return room
  }

  /**
   * Could this room be the one just described?
   *
   * The name must match, and any descriptions already recorded for the room
   * must include the one in front of us. Name alone is far too weak exactly
   * where it gets leaned on hardest: a MUD with three rooms called "A Long
   * Water-filled Tunnel" satisfies a name test with any of them, which is how
   * a reading survived that should have died and a north exit was written to
   * the room drawn SOUTH. A room with no descriptions recorded yet cannot be
   * ruled out this way, so this stays permissive until evidence exists.
   */
  /** Rooms that could be the one described, with any whose recorded
   *  description contradicts it removed. Every identity decision goes through
   *  here, so a room that demonstrably looks different is never a candidate --
   *  not even when a back-link vouches for it. */
  private candidatesFor(det: RoomDetection): MapRoom[] {
    const dirs = det.exits.map((e) => e.dir)
    return this.model.findByFingerprint(det.name, dirs).filter((r) => this.couldBe(r, det))
  }

  private couldBe(room: MapRoom, det: RoomDetection): boolean {
    if (!this.roomMatches(room, det)) return false
    const known = room.descHashes ?? []
    if (det.descHash && known.length > 0) return known.includes(det.descHash)
    return true
  }

  /**
   * Whether a description this room has not shown before can be taken as a
   * second face of it. Only asked when an exit we walked already led here,
   * which is evidence couldBe does not have: a room reached by its own link
   * that merely looks different today (night, rain) is still that room, and
   * refusing to learn would leave it forever one description short.
   *
   * Only while the name is unique on the map. Where names repeat, the
   * description is the one thing that tells the rooms apart, and a stored
   * link is exactly what cannot be trusted there -- the water-filled tunnels
   * had a north exit wired to the room drawn south, and learning would have
   * let the wrong room quietly absorb the right room's description.
   */
  private canLearn(room: MapRoom, det: RoomDetection): boolean {
    if (!det.descHash || !this.roomMatches(room, det)) return false
    return !Object.values(this.map.rooms).some(
      (r) => r.id !== room.id && this.roomMatches(r, det)
    )
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
    // Every path that applies a detection to a room comes through here, the
    // very first room of a fresh map included.
    this.model.addDescHash(room.id, det.descHash)
    for (const e of det.exits) {
      const exit = this.model.ensureExit(room.id, e.dir)
      if (!exit) continue
      if (e.door) exit.door = true
      // Some MUDs name the room an exit leads to before it is walked. Worth
      // keeping: it shows in the exits panel, and it is a check on arrival.
      if (e.destName) exit.destName = e.destName
    }
  }

  /** Add newly visible exits/doors to a known room without removing any, and
   *  record what it looked like -- the only evidence that tells two rooms with
   *  the same name and exits apart while exploring. */
  private refreshExits(room: MapRoom, det: RoomDetection): void {
    this.applyDetectedExits(room, det)
  }

  private expirePending(): void {
    const now = Date.now()
    this.pending = this.pending.filter((p) => now - p.at < PENDING_TTL_MS)
  }
}
