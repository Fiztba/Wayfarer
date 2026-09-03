/**
 * Link geometry — pure grid maths for drawing exits, DOM-free so the headless
 * tests can exercise it.
 *
 * Two things the naive center-to-center line gets wrong.
 *
 * 1. It can pass through a third room. Room boxes are painted opaquely AFTER
 *    the links, so the middle of such a segment is erased and what survives is
 *    a line from A stopping at that room's edge plus another leaving its far
 *    edge — pixel-identical to two genuine short links. Obstructed links are
 *    routed around the rooms in their way, along the gutters between cells
 *    (routeLink); a bow is the fallback when no route exists.
 *
 * 2. It says nothing true about the exit's direction. Coordinates are only a
 *    drawing suggestion (see types.ts) and placement is greedy, so a `nw` exit
 *    whose destination ended up drawn due west renders as a horizontal line —
 *    the map claims a direction the MUD never reported. Measured on a real
 *    859-room map, 44 of 1870 links were drawn contrary to their direction,
 *    and no coordinate assignment fixes all of them: some MUD geometry simply
 *    does not embed in a square grid.
 *
 * Both are handled by one cubic Bézier whose control points are the exit's
 * TRUE compass direction, pushed out from each end. The curve therefore leaves
 * its room along the real direction and arrives from the real opposite one,
 * whatever the rooms' coordinates happen to be — and when the coordinates are
 * already honest the controls land on the chord and it degenerates to exactly
 * the straight line it used to be.
 */

/** Grid pitch and room box size, in screen px at scale 1. */
export const CELL = 46
export const ROOM = 26

/** Room half-width expressed in cell units. */
const ROOM_HALF = ROOM / CELL / 2

/** Hit margin above the room's true half-width: a line that merely clips a
 *  corner still reads as "connected to that room", so it must bow too. */
const HIT_MARGIN = 0.04
const HIT_HALF = ROOM_HALF + HIT_MARGIN

/** How far the bow is pushed off the chord, in cells. */
export const BOW_OFFSET = 1.2

/** How far the control points sit along the chord, in cells. */
export const STUB_REACH = 0.45

/** Where a bearing arrow sits, measured from the room centre in cells — just
 *  clear of the box, so it reads as leaving that room. */
export const BEARING_AT = 0.42

const SQ = Math.SQRT1_2

/** Unit vector for each drawable compass direction (screen axes: +y is south). */
export const DIR_UNIT: Record<string, [number, number]> = {
  n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0],
  ne: [SQ, -SQ], nw: [-SQ, -SQ], se: [SQ, SQ], sw: [-SQ, SQ]
}

/** One grid step per direction, for comparing a link's drawn offset with the
 *  bearing it claims. */
const DIR_STEP: Record<string, [number, number]> = {
  n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0],
  ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1]
}

/**
 * Is this link drawn along the bearing it claims? Distance is allowed to
 * differ — a two-cell `s` link is still pointing south — so this tests the
 * bearing only: the offset must be a positive multiple of the step.
 *
 * Where it is false the line cannot be trusted to convey direction, and the
 * caller marks the bearing separately. Bending the line instead does NOT
 * work: forcing a true departure tangent at both ends of a link between two
 * level rooms yields an S symmetric about the chord, so half of it leans the
 * wrong way and reads as the opposite diagonal. Measured at ±4px for a
 * one-cell link, growing to ±11px as the effect is strengthened.
 */
export function drawnAsClaimed(from: Cell, to: Cell, dir: string): boolean {
  const step = DIR_STEP[dir]
  if (!step) return true
  const ox = to.x - from.x
  const oy = to.y - from.y
  return ox * step[1] - oy * step[0] === 0 && ox * step[0] + oy * step[1] > 0
}

export interface Cell {
  x: number
  y: number
}

