/**
 * MapModel — owns a MudMap, applies all mutations, notifies subscribers,
 * and debounces persistence through an injected saver (DOM-free, testable).
 */
import { relayoutZone, type RelayoutResult } from './relayout.ts'
import {
  emptyMap,
  OPPOSITE,
  DIR_DELTA,
  fingerprintOf,
  normalizeRoomName,
  type Direction,
  type MapExit,
  type MapRoom,
  type MergeRecord,
  type MudMap,
  type RelayoutRecord,
  type PopoutBounds
} from './types.ts'

const SAVE_DEBOUNCE_MS = 1500
/** A walk that never pauses would otherwise never be saved at all: the
 *  debounce keeps being pushed back by the next room. Past this age a save
 *  goes out regardless, so a crash mid-exploration costs seconds, not the
 *  session. */
const SAVE_MAX_WAIT_MS = 10_000
/** How many descriptions to remember per room. Weather and daylight give one
 *  room a handful; beyond that we are hoarding, not identifying. */
const MAX_DESC_HASHES = 6
/** How many automatic merges stay undoable. */
const MERGE_HISTORY = 20

function uuid(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Whatever came off disk, made safe to work on. The file is written by us but
 * lives where anything can edit it; a hand-mangled one must not take the whole
 * mapper down at construction, with no map at all and no way to say why. A map
 * whose rooms are recognisable keeps them and grows any list it lost; one
 * whose rooms are not is started over. The first save then backs up the old
 * file, so nothing is silently gone.
 */
function normalizeMap(raw: unknown): { map: MudMap; warning: string | null } {
  if (raw === null || raw === undefined) return { map: emptyMap(), warning: null }
  if (!isRecord(raw) || !isRecord(raw.rooms)) {
    return { map: emptyMap(), warning: 'the map file was not a map; starting a new one' }
  }
  const map = raw as unknown as MudMap
  if (!Array.isArray(map.zones)) map.zones = []
  if (!Array.isArray(map.waypoints)) map.waypoints = []
  if (typeof map.lastRoomId !== 'string') map.lastRoomId = null
  if (map.merges !== undefined && !Array.isArray(map.merges)) delete map.merges
  return { map, warning: null }
}

export class MapModel {
  map: MudMap
  activeZoneId: string
  /** Set when the map given at construction could not be used as it was. The
   *  owner is expected to show it; the model has no voice of its own. */
  readonly loadWarning: string | null
  /**
   * Armed by #zone / the zone dropdown: the NEXT room created goes here, after
   * which new rooms inherit the zone of the room they were entered from.
   */
  pendingZoneId: string | null = null

  private saver: (map: MudMap) => void
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  /** When the map last went to the saver, or was loaded. */
  private savedAt = Date.now()
  /** Changed since it last went to the saver. */
  private dirty = false
  private subs = new Set<() => void>()
  version = 0

  constructor(initial: MudMap | null, saver: (map: MudMap) => void) {
    const loaded = normalizeMap(initial)
    this.map = loaded.map
    this.loadWarning = loaded.warning
    this.saver = saver
    if (this.map.zones.length === 0) {
      this.map.zones.push({ id: uuid(), name: 'Unsorted' })
    }
    this.activeZoneId = this.map.zones[0].id
  }

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  getVersion = (): number => this.version

  protected touch(): void {
    this.version++
    this.dirty = true
    for (const fn of this.subs) fn()
    if (Date.now() - this.savedAt >= SAVE_MAX_WAIT_MS) {
      this.flush()
      return
    }
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, SAVE_DEBOUNCE_MS)
  }

  private saveNow(): void {
    this.savedAt = Date.now()
    this.dirty = false
    this.saver(this.map)
  }

  /** Save at once if anything is waiting. The owner calls this when the
   *  session ends, since the debounce cannot outlive the window. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (this.dirty) this.saveNow()
  }

  // ---- zones --------------------------------------------------------------

  createZone(name: string, id?: string): string {
    const existing = this.map.zones.find((z) => z.name.toLowerCase() === name.toLowerCase())
    if (existing) return existing.id
    const zoneId = id ?? uuid()
    this.map.zones.push({ id: zoneId, name })
    this.touch()
    return zoneId
  }

  /** Arm/disarm the pending zone (see pendingZoneId). */
  setPendingZone(id: string | null): void {
    this.pendingZoneId = id
  }

  renameZone(id: string, name: string): void {
    const zone = this.map.zones.find((z) => z.id === id)
    if (zone) {
      zone.name = name
      this.touch()
    }
  }

  /** Delete a zone and every room in it (waypoints and links cleaned up). */
  deleteZone(id: string): number {
    const roomIds = Object.values(this.map.rooms)
      .filter((r) => r.zoneId === id)
      .map((r) => r.id)
    for (const rid of roomIds) this.deleteRoomInternal(rid)
    this.map.zones = this.map.zones.filter((z) => z.id !== id)
    if (this.map.zones.length === 0) this.map.zones.push({ id: uuid(), name: 'Unsorted' })
    if (!this.map.zones.some((z) => z.id === this.activeZoneId)) {
      this.activeZoneId = this.map.zones[0].id
    }
    if (this.pendingZoneId === id) this.pendingZoneId = null
    this.touch()
    return roomIds.length
  }

  /** Reassign rooms to a zone; coordinates and links are untouched. */
  moveRoomsToZone(roomIds: string[], zoneId: string): number {
    if (!this.map.zones.some((z) => z.id === zoneId)) return 0
    let moved = 0
    for (const id of roomIds) {
      const room = this.map.rooms[id]
      if (room && room.zoneId !== zoneId) {
        room.zoneId = zoneId
        moved++
      }
    }
    if (moved > 0) this.touch()
    return moved
  }

  setActiveZone(id: string): void {
    if (this.map.zones.some((z) => z.id === id)) {
      this.activeZoneId = id
      this.touch()
    }
  }

  // ---- rooms --------------------------------------------------------------

  room(id: string | null | undefined): MapRoom | null {
    return id ? (this.map.rooms[id] ?? null) : null
  }

  createRoom(partial: Partial<MapRoom> & { name: string }): MapRoom {
    const room: MapRoom = {
      id: partial.id ?? uuid(),
      serverId: partial.serverId,
      name: partial.name,
      zoneId: partial.zoneId ?? this.activeZoneId,
      x: partial.x ?? 0,
      y: partial.y ?? 0,
      z: partial.z ?? 0,
      color: partial.color,
      notes: partial.notes,
      descHashes: partial.descHashes,
      rivals: partial.rivals,
      exits: partial.exits ?? []
    }
    this.map.rooms[room.id] = room
    this.touch()
    return room
  }

  updateRoom(id: string, patch: Partial<MapRoom>): void {
    const room = this.map.rooms[id]
    if (!room) return
    Object.assign(room, patch, { id: room.id })
    this.touch()
  }

  moveRoom(id: string, x: number, y: number, z?: number): void {
    const room = this.map.rooms[id]
    if (!room) return
    room.x = x
    room.y = y
    if (z !== undefined) room.z = z
    this.touch()
  }

  deleteRoom(id: string): void {
    this.deleteRoomInternal(id)
    this.touch()
  }

  /** Remember the player's confirmed position (persisted with the map). */
  setLastRoom(id: string | null): void {
    if (this.map.lastRoomId === id) return
    this.map.lastRoomId = id
    this.touch()
  }

  /**
   * Record what a room looked like. Kept as a set: one room has several
   * descriptions across weather and daylight, so a match is identity while a
   * single mismatch proves nothing on its own.
   */
  addDescHash(roomId: string, hash: string | undefined): void {
    if (!hash) return
    const room = this.map.rooms[roomId]
    if (!room) return
    const seen = room.descHashes ?? []
    if (seen.includes(hash)) return
    room.descHashes = [...seen, hash].slice(-MAX_DESC_HASHES)
    this.touch()
  }

  /** Rooms this one might be a copy of; empty clears the doubt. */
  setRivals(roomId: string, rivals: string[]): void {
    const room = this.map.rooms[roomId]
    if (!room) return
    const next = rivals.filter((id) => id !== roomId && this.map.rooms[id])
    const cur = room.rivals ?? []
    if (cur.length === next.length && next.every((id) => cur.includes(id))) return
    if (next.length === 0) delete room.rivals
    else room.rivals = next
    this.touch()
  }

  /** Rooms still carrying doubt about which room they really are. */
  provisionalRooms(): MapRoom[] {
    return Object.values(this.map.rooms).filter((r) => (r.rivals?.length ?? 0) > 0)
  }

  /**
   * Put back the most recent merge. Merging is destructive and a bad one is
   * far harder to notice than a duplicate, so nothing may merge automatically
   * without this being possible.
   */
  /**
   * Lay a zone out again from its links (see relayout.ts). Applies only
   * when the result lies less than what is there, unless forced; the
   * previous coordinates are kept so it can be undone either way.
   */
  tidyZone(zoneId: string, anchorId?: string | null, force = false): RelayoutResult & { applied: boolean } {
    const result = relayoutZone(this.map, zoneId, anchorId)
    let moves = result.moves
    if (Object.keys(moves).length === 0 && force) {
      // Nothing better was found, but the caller wants the best attempt
      // anyway: run it against a scrambled copy so the attempt is returned
      // as moves rather than declined.
      const scrambled = structuredClone(this.map)
      Object.values(scrambled.rooms).forEach((r, i) => {
        if (r.zoneId === zoneId) r.x += 1000 * (i + 1)
      })
      const forced = relayoutZone(scrambled, zoneId, anchorId)
      moves = {}
      for (const r of Object.values(this.map.rooms)) {
        if (r.zoneId !== zoneId) continue
        const p = forced.moves[r.id] ?? scrambled.rooms[r.id]
        if (p.x !== r.x || p.y !== r.y || p.z !== r.z) moves[r.id] = { x: p.x, y: p.y, z: p.z }
      }
      result.after = forced.attempted
    }
    const ids = Object.keys(moves)
    if (ids.length === 0) return { ...result, applied: false }
    const before: RelayoutRecord['before'] = {}
    for (const id of ids) {
      const room = this.map.rooms[id]
      if (!room) continue
      before[id] = [room.x, room.y, room.z]
      room.x = moves[id].x
      room.y = moves[id].y
      room.z = moves[id].z
    }
    this.map.relayout = { zoneId, before }
    this.touch()
    return { ...result, moves, applied: true }
  }

  /** Put every room the last tidy moved back. Returns how many moved back. */
  undoTidy(): number | null {
    const rec = this.map.relayout
    if (!rec) return null
    let n = 0
    for (const [id, [x, y, z]] of Object.entries(rec.before)) {
      const room = this.map.rooms[id]
      if (!room) continue
      room.x = x
      room.y = y
      room.z = z
      n++
    }
    delete this.map.relayout
    this.touch()
    return n
  }

  undoLastMerge(): MapRoom | null {
    const merges = this.map.merges
    if (!merges || merges.length === 0) return null
    const rec = merges[merges.length - 1]
    const keep = this.map.rooms[rec.keptId]
    if (!keep) return null
    const restored = structuredClone(rec.dropped)
    this.map.rooms[restored.id] = restored
    keep.exits = structuredClone(rec.keptExits)
    for (const back of rec.inbound) {
      const room = this.map.rooms[back.roomId]
      const exit = room?.exits.find((e) =>
        back.dir ? e.dir === back.dir : e.command === back.command
      )
      if (exit && exit.to === rec.keptId) exit.to = restored.id
    }
    if (rec.lastRoomId !== undefined) this.map.lastRoomId = rec.lastRoomId
    this.map.merges = merges.slice(0, -1)
    this.touch()
    return restored
  }

  /** Remember whether the map pane was open, so the next session on this MUD
   *  starts the way this one was left. */
  setPaneOpen(open: boolean): void {
    if (this.map.paneOpen === open) return
    this.map.paneOpen = open
    this.touch()
  }

  /** Remember where the pop-out map window sits, or null once it is closed. */
  setPopout(bounds: PopoutBounds | null): void {
    const cur = this.map.popout ?? null
    if (cur === null && bounds === null) return
    if (
      cur &&
      bounds &&
      cur.x === bounds.x &&
      cur.y === bounds.y &&
      cur.width === bounds.width &&
      cur.height === bounds.height
    ) {
      return
    }
    this.map.popout = bounds
    this.touch()
  }

  private deleteRoomInternal(id: string): void {
    delete this.map.rooms[id]
    if (this.map.lastRoomId === id) this.map.lastRoomId = null
    for (const room of Object.values(this.map.rooms)) {
      for (const exit of room.exits) {
        if (exit.to === id) exit.to = null
      }
    }
    this.map.waypoints = this.map.waypoints.filter((w) => w.roomId !== id)
  }

  /** Merge dropId into keepId: redirect inbound links, absorb exits, delete. */
  mergeRooms(keepId: string, dropId: string): void {
    const keep = this.map.rooms[keepId]
    const drop = this.map.rooms[dropId]
    if (!keep || !drop || keepId === dropId) return
    const record: MergeRecord = {
      keptId: keepId,
      dropped: structuredClone(drop),
      keptExits: structuredClone(keep.exits),
      inbound: [],
      lastRoomId: this.map.lastRoomId ?? null
    }
    for (const room of Object.values(this.map.rooms)) {
      for (const exit of room.exits) {
        if (exit.to === dropId) {
          record.inbound.push({ roomId: room.id, dir: exit.dir, command: exit.command })
          exit.to = keepId
        }
      }
    }
    for (const exit of drop.exits) {
      const clash = keep.exits.find((e) =>
        exit.dir ? e.dir === exit.dir : e.command === exit.command
      )
      if (!clash) keep.exits.push(exit)
      else if (clash.to === null && exit.to !== null) clash.to = exit.to === dropId ? keepId : exit.to
    }
    // Two rooms that were neighbours now have exits into each other that
    // both land on the keeper. A room leading to itself is nonsense the
    // pathfinder would happily walk in circles on; leave those unexplored.
    for (const exit of keep.exits) {
      if (exit.to === keepId || exit.to === dropId) exit.to = null
    }
    if (!keep.serverId && drop.serverId) keep.serverId = drop.serverId
    for (const w of this.map.waypoints) {
      if (w.roomId === dropId) w.roomId = keepId
    }
    if (this.map.lastRoomId === dropId) this.map.lastRoomId = keepId
    // Descriptions are evidence; the survivor keeps everything either saw.
    const hashes = [...(keep.descHashes ?? [])]
    for (const h of drop.descHashes ?? []) if (!hashes.includes(h)) hashes.push(h)
    if (hashes.length > 0) keep.descHashes = hashes.slice(-MAX_DESC_HASHES)
    // The doubt is settled for everyone who pointed at either room.
    for (const room of Object.values(this.map.rooms)) {
      if (room.rivals?.includes(dropId)) {
        const left = room.rivals.filter((id) => id !== dropId && id !== room.id)
        if (left.length === 0) delete room.rivals
        else room.rivals = left
      }
    }
    delete keep.rivals
    delete this.map.rooms[dropId]
    this.map.merges = [...(this.map.merges ?? []), record].slice(-MERGE_HISTORY)
    this.touch()
  }

  // ---- exits & doors ------------------------------------------------------

  exitOf(room: MapRoom, dir: Direction): MapExit | undefined {
    return room.exits.find((e) => e.dir === dir)
  }

  /** The exit in that direction, created unexplored if the room lacks one.
   *  Null for a room that is not on the map: ids arrive from the pop-out and
   *  from stale menus, and either can name a room that has since gone. */
  ensureExit(roomId: string, dir: Direction): MapExit | null {
    const room = this.map.rooms[roomId]
    if (!room) return null
    let exit = room.exits.find((e) => e.dir === dir)
    if (!exit) {
      exit = { dir, to: null, door: false }
      room.exits.push(exit)
      this.touch()
    }
    return exit
  }

  /**
   * Two rooms cannot both lie in the same direction from one another: if north
   * from B is A, then north from A cannot be B. Real MUD geometry effectively
   * never does this, and accepting it once is unrecoverable -- the mapper then
   * trusts the link forever. On a live map this wired a north exit to the room
   * drawn to the SOUTH, and every subsequent walk north followed it back.
   */
  private wouldContradictDirection(fromId: string, dir: Direction, toId: string): boolean {
    if (fromId === toId) return false
    const dest = this.map.rooms[toId]
    if (!dest) return false
    return dest.exits.some((e) => e.dir === dir && e.to === fromId)
  }

  /** Add an unexplored exit by hand. A room created by hand has none at all,
   *  which left nothing in the exits panel to edit or link. */
  addExit(roomId: string, dir: Direction): void {
    this.ensureExit(roomId, dir)
  }

  /** Whether linkRooms would accept this link. Callers that announce a
   *  correction ask first, so nothing is said about a link never made. */
  canLink(fromId: string, dir: Direction, toId: string): boolean {
    return (
      this.map.rooms[fromId] !== undefined &&
      this.map.rooms[toId] !== undefined &&
      !this.wouldContradictDirection(fromId, dir, toId)
    )
  }

  /** Link from→to via dir; adds the reverse link when addReverse.
   *  Refuses a link that would make the same direction reciprocal. */
  linkRooms(fromId: string, dir: Direction, toId: string, addReverse: boolean): void {
    if (!this.canLink(fromId, dir, toId)) return
    const exit = this.ensureExit(fromId, dir)
    if (!exit) return
    let changed = exit.to !== toId
    exit.to = toId
    if (addReverse) {
      const back = this.ensureExit(toId, OPPOSITE[dir])
      if (back) {
        if (back.to === null) {
          back.to = fromId
          changed = true
        }
        // A door is a property of the passage — mirror it onto both faces.
        if (exit.door && !back.door) {
          back.door = true
          back.doorName ??= exit.doorName
          changed = true
        } else if (back.door && !exit.door) {
          exit.door = true
          exit.doorName ??= back.doorName
          changed = true
        }
      }
    }
    // Re-walking a mapped passage confirms it and changes nothing; a touch
    // here would save, redraw and reconcile on every step of a known route.
    if (changed) this.touch()
  }

  addSpecialExit(fromId: string, command: string, toId: string | null): void {
    const room = this.map.rooms[fromId]
    if (!room) return
    room.exits.push({ dir: null, command, to: toId, door: false })
    this.touch()
  }

  removeExit(roomId: string, exit: MapExit): void {
    const room = this.map.rooms[roomId]
    if (!room) return
    room.exits = room.exits.filter((e) => e !== exit)
    this.touch()
  }

  /** Index-based exit edits (serializable — usable over the pop-out RPC). */
  setExitAt(roomId: string, index: number, patch: Partial<MapExit>): void {
    const exit = this.map.rooms[roomId]?.exits[index]
    if (!exit) return
    Object.assign(exit, patch)
    this.touch()
  }

  removeExitAt(roomId: string, index: number): void {
    const room = this.map.rooms[roomId]
    if (!room || index < 0 || index >= room.exits.length) return
    room.exits.splice(index, 1)
    this.touch()
  }

  setDoor(roomId: string, dir: Direction, door: boolean, doorName?: string): void {
    const exit = this.ensureExit(roomId, dir)
    if (!exit) return
    let changed = false
    const setOn = (e: MapExit): void => {
      if (e.door !== door) {
        e.door = door
        changed = true
      }
      if (doorName !== undefined && e.doorName !== doorName) {
        e.doorName = doorName
        changed = true
      }
    }
    setOn(exit)
    // Mirror onto the reverse side if linked — doors exist on both faces.
    if (exit.to) {
      const back = this.map.rooms[exit.to]?.exits.find(
        (e) => e.dir === OPPOSITE[dir] && (e.to === roomId || e.to === null)
      )
      if (back) setOn(back)
    }
    // Every Room.Info repeats the doors it has; only news is worth a save.
    if (changed) this.touch()
  }

  // ---- placement ----------------------------------------------------------

  /** Suggest coordinates for a new room stepped dir from an existing room.
   *  Never merges on collision — probes further, then offsets, then overlaps. */
  placeFrom(from: MapRoom, dir: Direction): { x: number; y: number; z: number } {
    const [dx, dy, dz] = DIR_DELTA[dir]
    const occupied = (x: number, y: number, z: number) =>
      Object.values(this.map.rooms).some(
        (r) => r.zoneId === from.zoneId && r.x === x && r.y === y && r.z === z
      )
    for (let k = 1; k <= 6; k++) {
      const x = from.x + dx * k
      const y = from.y + dy * k
      const z = from.z + dz * k
      if (!occupied(x, y, z)) return { x, y, z }
    }
    // Perpendicular nudges, then give up and overlap (graph stays correct).
    const base = { x: from.x + dx, y: from.y + dy, z: from.z + dz }
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
      if (!occupied(base.x + ox, base.y + oy, base.z)) {
        return { x: base.x + ox, y: base.y + oy, z: base.z }
      }
    }
    return base
  }

  // ---- lookups ------------------------------------------------------------

  findByServerId(serverId: string): MapRoom | null {
    return Object.values(this.map.rooms).find((r) => r.serverId === serverId) ?? null
  }

  /** Groups of rooms sharing an identical fingerprint (likely duplicates —
   *  or a genuine maze; merging is always the user's call). */
  findDuplicateGroups(): MapRoom[][] {
    const groups = new Map<string, MapRoom[]>()
    for (const room of Object.values(this.map.rooms)) {
      const fp = fingerprintOf(
        room.name,
        room.exits.filter((e) => e.dir !== null).map((e) => e.dir as Direction)
      )
      const arr = groups.get(fp)
      if (arr) arr.push(room)
      else groups.set(fp, [room])
    }
    return [...groups.values()]
      .filter((g) => g.length > 1)
      .sort((a, b) => a[0].name.localeCompare(b[0].name))
  }

  /** How many exits anywhere point at this room. */
  inboundLinkCount(roomId: string): number {
    let n = 0
    for (const room of Object.values(this.map.rooms)) {
      for (const exit of room.exits) if (exit.to === roomId) n++
    }
    return n
  }

  findByFingerprint(name: string, dirs: Direction[]): MapRoom[] {
    const target = normalizeRoomName(name)
    const detected = new Set(dirs)
    return Object.values(this.map.rooms).filter((room) => {
      if (normalizeRoomName(room.name) !== target) return false
      // Containment, not equality: hidden exits learned by walking make the
      // stored exits a SUPERSET of the exits line; a newly revealed exit makes
      // them a subset. Either way it's still the same room.
      const stored = room.exits
        .filter((e) => e.dir !== null)
        .map((e) => e.dir as Direction)
      const storedSet = new Set(stored)
      return (
        [...detected].every((d) => storedSet.has(d)) ||
        stored.every((d) => detected.has(d))
      )
    })
  }

  roomsInZone(zoneId: string): MapRoom[] {
    return Object.values(this.map.rooms).filter((r) => r.zoneId === zoneId)
  }

  // ---- waypoints ----------------------------------------------------------

  setWaypoint(name: string, roomId: string): void {
    const clean = name.trim()
    if (!clean) return
    const existing = this.map.waypoints.find(
      (w) => w.name.toLowerCase() === clean.toLowerCase()
    )
    if (existing) existing.roomId = roomId
    else this.map.waypoints.push({ name: clean, roomId })
    this.touch()
  }

  removeWaypoint(name: string): boolean {
    const before = this.map.waypoints.length
    this.map.waypoints = this.map.waypoints.filter(
      (w) => w.name.toLowerCase() !== name.trim().toLowerCase()
    )
    const removed = this.map.waypoints.length !== before
    if (removed) this.touch()
    return removed
  }

  waypoint(name: string): MapRoom | null {
    const wp = this.map.waypoints.find((w) => w.name.toLowerCase() === name.trim().toLowerCase())
    return wp ? this.room(wp.roomId) : null
  }
}
