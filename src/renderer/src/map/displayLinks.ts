import type { MapExit, MapRoom, MudMap } from './types.ts'

export interface ExitRef { exit: MapExit; index: number }
export interface DisplayLink {
  room: MapRoom
  destination: MapRoom | null
  outgoing: ExitRef[]
  returning: ExitRef[]
}
export interface ExitFocus { roomId: string; exitIndex: number }

/** A connector represents a pair of rooms, not an assumed compass/opposite
 * pair. Twisted zones may offer N and W to the same room, with only E back.
 * Keep every command even though the shared connection is painted once. */
export function displayLinks(rooms: MapRoom[], map: MudMap): DisplayLink[] {
  const seen = new Set<string>()
  const links: DisplayLink[] = []
  const refsTo = (room: MapRoom, id: string): ExitRef[] => room.exits
    .map((exit, index) => ({ exit, index })).filter((ref) => ref.exit.to === id)
  for (const room of rooms) {
    room.exits.forEach((exit, index) => {
      const destination = exit.to ? map.rooms[exit.to] ?? null : null
      if (!destination) {
        links.push({ room, destination: null, outgoing: [{ exit, index }], returning: [] })
        return
      }
      const key = JSON.stringify([room.id, destination.id].sort())
      if (seen.has(key)) return
      seen.add(key)
      links.push({
        room, destination, outgoing: refsTo(room, destination.id),
        returning: destination.id === room.id ? [] : refsTo(destination, room.id)
      })
    })
  }
  return links
}

export function linkHasFocus(link: DisplayLink, focus: ExitFocus): boolean {
  return (link.room.id === focus.roomId && link.outgoing.some((r) => r.index === focus.exitIndex)) ||
    (link.destination?.id === focus.roomId && link.returning.some((r) => r.index === focus.exitIndex))
}

export function exitCommandLabel(exit: MapExit): string {
  return exit.command || exit.dir?.toUpperCase() || 'Special exit'
}
