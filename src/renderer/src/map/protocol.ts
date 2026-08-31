/**
 * Turning what a MUD says over GMCP into room identity.
 *
 * Kept out of SessionStore so it can be exercised headlessly: these are pure
 * shape translations, and the shapes vary enough between MUDs that guessing at
 * them is exactly how a working protocol ends up silently ignored.
 */
import { wordToDirection, type Direction, type ServerRoomInfo } from './types.ts'

/**
 * Every key a MUD has been seen to use for a room's own id.
 *
 * `vnum` is AwakeMUD CE's, and its absence from an earlier version of this
 * list is why every Room.Info that MUD sent was discarded on arrival — the
 * mapper fell back to reading the screen on a MUD that was telling it
 * everything outright.
 */
const ID_KEYS = ['vnum', 'room_vnum', 'roomVnum', 'num', 'number', 'id']

/**
 * Exits in either shape a MUD sends them.
 *
 * Some report an object keyed by direction. AwakeMUD CE reports an array of
 * `{ direction, to, state }`, which also carries the destination's id before
 * the exit has been walked, and whether it is closed or locked.
 */
export function gmcpExits(raw: unknown): {
  exits: NonNullable<ServerRoomInfo['exits']>
  doors: Direction[]
} {
  const exits: NonNullable<ServerRoomInfo['exits']> = {}
  const doors: Direction[] = []
  const add = (key: unknown, dest: unknown, state?: unknown): void => {
    const dir = typeof key === 'string' ? wordToDirection(key) : null
    if (!dir) return
    exits[dir] = dest === null || dest === undefined || dest === '' ? null : `gmcp:${dest}`
    if (typeof state === 'string' && /^(closed|locked)$/i.test(state)) doors.push(dir)
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue
      const e = item as Record<string, unknown>
      add(e.direction ?? e.dir, e.to ?? e.vnum ?? e.room, e.state)
    }
  } else if (typeof raw === 'object' && raw !== null) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) add(k, v)
  }
  return { exits, doors }
}

/** Room identity from a GMCP Room.Info / Room.Exits payload, or null if the
 *  package is not one of those or carries no id to hang identity on. */
export function gmcpRoomInfo(pkg: string, data: unknown): ServerRoomInfo | null {
  if (!/^room\.(info|exits)$/i.test(pkg)) return null
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>

  let id: unknown
  for (const key of ID_KEYS) {
    const v = d[key]
    if (v !== undefined && v !== null && v !== '') {
      id = v
      break
    }
  }
  if (id === undefined) return null

  const { exits, doors } = gmcpExits(d.exits)
  const name = d.name ?? d.room_name
  const area = d.area ?? d.zone ?? d.area_name

  let coords: ServerRoomInfo['coords']
  const c = d.coords
  if (typeof c === 'object' && c !== null) {
    const o = c as Record<string, unknown>
    if (typeof o.x === 'number' && typeof o.y === 'number' && typeof o.z === 'number') {
      coords = { x: o.x, y: o.y, z: o.z }
    }
  }

  return {
    serverId: `gmcp:${id}`,
    name: typeof name === 'string' && name !== '' ? name : undefined,
    areaName: typeof area === 'string' && area !== '' ? area : undefined,
    exits,
    doors,
    description: typeof d.description === 'string' ? d.description : undefined,
    coords
  }
}
