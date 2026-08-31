/**
 * Remote map plumbing for the pop-out window.
 *
 * RemoteMapModel extends MapModel: reads come from a mirrored copy of the map,
 * mutations apply locally (instant feedback) AND forward to the session
 * renderer as serializable method calls; the session's authoritative state
 * flows back via mirror pushes and is absorbed wholesale.
 */
import { MapModel } from './MapModel.ts'
import type { TrackerMode } from './MapTracker.ts'
import type { Direction, MapExit, MapRoom, MudMap } from './types.ts'

export type MapAction =
  | { type: 'model'; method: string; args: unknown[] }
  | { type: 'tracker'; method: 'setMode' | 'setCurrentRoom'; args: unknown[] }
  | { type: 'walkTo'; roomId: string; fast?: boolean }

/** Model methods the session side will accept from a pop-out. */
export const MODEL_ACTION_METHODS = new Set([
  'createZone',
  'renameZone',
  'deleteZone',
  'setActiveZone',
  'setPendingZone',
  'moveRoomsToZone',
  'createRoom',
  'updateRoom',
  'moveRoom',
  'deleteRoom',
  'mergeRooms',
  'addExit',
  'linkRooms',
  'setDoor',
  'setExitAt',
  'removeExitAt',
  'addSpecialExit',
  'setWaypoint',
  'removeWaypoint'
])

export class RemoteMapModel extends MapModel {
  private sendAction: (action: MapAction) => void

  constructor(initial: MudMap, send: (action: MapAction) => void) {
    super(initial, () => {}) // the session side owns persistence
    this.sendAction = send
  }

  /** Replace local state with an authoritative mirror push. */
  absorb(map: MudMap, activeZoneId: string): void {
    this.map = map
    if (map.zones.some((z) => z.id === activeZoneId)) this.activeZoneId = activeZoneId
    this.touch()
  }

  private rpc(method: string, args: unknown[]): void {
    this.sendAction({ type: 'model', method, args })
  }

  override createZone(name: string, id?: string): string {
    const zoneId = super.createZone(name, id ?? crypto.randomUUID())
    this.rpc('createZone', [name, zoneId])
    return zoneId
  }

  override renameZone(id: string, name: string): void {
    super.renameZone(id, name)
    this.rpc('renameZone', [id, name])
  }

  override deleteZone(id: string): number {
    const n = super.deleteZone(id)
    this.rpc('deleteZone', [id])
    return n
  }

  override setActiveZone(id: string): void {
    super.setActiveZone(id)
    this.rpc('setActiveZone', [id])
  }

  override setPendingZone(id: string | null): void {
    super.setPendingZone(id)
    this.rpc('setPendingZone', [id])
  }

  override moveRoomsToZone(roomIds: string[], zoneId: string): number {
    const n = super.moveRoomsToZone(roomIds, zoneId)
    this.rpc('moveRoomsToZone', [roomIds, zoneId])
    return n
  }

  override createRoom(partial: Partial<MapRoom> & { name: string }): MapRoom {
    const withId = { ...partial, id: partial.id ?? crypto.randomUUID() }
    const room = super.createRoom(withId)
    this.rpc('createRoom', [withId])
    return room
  }

  override updateRoom(id: string, patch: Partial<MapRoom>): void {
    super.updateRoom(id, patch)
    this.rpc('updateRoom', [id, patch])
  }

  override moveRoom(id: string, x: number, y: number, z?: number): void {
    super.moveRoom(id, x, y, z)
    this.rpc('moveRoom', [id, x, y, z])
  }

  override deleteRoom(id: string): void {
    super.deleteRoom(id)
    this.rpc('deleteRoom', [id])
  }

  override mergeRooms(keepId: string, dropId: string): void {
    super.mergeRooms(keepId, dropId)
    this.rpc('mergeRooms', [keepId, dropId])
  }

  override linkRooms(fromId: string, dir: Direction, toId: string, addReverse: boolean): void {
    super.linkRooms(fromId, dir, toId, addReverse)
    this.rpc('linkRooms', [fromId, dir, toId, addReverse])
  }

  override setDoor(roomId: string, dir: Direction, door: boolean, doorName?: string): void {
    super.setDoor(roomId, dir, door, doorName)
    this.rpc('setDoor', [roomId, dir, door, doorName])
  }

  override setExitAt(roomId: string, index: number, patch: Partial<MapExit>): void {
    super.setExitAt(roomId, index, patch)
    this.rpc('setExitAt', [roomId, index, patch])
  }

  override removeExitAt(roomId: string, index: number): void {
    super.removeExitAt(roomId, index)
    this.rpc('removeExitAt', [roomId, index])
  }

  override addSpecialExit(fromId: string, command: string, toId: string | null): void {
    super.addSpecialExit(fromId, command, toId)
    this.rpc('addSpecialExit', [fromId, command, toId])
  }

  override setWaypoint(name: string, roomId: string): void {
    super.setWaypoint(name, roomId)
    this.rpc('setWaypoint', [name, roomId])
  }

  override removeWaypoint(name: string): boolean {
    const removed = super.removeWaypoint(name)
    this.rpc('removeWaypoint', [name])
    return removed
  }
}

/** Minimal tracker facade for the pop-out (state mirrored, commands relayed). */
export class RemoteTracker {
  currentRoomId: string | null = null
  lost = false
  mode: TrackerMode = 'map'
  speculative = false
  serverDriven = false

  private model: MapModel
  private send: (action: MapAction) => void
  private subs = new Set<() => void>()

  constructor(model: MapModel, send: (action: MapAction) => void) {
    this.model = model
    this.send = send
  }

  get currentRoom(): MapRoom | null {
    return this.model.room(this.currentRoomId)
  }

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  private notify(): void {
    for (const fn of this.subs) fn()
  }

  update(state: {
    currentRoomId: string | null
    lost: boolean
    mode: TrackerMode
    speculative?: boolean
    serverDriven?: boolean
  }): void {
    this.currentRoomId = state.currentRoomId
    this.lost = state.lost
    this.mode = state.mode
    this.speculative = state.speculative ?? false
    this.serverDriven = state.serverDriven ?? false
    this.notify()
  }

  setMode(mode: TrackerMode): void {
    this.mode = mode
    this.send({ type: 'tracker', method: 'setMode', args: [mode] })
    this.notify()
  }

  setCurrentRoom(id: string | null): void {
    this.currentRoomId = id
    this.lost = false
    this.send({ type: 'tracker', method: 'setCurrentRoom', args: [id] })
    this.notify()
  }
}

/** What MapPane needs from a tracker — satisfied by MapTracker and RemoteTracker. */
export interface TrackerControl {
  currentRoomId: string | null
  lost: boolean
  mode: TrackerMode
  /** currentRoomId is a bet, not a settled position: the map draws it as one. */
  readonly speculative: boolean
  /** Rooms are being identified by the MUD itself, not read off the screen. */
  readonly serverDriven: boolean
  readonly currentRoom: MapRoom | null
  subscribe(fn: () => void): () => void
  setMode(mode: TrackerMode): void
  setCurrentRoom(id: string | null): void
}