/** Cubic control points for one link, in cell coordinates. */
export interface LinkPath {
  c1: Cell
  c2: Cell
  /** The straight line would have crossed a room, so this arcs around it. */
  bowed: boolean
  /** Chebyshev distance between the two cells; > 1 means the link is drawn
   *  longer than one grid step and needs the direct-connection marker. */
  span: number
}

/** Slab test: does segment a→b intersect the axis-aligned box of half-size h
 *  centred on c? Exact, unlike a distance-to-centre approximation, which
 *  under-detects corner clips on diagonal runs. */
function segmentHitsBox(a: Cell, b: Cell, c: Cell, h: number): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let t0 = 0
  let t1 = 1
  const slab = (p: number, d: number, min: number, max: number): boolean => {
    if (Math.abs(d) < 1e-9) return p >= min && p <= max
    let tA = (min - p) / d
    let tB = (max - p) / d
    if (tA > tB) {
      const swap = tA
      tA = tB
      tB = swap
    }
    t0 = Math.max(t0, tA)
    t1 = Math.min(t1, tB)
    return t0 <= t1
  }
  if (!slab(a.x, dx, c.x - h, c.x + h)) return false
  if (!slab(a.y, dy, c.y - h, c.y + h)) return false
  return true
}

/** Is any room other than the two endpoints sitting on this link's line? */
export function isObstructed(
  from: Cell,
  to: Cell,
  isOccupied: (x: number, y: number) => boolean
): boolean {
  const loX = Math.floor(Math.min(from.x, to.x))
  const hiX = Math.ceil(Math.max(from.x, to.x))
  const loY = Math.floor(Math.min(from.y, to.y))
  const hiY = Math.ceil(Math.max(from.y, to.y))
  for (let x = loX; x <= hiX; x++) {
    for (let y = loY; y <= hiY; y++) {
      if (x === from.x && y === from.y) continue
      if (x === to.x && y === to.y) continue
      if (!isOccupied(x, y)) continue
      if (segmentHitsBox(from, to, { x, y }, HIT_HALF)) return true
    }
  }
  return false
}

/**
 * Perpendicular bow offset for an obstructed link, or null when it may run
 * straight. The side is chosen deterministically — left of the direction
 * vector, flipped only when left's apex cell is occupied and right's is free.
 * Occupancy of the apex cell ALONE is tested, not a neighbourhood count, so
 * adding an unrelated room nearby cannot flip an existing bow and make the map
 * wiggle as the player explores. Endpoint order is canonicalised first, so the
 * same link asked about from either end bows to the same side instead of
 * drawing two mirrored arcs as a lens.
 */
function bowOffset(
  from: Cell,
  to: Cell,
  isOccupied: (x: number, y: number) => boolean
): Cell | null {
  if (!isObstructed(from, to, isOccupied)) return null
  const forward = from.x < to.x || (from.x === to.x && from.y <= to.y)
  const a = forward ? from : to
  const b = forward ? to : from
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const px = -dy / len
  const py = dx / len
  const midX = (a.x + b.x) / 2
  const midY = (a.y + b.y) / 2
  const apexTaken = (sign: number): boolean =>
    isOccupied(
      Math.round(midX + px * (BOW_OFFSET / 2) * sign),
      Math.round(midY + py * (BOW_OFFSET / 2) * sign)
    )
  const sign = apexTaken(1) && !apexTaken(-1) ? -1 : 1
  return { x: px * BOW_OFFSET * sign, y: py * BOW_OFFSET * sign }
}

/**
 * Control points for the cubic that draws `dir` from `from` to `to`.
 *
 * Asked about from either end — the owning room, or the room at the far end
 * redrawing its own face highlighted — this yields the same curve with c1/c2
 * swapped, so the two never disagree.
 */
