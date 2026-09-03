/**
 * Re-embedding a zone: fresh coordinates for every room, from the links.
 *
 * Coordinates are only layout -- rooms and links are the truth -- and they
 * are laid down one greedy guess at a time while exploring. A cell that was
 * taken when a room arrived pushes that room outward, every room chained
 * off it inherits the error, and the renderer ends up bowing links around
 * rooms that sit in their way. This walks the zone again from one anchor,
 * breadth-first, placing each room where its exit says it should be and
 * refusing to put it on another room or across an existing link. Only the
 * coordinates change; the graph is untouched.
 *
 * Pure and DOM-free so it can be tested headlessly; the model applies the
 * moves it returns and keeps the old positions for undo.
 */
import { DIR_DELTA, DIRECTIONS, OPPOSITE, type Direction, type MapRoom, type MudMap } from './types.ts'
import { isObstructed } from './geometry.ts'

export interface Pos {
  x: number
  y: number
  z: number
}

/** What a layout costs: each is a count of links, lower is better. */
export interface LayoutScore {
  /** Links whose drawn direction disagrees with their compass direction. */
  contrary: number
  /** Of those, the ones that are not even between neighbouring cells. A
   *  diagonal lie between adjacent rooms is a small thing on screen; one
   *  drawn across the map is not. */
  contraryFar: number
  /** Links whose straight line would cross another room's box -- exactly
   *  the ones the renderer has to route or bow around, by its own test. */
  through: number
  /** Links spanning more than one cell. */
  long: number
  /** Cells beyond the one step those links span, summed: a link drawn five
   *  cells long is a bigger claim of empty ground than one drawn two. */
  stretch: number
  /** Pairs of links on one level whose straight lines cross each other. */
  crossings: number
}

export interface RelayoutResult {
  /** New coordinates, only for rooms that actually move. */
  moves: Record<string, Pos>
  /** Rooms the walk could not place by their links; they keep or get a free
   *  cell near where they were, so nothing is lost, but they may still bow. */
  unplaced: string[]
  before: LayoutScore
  /** Score of the layout in force after this result is applied. */
  after: LayoutScore
  /** Score of the best embedding found, even when it was not worth applying. */
  attempted: LayoutScore
}

type Link = { from: MapRoom; dir: Direction; to: MapRoom }

/** Starting rooms tried per relayout; beyond this a zone is big enough that
 *  the best-connected starts are the only ones worth the time. */
const MAX_STARTS = 48
/** Passes over the starts with different tie-breaks, and the most time the
 *  whole search may take: this runs on a button press and must feel instant. */
const RESTARTS = 4
const TIME_BUDGET_MS = 700
/** Most time each polish pass (refineLayout) may take after the walk. */
const POLISH_BUDGET_MS = 200

const key = (p: Pos): string => `${p.x},${p.y},${p.z}`
const isCompass = (dir: string | null | undefined): dir is Direction =>
  dir != null && (DIRECTIONS as string[]).includes(dir)
const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0)

/** Cells strictly between two positions on the same level, when the link
 *  between them is straight (axis-aligned or exactly diagonal); otherwise
 *  none, since the renderer curves such a link anyway. */
function cellsBetween(a: Pos, b: Pos): Pos[] {
  if (a.z !== b.z) return []
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.max(Math.abs(dx), Math.abs(dy))
  if (len < 2) return []
  if (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy)) return []
  const sx = sign(dx)
  const sy = sign(dy)
  const out: Pos[] = []
  for (let k = 1; k < len; k++) out.push({ x: a.x + sx * k, y: a.y + sy * k, z: a.z })
  return out
}

/** How a link from `a` to `b` fares against its compass direction. */
function judge(dir: Direction, a: Pos, b: Pos): 'exact' | 'ok' | 'contrary' {
  const [vx, vy, vz] = DIR_DELTA[dir]
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  if (vz !== 0) return sign(dz) === vz ? (dx === 0 && dy === 0 && Math.abs(dz) === 1 ? 'exact' : 'ok') : 'contrary'
  if (dz !== 0) return 'contrary'
  if (dx === vx && dy === vy) return 'exact'
  // Against the direction, or off its axis (a "north" that goes anywhere
  // but north is a lie the map is telling).
  if (dx * vx + dy * vy <= 0) return 'contrary'
  if (vx === 0 && dx !== 0) return 'contrary'
  if (vy === 0 && dy !== 0) return 'contrary'
  if (vx !== 0 && vy !== 0 && sign(dx) !== vx) return 'contrary'
  if (vx !== 0 && vy !== 0 && sign(dy) !== vy) return 'contrary'
  return 'ok'
}

