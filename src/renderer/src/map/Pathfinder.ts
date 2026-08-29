/** BFS pathfinding over the room graph. Exits are uniform cost; special
 *  exits are ordinary edges with a custom command. */
import type { MapModel } from './MapModel.ts'
import { DIR_FULL, type Direction, type MapExit } from './types.ts'

export interface WalkStep {
  /** Command that traverses the exit ("n" or "enter portal"). */
  command: string
  /** Open this before moving, when the exit has a door. */
  openCommand?: string
  /** Expected destination; null = unmapped, any confirmed arrival counts. */
  toRoomId: string | null
}

export function exitCommand(exit: MapExit): string {
  if (exit.command) return exit.command
  return exit.dir ?? ''
}

export function exitOpenCommand(exit: MapExit): string | undefined {
  if (!exit.door) return undefined
  const name = exit.doorName?.trim()
  // No noun unless we actually learned one: `open down` works where
  // `open door down` answers "You see no door here."
  if (exit.dir) {
    const dir = DIR_FULL[exit.dir as Direction]
    return name ? `open ${name} ${dir}` : `open ${dir}`
  }
  return `open ${name || 'door'}`
}

/** Shortest path fromId → toId, or null if unreachable. */
export function findPath(model: MapModel, fromId: string, toId: string): WalkStep[] | null {
  if (fromId === toId) return []
  const prev = new Map<string, { roomId: string; step: WalkStep }>()
  const visited = new Set<string>([fromId])
  const queue: string[] = [fromId]

  while (queue.length > 0) {
    const id = queue.shift()!
    const room = model.room(id)
    if (!room) continue
    for (const exit of room.exits) {
      const dest = exit.to
      if (!dest || visited.has(dest) || !model.room(dest)) continue
      const command = exitCommand(exit)
      if (!command) continue
      visited.add(dest)
      prev.set(dest, {
        roomId: id,
        step: { command, openCommand: exitOpenCommand(exit), toRoomId: dest }
      })
      if (dest === toId) {
        const steps: WalkStep[] = []
        let cursor = toId
        while (cursor !== fromId) {
          const entry = prev.get(cursor)!
          steps.unshift(entry.step)
          cursor = entry.roomId
        }
        return steps
      }
      queue.push(dest)
    }
  }
  return null
}
