/**
 * Link geometry — pure grid maths for drawing exits, DOM-free so the headless
 * tests can exercise it.
 *
 * Rooms sit on integer cells and a link is drawn between two cell centres.
 * When the cells are not adjacent that straight segment can pass through a
 * third room, and since room boxes are painted opaquely AFTER the links, the
 * middle of the segment is erased. What survives is a line from A stopping at
 * the intervening room's edge and another leaving its far edge — pixel-
 * identical to two genuine short links. A player reads connections that do not
 * exist. Obstructed links are therefore bowed aside instead of drawn straight.
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

/** How far the bow's control point is pushed off the chord, in cells. A
 *  quadratic curve's apex sits at half of this, which clears a room box at
 *  every zoom level (the offset scales with the view like everything else). */
export const BOW_OFFSET = 1.2

export interface Cell {
  x: number
  y: number
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
 * Control point for a quadratic bow around whatever the straight link would
 * cross, or null when it may be drawn straight.
 *
 * The side is chosen deterministically — left of the direction vector, flipped
 * only when left's apex cell is occupied and right's is free. Occupancy of the
 * apex cell ALONE is tested, not a neighbourhood count, so adding an unrelated
 * room nearby cannot flip an existing bow and make the map wiggle as the
 * player explores.
 */
export function bowControl(
  from: Cell,
  to: Cell,
  isOccupied: (x: number, y: number) => boolean
): Cell | null {
  if (!isObstructed(from, to, isOccupied)) return null
  // Endpoint order must not change the answer. The same link is asked about
  // from both ends — once for its own face, again when the room at the far end
  // is selected and redraws it highlighted — and two opposite bows would draw
  // a lens. Canonicalise the direction before taking the perpendicular.
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
  return { x: midX + px * BOW_OFFSET * sign, y: midY + py * BOW_OFFSET * sign }
}

/** Point on a quadratic Bézier at t=0.5 — where a door tick belongs when the
 *  link is bowed. (The tangent there is parallel to the chord, so the tick's
 *  angle is unchanged.) */
export function bowMidpoint(from: Cell, control: Cell, to: Cell): Cell {
  return {
    x: (from.x + 2 * control.x + to.x) / 4,
    y: (from.y + 2 * control.y + to.y) / 4
  }
}