/** Do two straight links on one level cross? Sharing an endpoint is not
 *  crossing: links fan out of a room all the time. */
function linksCross(a: Pos, b: Pos, c: Pos, d: Pos): boolean {
  const same = (p: Pos, q: Pos): boolean => p.x === q.x && p.y === q.y
  if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false
  const orient = (p: Pos, q: Pos, r: Pos): number => sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0
}

/** One face of one link, for scoring. */
type Face = { from: string; to: string; dir: Direction }

/** What one face costs on its own, before crossings. */
function faceScore(f: Face, at: (id: string) => Pos, isOccupiedOn: (z: number) => (x: number, y: number) => boolean): LayoutScore {
  const s: LayoutScore = { contrary: 0, contraryFar: 0, through: 0, long: 0, stretch: 0, crossings: 0 }
  const a = at(f.from)
  const b = at(f.to)
  const span = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
  if (judge(f.dir, a, b) === 'contrary') {
    s.contrary++
    if (a.z !== b.z || span > 1) s.contraryFar++
  }
  if (a.z !== b.z) return s
  if (span > 1) {
    s.long++
    s.stretch += span - 1
  }
  if (isObstructed(a, b, isOccupiedOn(a.z))) s.through++
  return s
}

/** Every compass face inside the zone (both faces of a two-way link). */
function facesOf(rooms: MapRoom[]): Face[] {
  const ids = new Set(rooms.map((r) => r.id))
  const out: Face[] = []
  for (const r of rooms) {
    for (const e of r.exits) {
      if (!isCompass(e.dir) || e.to == null || !ids.has(e.to) || e.to === r.id) continue
      out.push({ from: r.id, to: e.to, dir: e.dir })
    }
  }
  return out
}

