import type { DirectoryMud } from '../../../shared/types'

/**
 * Sort orders for the directory browser.
 *
 * Kept out of the component so they can be tested directly — the ordering here
 * is easy to get subtly wrong in a way no type check catches.
 *
 * The players comparator is the cautionary one. A MUD carries two different
 * player numbers and they are not interchangeable:
 *
 *   players        what the MUD reported when the sweep probed it. Current,
 *                  always a whole number.
 *   activePlayers  a rolling historical mean from the MSSP crawler. Routinely
 *                  fractional — 0.47, 3.23 — and often stale.
 *
 * Sorting by the average buried Threshold RPG's 145 logged-in players behind
 * MUDs averaging three, and displaying it produced rows reading "0.47 players".
 * The live count leads; the average only breaks ties.
 */
export type SortKey = 'name' | 'codebase' | 'players' | 'rank' | 'sources' | 'created' | 'rooms'

export const SORT_LABELS: Record<SortKey, string> = {
  name: 'Name',
  codebase: 'Codebase',
  players: 'Players online',
  rank: 'TMC rank',
  sources: 'Listed on most sites',
  created: 'Newest',
  rooms: 'World size'
}

export const SORTS: Record<SortKey, (a: DirectoryMud, b: DirectoryMud) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),

  // Unknown codebases sort last rather than under the empty string.
  codebase: (a, b) =>
    (a.codebase ?? '￿').localeCompare(b.codebase ?? '￿') || a.name.localeCompare(b.name),

  players: (a, b) =>
    (b.players ?? -1) - (a.players ?? -1) ||
    (b.activePlayers ?? -1) - (a.activePlayers ?? -1) ||
    a.name.localeCompare(b.name),

  // Unranked sorts last rather than first: absent is not rank zero.
  rank: (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),

  sources: (a, b) => b.sources.length - a.sources.length || a.name.localeCompare(b.name),

  created: (a, b) => (b.created ?? -1) - (a.created ?? -1) || a.name.localeCompare(b.name),

  rooms: (a, b) => (b.rooms ?? -1) - (a.rooms ?? -1) || a.name.localeCompare(b.name)
}

/**
 * Column headings, in the order they appear in a row.
 *
 * `align: 'end'` right-aligns both the heading and its cells so numbers line up
 * on the digit rather than the first character.
 */
export const COLUMNS: { key: SortKey | null; label: string; align?: 'end'; title?: string }[] = [
  { key: 'name', label: 'World', title: 'Sort by name' },
  { key: 'codebase', label: 'Codebase', title: 'Sort by codebase' },
  { key: 'players', label: 'On', align: 'end', title: 'Sort by who is online now' },
  { key: 'sources', label: 'Lists', align: 'end', title: 'Sort by how many directories list it' },
  // Not sortable: an address is for reading, and sorting by hostname sorts by
  // whatever the domain happens to start with.
  { key: null, label: 'Address', align: 'end' }
]

/**
 * Each key has a natural direction — names read A–Z, player counts read
 * highest-first — so a comparator is written the way you would first want it
 * and `descending` flips it, rather than every comparator carrying a sign.
 */
export function compareBy(
  key: SortKey,
  flipped: boolean
): (a: DirectoryMud, b: DirectoryMud) => number {
  const base = SORTS[key]
  return flipped ? (a, b) => -base(a, b) : base
}

/** The number to show on a row, or null when the MUD never reported one. */
export function displayPlayers(m: DirectoryMud): number | null {
  return m.players
}

/** Hover text for that number, mentioning the average only when we have one. */
export function playersTitle(m: DirectoryMud): string {
  if (m.players === null) return ''
  return m.activePlayers === null
    ? `${m.players} online when last checked`
    : `${m.players} online when last checked · typically about ${Math.round(m.activePlayers)}`
}