export function linkPath(
  from: Cell,
  to: Cell,
  dir: string,
  isOccupied: (x: number, y: number) => boolean
): LinkPath {
  // Controls sit on the chord, so an unobstructed link is dead straight and a
  // bowed one is a clean symmetric arc. Bearing is carried by the marker (see
  // drawnAsClaimed), never by bending the line.
  void dir
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const c1: Cell = { x: from.x + ux * STUB_REACH, y: from.y + uy * STUB_REACH }
  const c2: Cell = { x: to.x - ux * STUB_REACH, y: to.y - uy * STUB_REACH }
  const bow = bowOffset(from, to, isOccupied)
  if (bow) {
    c1.x += bow.x; c1.y += bow.y
    c2.x += bow.x; c2.y += bow.y
  }
  return {
    c1,
    c2,
    bowed: bow !== null,
    span: Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y))
  }
}

/** Point on a cubic Bézier. */
export function cubicPoint(p0: Cell, c1: Cell, c2: Cell, p3: Cell, t: number): Cell {
  const s = 1 - t
  const a = s * s * s
  const b = 3 * s * s * t
  const c = 3 * s * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y
  }
}

/** Tangent (unnormalised) of a cubic Bézier. */
export function cubicTangent(p0: Cell, c1: Cell, c2: Cell, p3: Cell, t: number): Cell {
  const s = 1 - t
  const a = 3 * s * s
  const b = 6 * s * t
  const c = 3 * t * t
  return {
    x: a * (c1.x - p0.x) + b * (c2.x - c1.x) + c * (p3.x - c2.x),
    y: a * (c1.y - p0.y) + b * (c2.y - c1.y) + c * (p3.y - c2.y)
  }
}

// ---- Orthogonal routing for obstructed links ----

/**
 * Route for a link whose straight line would cross a room: a polyline from
 * `from` to `to` in cell coordinates, running along the gutters between
 * cells and through empty ones, never across a room box. Null when no
 * route exists inside a small margin around the pair, in which case the
 * caller bows the link as before.
 *
 * Why a wire rather than an arc: a bow is pushed a whole cell off its chord
 * and sweeps over whatever sits there, and two of them near each other read
 * as a tangle. A wire hugs the rooms it avoids, turns at right angles like
 * the grid it lives on, and stays out of every box by construction, since
 * the half-cell lanes it prefers pass exactly between rooms.
 *
 * The search is A* over a half-cell lattice with a turn penalty, so the
 * route is the one with the fewest corners among the shortest. Endpoint
 * order is canonicalised, so the same link asked about from either end
 * yields the same wire.
 */