/** Each two-way link once, as the segment the renderer draws. */
function segmentsOf(faces: Face[]): Array<[string, string]> {
  const seen = new Set<string>()
  const out: Array<[string, string]> = []
  for (const f of faces) {
    const k = f.from < f.to ? `${f.from}|${f.to}` : `${f.to}|${f.from}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push([f.from, f.to])
  }
  return out
}

export function scoreLayout(rooms: MapRoom[], at: (id: string) => Pos): LayoutScore {
  const occupied = new Set(rooms.map((r) => key(at(r.id))))
  const isOccupiedOn = (z: number) => (x: number, y: number) => occupied.has(key({ x, y, z }))
  const score: LayoutScore = { contrary: 0, contraryFar: 0, through: 0, long: 0, stretch: 0, crossings: 0 }
  const faces = facesOf(rooms)
  for (const f of faces) {
    const s = faceScore(f, at, isOccupiedOn)
    score.contrary += s.contrary
    score.contraryFar += s.contraryFar
    score.through += s.through
    score.long += s.long
    score.stretch += s.stretch
  }
  const segs = segmentsOf(faces)
  for (let i = 0; i < segs.length; i++) {
    const a = at(segs[i][0])
    const b = at(segs[i][1])
    if (a.z !== b.z) continue
    for (let j = i + 1; j < segs.length; j++) {
      const c = at(segs[j][0])
      const d = at(segs[j][1])
      if (c.z !== a.z || d.z !== a.z) continue
      if (linksCross(a, b, c, d)) score.crossings++
    }
  }
  return score
}

/** One number for a layout: what it would cost the eye. A link drawn
 *  through a room has to be routed around it; a crossing has to be read
 *  past; a long link needs its chevrons; a lie about direction needs an
 *  arrow, and a lie drawn across the map misleads far more than a diagonal
 *  between neighbours. */
export function layoutCost(sc: LayoutScore, unplaced = 0): number {
  return sc.contrary * 2 + sc.contraryFar * 2 + sc.through * 3 + sc.stretch + sc.crossings * 2 + unplaced * 2
}

/**
 * Polish a layout in place: slide any room to a nearby free cell on its
 * level, or swap two neighbouring rooms, whenever the whole layout costs
 * less for it, until nothing helps or the time is up. The walk places each
 * room once, from whichever neighbour reached it first, so a room boxed in
 * early can sit one cell from where every link of its would be happy; and
 * a ring of rooms around a building can only stretch to enclose it if its
 * corners move one at a time, which no single greedy placement does.
 *
 * Cost is evaluated as a delta -- only the faces touching a moved room, the
 * obstruction of other links by the cells it leaves and takes, and the
 * crossings those faces take part in -- so a pass over a hundred-room zone
 * stays within the budget.
 */
export function refineLayout(
  rooms: MapRoom[],
  at: Map<string, Pos>,
  opts: { fixed?: Set<string>; radius?: number; deadline?: number } = {}
): Map<string, Pos> {
  const fixed = opts.fixed ?? new Set<string>()
  const radius = opts.radius ?? 3
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY
  const pos = new Map(at)
  const get = (id: string): Pos => pos.get(id)!
  const occupied = new Map<string, string>()
  for (const r of rooms) occupied.set(key(get(r.id)), r.id)
  const isOccupiedOn = (z: number) => (x: number, y: number) => occupied.has(key({ x, y, z }))
  const faces = facesOf(rooms)
  const segs = segmentsOf(faces)
  const facesAt = new Map<string, Face[]>()
  const segsAt = new Map<string, number[]>()
  for (const f of faces) {
    facesAt.set(f.from, [...(facesAt.get(f.from) ?? []), f])
    facesAt.set(f.to, [...(facesAt.get(f.to) ?? []), f])
  }
  segs.forEach(([a, b], i) => {
    segsAt.set(a, [...(segsAt.get(a) ?? []), i])
    segsAt.set(b, [...(segsAt.get(b) ?? []), i])
  })
  const faceCost = (f: Face): number => layoutCost(faceScore(f, get, isOccupiedOn))
  const segCross = (i: number, j: number): boolean => {
    const a = get(segs[i][0])
    const b = get(segs[i][1])
    const c = get(segs[j][0])
    const d = get(segs[j][1])
    return a.z === b.z && c.z === a.z && d.z === a.z && linksCross(a, b, c, d)
  }
  /** Does one box at `cell` sit on the straight line of segment i? */
  const blockedBy = (i: number, cell: Pos): boolean => {
    const a = get(segs[i][0])
    const b = get(segs[i][1])
    if (a.z !== b.z || cell.z !== a.z) return false
    if ((a.x === cell.x && a.y === cell.y) || (b.x === cell.x && b.y === cell.y)) return false
    return isObstructed(a, b, (x, y) => x === cell.x && y === cell.y)
  }

  /** Cost of everything a set of rooms touches, in the current positions. */
  const localCost = (ids: string[]): number => {
    const moved = new Set(ids)
    let total = 0
    const seenFace = new Set<Face>()
    const seenSeg = new Set<number>()
    for (const id of ids) {
      for (const f of facesAt.get(id) ?? []) {
        if (seenFace.has(f)) continue
        seenFace.add(f)
        total += faceCost(f)
      }
      for (const i of segsAt.get(id) ?? []) {
        if (seenSeg.has(i)) continue
        seenSeg.add(i)
        for (let j = 0; j < segs.length; j++) {
          if (j === i) continue
          // A pair of moved segments is counted once, from the first seen.
          if (seenSeg.has(j)) continue
          if (segCross(i, j)) total += 2
        }
      }
    }
    // Other links obstructed by the boxes these rooms occupy.
    for (const id of ids) {
      const cell = get(id)
      for (let i = 0; i < segs.length; i++) {
        if (moved.has(segs[i][0]) || moved.has(segs[i][1])) continue
        if (blockedBy(i, cell)) total += 3
      }
    }
    return total
  }
  const place = (id: string, p: Pos): void => {
    occupied.delete(key(get(id)))
    pos.set(id, p)
    occupied.set(key(p), id)
  }

  const ids = rooms.map((r) => r.id).filter((id) => !fixed.has(id))
  for (let pass = 0; pass < 20; pass++) {
    let improved = false
    for (const id of ids) {
      if (Date.now() > deadline) return pos
      const orig = get(id)
      const was = localCost([id])
      let bestP = orig
      let bestDelta = 0
      for (let ox = -radius; ox <= radius; ox++) {
        for (let oy = -radius; oy <= radius; oy++) {
          if (ox === 0 && oy === 0) continue
          const p = { x: orig.x + ox, y: orig.y + oy, z: orig.z }
          if (occupied.has(key(p))) continue
          place(id, p)
          const delta = localCost([id]) - was
          if (delta < bestDelta - 1e-9) {
            bestDelta = delta
            bestP = p
          }
        }
      }
      place(id, bestP)
      if (bestDelta < 0) improved = true
    }
    // Slides: a linked pair moves together, so a ring can step outward one
    // side at a time where moving either room alone only makes it worse.
    const placeBoth = (a: string, b: string, qa: Pos, qb: Pos): void => {
      occupied.delete(key(get(a)))
      occupied.delete(key(get(b)))
      pos.set(a, qa)
      pos.set(b, qb)
      occupied.set(key(qa), a)
      occupied.set(key(qb), b)
    }
    for (const [a, b] of segs) {
      if (Date.now() > deadline) return pos
      if (fixed.has(a) || fixed.has(b)) continue
      const pa = get(a)
      const pb = get(b)
      if (pa.z !== pb.z) continue
      const was = localCost([a, b])
      let bestO: [number, number] | null = null
      let bestDelta = 0
      for (let ox = -2; ox <= 2; ox++) {
        for (let oy = -2; oy <= 2; oy++) {
          if (ox === 0 && oy === 0) continue
          const qa = { x: pa.x + ox, y: pa.y + oy, z: pa.z }
          const qb = { x: pb.x + ox, y: pb.y + oy, z: pb.z }
          const ta = occupied.get(key(qa))
          const tb = occupied.get(key(qb))
          if ((ta !== undefined && ta !== a && ta !== b) || (tb !== undefined && tb !== a && tb !== b)) continue
          placeBoth(a, b, qa, qb)
          const delta = localCost([a, b]) - was
          placeBoth(a, b, pa, pb)
          if (delta < bestDelta - 1e-9) {
            bestDelta = delta
            bestO = [ox, oy]
          }
        }
      }
      if (bestO) {
        placeBoth(a, b, { x: pa.x + bestO[0], y: pa.y + bestO[1], z: pa.z }, { x: pb.x + bestO[0], y: pb.y + bestO[1], z: pb.z })
        improved = true
      }
    }
    // Swaps: two rooms near each other on one level trade places.
    for (let i = 0; i < ids.length; i++) {
      if (Date.now() > deadline) return pos
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]
        const b = ids[j]
        const pa = get(a)
        const pb = get(b)
        if (pa.z !== pb.z || Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y)) > radius) continue
        const was = localCost([a, b])
        occupied.delete(key(pa))
        occupied.delete(key(pb))
        pos.set(a, pb)
        pos.set(b, pa)
        occupied.set(key(pb), a)
        occupied.set(key(pa), b)
        if (localCost([a, b]) < was - 1e-9) {
          improved = true
        } else {
          occupied.delete(key(pa))
          occupied.delete(key(pb))
          pos.set(a, pa)
          pos.set(b, pb)
          occupied.set(key(pa), a)
          occupied.set(key(pb), b)
        }
      }
    }
    if (!improved) break
  }
  return pos
}

/**
 * Lay the zone out again. The anchor keeps its coordinates so the zone
 * does not jump relative to its neighbours; everything else is placed from
 * it. When no anchor is given (or it is not in the zone) the best-connected
 * room is used.
 */
export function relayoutZone(map: MudMap, zoneId: string, anchorId?: string | null): RelayoutResult {
  const rooms = Object.values(map.rooms).filter((r) => r.zoneId === zoneId)
  const byId = new Map(rooms.map((r) => [r.id, r]))
  const oldPos = (id: string): Pos => {
    const r = byId.get(id)!
    return { x: r.x, y: r.y, z: r.z }
  }
  const before = scoreLayout(rooms, oldPos)
  const result: RelayoutResult = { moves: {}, unplaced: [], before, after: before, attempted: before }
  if (rooms.length === 0) return result

  // Compass links inside the zone, both as a walk order and for scoring a
  // candidate cell against every neighbour already placed.
  const links = new Map<string, Link[]>()
  for (const r of rooms) {
    const out: Link[] = []
    for (const e of r.exits) {
      if (!isCompass(e.dir) || e.to == null) continue
      const to = byId.get(e.to)
      if (to && to.id !== r.id) out.push({ from: r, dir: e.dir, to })
    }
    links.set(r.id, out)
  }
  // Inbound compass links, so a room being placed can honour the exits that
  // lead INTO it as well as its own.
  const inbound = new Map<string, Link[]>()
  for (const out of links.values()) {
    for (const l of out) {
      const list = inbound.get(l.to.id) ?? []
      list.push(l)
      inbound.set(l.to.id, list)
    }
  }
  // Every connection, compass or not, for reaching disconnected pieces.
  const neighbours = (id: string): string[] => {
    const r = byId.get(id)!
    const out = new Set<string>()
    for (const e of r.exits) if (e.to != null && byId.has(e.to) && e.to !== id) out.add(e.to)
    for (const l of inbound.get(id) ?? []) out.add(l.from.id)
    return [...out]
  }

  const placed = new Map<string, Pos>()
  const occupied = new Map<string, string>()
  /** Straight links already laid, as the cells they pass over. */
  const laid: Pos[][] = []
  const take = (id: string, p: Pos): void => {
    placed.set(id, p)
    occupied.set(key(p), id)
    for (const l of [...(links.get(id) ?? []), ...(inbound.get(id) ?? [])]) {
      const other = l.from.id === id ? l.to.id : l.from.id
      const q = placed.get(other)
      if (q) laid.push(cellsBetween(p, q))
    }
  }
  const cellFree = (p: Pos): boolean => !occupied.has(key(p))
  const onALink = (p: Pos): boolean => laid.some((cells) => cells.some((c) => c.x === p.x && c.y === p.y && c.z === p.z))
  /** Would a straight link from p to an already-placed room cross a room? */
  const linkClear = (p: Pos, q: Pos): boolean => !cellsBetween(p, q).some((c) => !cellFree(c))

  /** Candidate cells for the room `id`, stepping from a placed room along
   *  an exit. Levels are not up for debate: the tracker assigned them as
   *  the rooms were walked and the player has been looking at them since,
   *  so a room keeps its floor and only its place on that floor moves. */
  const candidates = (id: string, from: Pos, dir: Direction): Pos[] => {
    const [dx, dy, dz] = DIR_DELTA[dir]
    const z = byId.get(id)!.z
    const out: Pos[] = []
    if (dz !== 0 || z !== from.z) {
      // Up and down: straight above or below, then the cells around that.
      out.push({ x: from.x, y: from.y, z })
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) out.push({ x: from.x + ox, y: from.y + oy, z })
      return out
    }
    // Only along the exit's own ray. A sidestep would draw the exit off its
    // axis, and a "north" that goes anywhere but north is the one thing a
    // relayout must never introduce; a room that cannot sit on its ray is
    // better left for the sweep than placed somewhere misleading.
    for (let k = 1; k <= 6; k++) out.push({ x: from.x + dx * k, y: from.y + dy * k, z })
    return out
  }

  /** Like rate(), but a contrary link costs instead of forbidding: for a
   *  room no ray could place, the least-bad cell beats no cell. */
  /** Reward for a link that sits exactly one cell along its direction
   *  versus further along it. Tight layouts pack rooms; loose ones let a
   *  ring stretch around what it encloses. Both are tried. */
  let exactBonus = 3
  /** Best-first settles the most constrained room first; breadth-first
   *  grows outward from the start, so what surrounds the start is placed
   *  after what is inside it and can stretch to enclose it. Both are tried. */
  let order: 'best' | 'bfs' = 'best'
  /** Ties in placement order are broken by a seeded jitter, so restarts
   *  explore different orders instead of repeating one. */
  let seed = 1
  const jitter = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed / 0x7fffffff) * 0.001
  }
  const rateSoft = (id: string, p: Pos): number | null => {
    if (!cellFree(p) || onALink(p)) return null
    let score = 0
    const one = (dir: Direction, a: Pos, b: Pos): boolean => {
      // A flat exit never changes floor: that is a hard fact. An up or down
      // exit that stays on one is only a lie of degree -- MUDs do write
      // "up" onto a patio -- so it costs rather than forbids.
      if (DIR_DELTA[dir][2] === 0 && a.z !== b.z) return false
      if (!linkClear(a, b)) return false
      const j = judge(dir, a, b)
      score += j === 'exact' ? exactBonus : j === 'ok' ? 1 : -4
      score -= Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 0.1
      return true
    }
    for (const l of links.get(id) ?? []) {
      const q = placed.get(l.to.id)
      if (q && !one(l.dir, p, q)) return null
    }
    for (const l of inbound.get(id) ?? []) {
      const q = placed.get(l.from.id)
      if (q && !one(l.dir, q, p)) return null
    }
    return score
  }

  /** The best cell for a stranded room, searched around the rooms it is
   *  linked to (or where it used to be, if none of them are placed yet). */
  const settle = (id: string): Pos => {
    // Horizontal neighbours fix the level. A room reached only by up or
    // down sits directly above or below that neighbour.
    const flat: Pos[] = []
    let vertical: Pos | null = null
    for (const l of links.get(id) ?? []) {
      const q = placed.get(l.to.id)
      if (!q) continue
      if (DIR_DELTA[l.dir][2] === 0) flat.push(q)
      else vertical = { x: q.x, y: q.y, z: q.z - DIR_DELTA[l.dir][2] }
    }
    for (const l of inbound.get(id) ?? []) {
      const q = placed.get(l.from.id)
      if (!q) continue
      if (DIR_DELTA[l.dir][2] === 0) flat.push(q)
      else vertical = { x: q.x, y: q.y, z: q.z + DIR_DELTA[l.dir][2] }
    }
    const z = byId.get(id)!.z
    const centre: Pos =
      flat.length > 0
        ? {
            x: Math.round(flat.reduce((a, p) => a + p.x, 0) / flat.length),
            y: Math.round(flat.reduce((a, p) => a + p.y, 0) / flat.length),
            z
          }
        : vertical
          ? { x: vertical.x, y: vertical.y, z }
          : oldPos(id)
    let best: { p: Pos; score: number } | null = null
    for (let ring = 0; ring <= 6; ring++) {
      for (let ox = -ring; ox <= ring; ox++) {
        for (let oy = -ring; oy <= ring; oy++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== ring) continue
          const p = { x: centre.x + ox, y: centre.y + oy, z: centre.z }
          const sc = rateSoft(id, p)
          if (sc === null) continue
          if (!best || sc > best.score) best = { p, score: sc }
        }
      }
      // A good cell close in beats a marginally better one far out.
      if (best && ring >= 2) break
    }
    return best ? (best as { p: Pos }).p : nearestFree(centre)
  }

  /** Nearest free cell to p on its level, spiralling outward. */
  const nearestFree = (p: Pos): Pos => {
    if (cellFree(p) && !onALink(p)) return p
    for (let ring = 1; ring < 50; ring++) {
      for (let ox = -ring; ox <= ring; ox++) {
        for (let oy = -ring; oy <= ring; oy++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== ring) continue
          const c = { x: p.x + ox, y: p.y + oy, z: p.z }
          if (cellFree(c) && !onALink(c)) return c
        }
      }
    }
    return p
  }

  /** Cells worth trying for `id`: along the ray of every exit that joins
   *  it to a room already placed, from that room. */
  const cellsFor = (id: string, fallback: boolean): Pos[] => {
    const out: Pos[] = []
    const seen = new Set<string>()
    const add = (p: Pos): void => {
      const k = key(p)
      if (!seen.has(k)) {
        seen.add(k)
        out.push(p)
      }
    }
    const z = byId.get(id)!.z
    for (const l of links.get(id) ?? []) {
      const q = placed.get(l.to.id)
      if (q) for (const p of candidates(id, q, OPPOSITE[l.dir])) add(p)
    }
    for (const l of inbound.get(id) ?? []) {
      const q = placed.get(l.from.id)
      if (q) for (const p of candidates(id, q, l.dir)) add(p)
    }
    if (!fallback) return out
    // Every ray was blocked: the cells around a neighbour on this floor are
    // still better than stranding the room, since a slightly wrong angle
    // beats a room dumped far away by the sweep.
    const near: Pos[] = []
    for (const l of links.get(id) ?? []) if (placed.has(l.to.id)) near.push(placed.get(l.to.id)!)
    for (const l of inbound.get(id) ?? []) if (placed.has(l.from.id)) near.push(placed.get(l.from.id)!)
    for (const q of near) {
      for (let r = 1; r <= 2; r++) {
        for (let ox = -r; ox <= r; ox++) {
          for (let oy = -r; oy <= r; oy++) {
            if (Math.max(Math.abs(ox), Math.abs(oy)) === r) add({ x: q.x + ox, y: q.y + oy, z })
          }
        }
      }
    }
    return out
  }

  /**
   * Best-first: of every unplaced room that touches a placed one, take the
   * one whose best cell satisfies the most of its placed neighbours, and
   * put it there. A room boxed in by two placed neighbours is settled
   * while both constraints can still be met, instead of being pinned by
   * whichever neighbour a breadth-first walk happened to reach first --
   * which is exactly how a ring of rooms around a building gets bent.
   */
  const walk = (startId: string, startAt: Pos): void => {
    take(startId, startAt)
    const frontier = new Set<string>()
    const expand = (id: string): void => {
      for (const other of neighbours(id)) if (!placed.has(other)) frontier.add(other)
    }
    expand(startId)
    while (frontier.size > 0) {
      let best: { id: string; p: Pos; score: number; touching: number } | null = null
      for (const id of frontier) {
        const touching = placedNeighbours(id)
        let top: { p: Pos; score: number } | null = null
        const consider = (p: Pos, i: number): void => {
          const sc = rateSoft(id, p)
          if (sc === null) return
          const score = sc - i * 0.01 + jitter()
          if (!top || score > top.score) top = { p, score }
        }
        cellsFor(id, false).forEach(consider)
        if (!top) cellsFor(id, true).forEach((p, i) => consider(p, i + 100))
        if (!top) continue
        const t = top as { p: Pos; score: number }
        if (
          !best ||
          t.score > best.score ||
          (t.score === best.score && (touching > best.touching || (touching === best.touching && id < best.id)))
        ) {
          best = { id, p: t.p, score: t.score, touching }
        }
        // Breadth-first: the frontier is in discovery order, and the first
        // room that can be placed at all is the one to place.
        if (order === 'bfs') break
      }
      if (!best) {
        // Nothing left on the frontier can be placed by a compass exit.
        // Rooms joined only by a special exit ("enter portal") have no
        // direction; keep one near its neighbour, off to the side.
        const loose = [...frontier].find(
          (id) => (links.get(id) ?? []).every((l) => !placed.has(l.to.id)) &&
            (inbound.get(id) ?? []).every((l) => !placed.has(l.from.id))
        )
        if (!loose) break // the rest are left for the sweep
        const via = neighbours(loose).find((n) => placed.has(n))!
        const q = placed.get(via)!
        take(loose, nearestFree({ x: q.x + 2, y: q.y, z: q.z }))
        frontier.delete(loose)
        expand(loose)
        continue
      }
      const b = best as { id: string; p: Pos }
      take(b.id, b.p)
      frontier.delete(b.id)
      expand(b.id)
    }
  }

  const placedNeighbours = (id: string): number =>
    (links.get(id) ?? []).filter((l) => placed.has(l.to.id)).length +
    (inbound.get(id) ?? []).filter((l) => placed.has(l.from.id)).length

  const embed = (start: MapRoom): { at: Map<string, Pos>; unplaced: string[]; score: LayoutScore } => {
    placed.clear()
    occupied.clear()
    laid.length = 0
    const unplaced: string[] = []
    walk(start.id, oldPos(start.id))
    // Anything the walk could not reach by its links -- a compass exit whose
    // every cell on its ray was blocked, or an island -- is settled next to
    // the rooms it connects to, best-connected first, and walked on from so
    // its own neighbourhood is still laid out properly.
    for (;;) {
      const rest = rooms.filter((r) => !placed.has(r.id))
      if (rest.length === 0) break
      rest.sort((a, b) => placedNeighbours(b.id) - placedNeighbours(a.id) || a.id.localeCompare(b.id))
      unplaced.push(rest[0].id)
      walk(rest[0].id, settle(rest[0].id))
    }
    const at = new Map(placed)
    return { at, unplaced, score: scoreLayout(rooms, (id) => at.get(id)!) }
  }

  // The walk is greedy, so where it starts decides what it gets right. Try
  // every room as the start (well-connected ones first, and the one asked
  // for) and keep the embedding that lies least; each try is a millisecond.
  const cost = layoutCost
  const starts = new Map<string, MapRoom>()
  const asked = anchorId ? byId.get(anchorId) : undefined
  if (asked) starts.set(asked.id, asked)
  for (const r of [...rooms]
    .sort(
      (a, b) =>
        (links.get(b.id)?.length ?? 0) + (inbound.get(b.id)?.length ?? 0) -
          ((links.get(a.id)?.length ?? 0) + (inbound.get(a.id)?.length ?? 0)) || a.id.localeCompare(b.id)
    )
    .slice(0, MAX_STARTS)) {
    starts.set(r.id, r)
  }
  let best: ReturnType<typeof embed> | null = null
  const began = Date.now()
  let restart = 0
  search: for (;;) {
    for (const start of starts.values()) {
      for (const mode of ['best', 'bfs'] as const) {
        for (const bonus of [3, 1]) {
          order = mode
          exactBonus = bonus
          seed = restart * 7919 + 1
          const e = embed(start)
          if (!best || cost(e.score, e.unplaced.length) < cost(best.score, best.unplaced.length)) best = e
          // A layout that lies about nothing cannot be beaten.
          if (cost(best.score, best.unplaced.length) === 0) break search
          if (Date.now() - began > TIME_BUDGET_MS) break search
        }
      }
    }
    if (++restart >= RESTARTS) break
  }
  const chosen = best!

  // Polish both the best embedding and the layout already there, and keep
  // whichever lies least. A zone the player has tidied or dragged is often
  // one nudge from right, and a fresh walk can land further from it than
  // that; the anchor stays put through either.
  const fixed = new Set(asked ? [asked.id] : [])
  const polishBy = Date.now() + POLISH_BUDGET_MS
  const polished = refineLayout(rooms, chosen.at, { fixed, deadline: polishBy })
  const current = new Map(rooms.map((r) => [r.id, oldPos(r.id)]))
  const kept = refineLayout(rooms, current, { fixed, deadline: polishBy + POLISH_BUDGET_MS })
  const finalists = [
    { at: polished, unplaced: chosen.unplaced, score: scoreLayout(rooms, (id) => polished.get(id)!) },
    { at: kept, unplaced: [] as string[], score: scoreLayout(rooms, (id) => kept.get(id)!) }
  ]
  // On a tie the polished current layout wins: it moves the fewest rooms
  // and keeps the shape the player already knows.
  const final = cost(finalists[1].score) <= cost(finalists[0].score) ? finalists[1] : finalists[0]
  result.attempted = final.score

  // Moving rooms around for no gain is just churn.
  if (cost(final.score) >= cost(before)) {
    result.after = before
    return result
  }
  for (const r of rooms) {
    const p = final.at.get(r.id)!
    if (p.x !== r.x || p.y !== r.y || p.z !== r.z) result.moves[r.id] = p
  }
  result.unplaced = final.unplaced
  result.after = final.score
  return result
}

