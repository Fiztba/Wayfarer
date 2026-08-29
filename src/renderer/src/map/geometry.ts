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
 *    bowed aside.
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

/** How far the direction-true control points reach out of each room, in cells.
 *  Big enough to read as a departure angle, small enough that a one-cell link
 *  stays a gentle S rather than a loop. */
export const STUB_REACH = 0.45

const SQ = Math.SQRT1_2

/** Unit vector for each drawable compass direction (screen axes: +y is south). */
export const DIR_UNIT: Record<string, [number, number]> = {
  n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0],
  ne: [SQ, -SQ], nw: [-SQ, -SQ], se: [SQ, SQ], sw: [-SQ, SQ]
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
  const u = DIR_UNIT[dir] ?? [to.x - from.x, to.y - from.y]
  const c1: Cell = { x: from.x + u[0] * STUB_REACH, y: from.y + u[1] * STUB_REACH }
  const c2: Cell = { x: to.x - u[0] * STUB_REACH, y: to.y - u[1] * STUB_REACH }
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