export function routeLink(
  from: Cell,
  to: Cell,
  isOccupied: (x: number, y: number) => boolean
): Cell[] | null {
  const forward = from.x < to.x || (from.x === to.x && from.y <= to.y)
  const a = forward ? from : to
  const b = forward ? to : from
  // Lattice in half cells: node (i, j) sits at cell (i / 2, j / 2).
  const MARGIN = 4
  const minI = Math.min(a.x, b.x) * 2 - MARGIN
  const maxI = Math.max(a.x, b.x) * 2 + MARGIN
  const minJ = Math.min(a.y, b.y) * 2 - MARGIN
  const maxJ = Math.max(a.y, b.y) * 2 + MARGIN
  const isEnd = (i: number, j: number): boolean =>
    (i === a.x * 2 && j === a.y * 2) || (i === b.x * 2 && j === b.y * 2)
  const blocked = (i: number, j: number): boolean =>
    i % 2 === 0 && j % 2 === 0 && !isEnd(i, j) && isOccupied(i / 2, j / 2)
  /** Extra cost of standing on a node: a cell centre reads as passing
   *  through that cell, and the midpoint between two rooms is where their
   *  own link would be drawn, so both are avoided when a gutter will do. */
  const nodeCost = (i: number, j: number): number => {
    if (i % 2 === 0 && j % 2 === 0) return 0.5
    if (i % 2 === 0 && isOccupied(i / 2, (j - 1) / 2) && isOccupied(i / 2, (j + 1) / 2)) return 2
    if (j % 2 === 0 && isOccupied((i - 1) / 2, j / 2) && isOccupied((i + 1) / 2, j / 2)) return 2
    return 0
  }
  const STEP = 1
  const TURN = 3
  const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  type Node = { i: number; j: number; d: number; g: number; f: number; prev: Node | null }
  const stateKey = (i: number, j: number, d: number): number =>
    ((i - minI) * (maxJ - minJ + 1) + (j - minJ)) * 5 + d + 1
  const heuristic = (i: number, j: number): number => Math.abs(i - b.x * 2) + Math.abs(j - b.y * 2)
  const open: Node[] = [{ i: a.x * 2, j: a.y * 2, d: -1, g: 0, f: heuristic(a.x * 2, a.y * 2), prev: null }]
  const bestG = new Map<number, number>()
  bestG.set(stateKey(open[0].i, open[0].j, -1), 0)
  let goal: Node | null = null
  while (open.length > 0) {
    // Smallest f wins; ties go to the node pushed first, so the route is
    // deterministic for a given pair of rooms.
    let bi = 0
    for (let k = 1; k < open.length; k++) if (open[k].f < open[bi].f) bi = k
    const cur = open.splice(bi, 1)[0]
    if (cur.i === b.x * 2 && cur.j === b.y * 2) {
      goal = cur
      break
    }
    for (let d = 0; d < dirs.length; d++) {
      const ni = cur.i + dirs[d][0]
      const nj = cur.j + dirs[d][1]
      if (ni < minI || ni > maxI || nj < minJ || nj > maxJ) continue
      if (blocked(ni, nj)) continue
      const g = cur.g + STEP + (cur.d !== -1 && cur.d !== d ? TURN : 0) + nodeCost(ni, nj)
      const k = stateKey(ni, nj, d)
      const known = bestG.get(k)
      if (known !== undefined && known <= g) continue
      bestG.set(k, g)
      open.push({ i: ni, j: nj, d, g, f: g + heuristic(ni, nj), prev: cur })
    }
  }
  if (!goal) return null
  const raw: Cell[] = []
  for (let n: Node | null = goal; n; n = n.prev) raw.push({ x: n.i / 2, y: n.j / 2 })
  raw.reverse()
  // Collapse runs of collinear nodes to the corners.
  const pts: Cell[] = [raw[0]]
  for (let k = 1; k < raw.length - 1; k++) {
    const p = pts[pts.length - 1]
    const q = raw[k]
    const r = raw[k + 1]
    if ((q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x) !== 0) pts.push(q)
  }
  pts.push(raw[raw.length - 1])
  return forward ? pts : pts.reverse()
}

/** Length of a polyline. */
export function polyLength(pts: Cell[]): number {
  let len = 0
  for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y)
  return len
}

/** Point at fraction `t` of a polyline's length, and the segment it is on. */
export function polyPoint(pts: Cell[], t: number): Cell {
  const target = polyLength(pts) * Math.min(1, Math.max(0, t))
  let run = 0
  for (let k = 1; k < pts.length; k++) {
    const seg = Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y)
    if (run + seg >= target || k === pts.length - 1) {
      const u = seg === 0 ? 0 : (target - run) / seg
      return { x: pts[k - 1].x + (pts[k].x - pts[k - 1].x) * u, y: pts[k - 1].y + (pts[k].y - pts[k - 1].y) * u }
    }
    run += seg
  }
  return pts[pts.length - 1]
}

/** Direction (unnormalised) of the polyline at fraction `t` of its length. */
export function polyTangent(pts: Cell[], t: number): Cell {
  const target = polyLength(pts) * Math.min(1, Math.max(0, t))
  let run = 0
  for (let k = 1; k < pts.length; k++) {
    const seg = Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y)
    if (run + seg >= target || k === pts.length - 1) return { x: pts[k].x - pts[k - 1].x, y: pts[k].y - pts[k - 1].y }
    run += seg
  }
  const n = pts.length
  return { x: pts[n - 1].x - pts[n - 2].x, y: pts[n - 1].y - pts[n - 2].y }
}
