/** Dijkstra routing over the graph, respecting saved avoidance and costs. */
import type { MapModel } from './MapModel.ts'
import { DIR_FULL, type Direction, type MapExit } from './types.ts'

export interface WalkStep {
  fromRoomId?: string
  exitIndex?: number
  cost?: number
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

/** Lowest-cost path fromId → toId, or null if excluded or unreachable. */
export function findPath(model: MapModel, fromId: string, toId: string): WalkStep[] | null {
  if (fromId === toId) return []
  const prev = new Map<string, { roomId: string; step: WalkStep }>()
  if (!model.room(fromId) || !model.room(toId) || model.room(toId)?.avoid) return null
  const distances = new Map<string, number>([[fromId, 0]])
  const queue: { id: string; cost: number }[] = [{ id: fromId, cost: 0 }]
  const push = (item: { id: string; cost: number }) => {
    queue.push(item)
    let i = queue.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (queue[p].cost <= item.cost) break
      queue[i] = queue[p]; i = p
    }
    queue[i] = item
  }
  const pop = () => {
    const first = queue[0], last = queue.pop()!
    if (queue.length) {
      let i = 0
      while (i * 2 + 1 < queue.length) {
        let child = i * 2 + 1
        if (child + 1 < queue.length && queue[child + 1].cost < queue[child].cost) child++
        if (queue[child].cost >= last.cost) break
        queue[i] = queue[child]; i = child
      }
      queue[i] = last
    }
    return first
  }

  while (queue.length > 0) {
    const { id, cost } = pop()
    if (cost !== distances.get(id)) continue
    if (id === toId) {
      const steps: WalkStep[] = []
      for (let cursor = toId; cursor !== fromId;) {
        const entry = prev.get(cursor)!
        steps.push(entry.step); cursor = entry.roomId
      }
      return steps.reverse()
    }
    const room = model.room(id)
    if (!room) continue
    for (const [exitIndex, exit] of room.exits.entries()) {
      const dest = exit.to
      if (!dest || exit.avoid || !model.room(dest) || model.room(dest)?.avoid) continue
      const command = exitCommand(exit)
      if (!command) continue
      const entryCost = model.room(dest)?.cost
      const stepCost = (Number.isFinite(exit.cost) && exit.cost! >= 1 ? exit.cost! : 1) +
        (Number.isFinite(entryCost) && entryCost! >= 0 ? entryCost! : 0)
      const nextCost = cost + stepCost
      if (nextCost >= (distances.get(dest) ?? Infinity)) continue
      distances.set(dest, nextCost)
      prev.set(dest, {
        roomId: id,
        step: { command, openCommand: exitOpenCommand(exit), toRoomId: dest, fromRoomId: id, exitIndex, cost: stepCost }
      })
      push({ id: dest, cost: nextCost })
    }
  }
  return null
}

/**
 * A command as typed, reduced to what identifies it: case, runs of spaces
 * and a trailing full stop are how people vary, not what the MUD keys on.
 * "say I seek entrance to the spire." and "say i seek entrance to the spire"
 * are the same special exit.
 */
export function normalizeCommand(command: string): string {
  return command.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '')
}

/** Index of the special exit that `typed` walks, or -1. */
export function specialExitIndex(room: { exits: MapExit[] }, typed: string): number {
  const wanted = normalizeCommand(typed)
  if (!wanted) return -1
  return room.exits.findIndex((e) => e.dir === null && !!e.command && normalizeCommand(e.command) === wanted)
}
