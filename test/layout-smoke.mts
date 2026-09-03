/**
 * Headless checks for drawing links the grid cannot draw straight, and for
 * the tidy's scoring and polish pass.
 *
 * Run with: node --experimental-strip-types test/layout-smoke.mts
 */
import { isObstructed, polyPoint, polyTangent, routeLink, type Cell } from '../src/renderer/src/map/geometry.ts'
import { layoutCost, refineLayout, relayoutZone, scoreLayout, type Pos } from '../src/renderer/src/map/relayout.ts'
import type { MapExit, MapRoom, MudMap } from '../src/renderer/src/map/types.ts'

let passed = 0
let failed = 0
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`)
}

const occupiedAt = (cells: Cell[]) => (x: number, y: number) => cells.some((c) => c.x === x && c.y === y)

// ---- routing: a wire around rooms in the way ----
{
  // A east to B, with two rooms sitting on the straight line between them.
  const rooms = [{ x: 1, y: 0 }, { x: 2, y: 0 }]
  const occ = occupiedAt([{ x: 0, y: 0 }, { x: 3, y: 0 }, ...rooms])
  const route = routeLink({ x: 0, y: 0 }, { x: 3, y: 0 }, occ)!
  check('route: a wire is found', route !== null, true)
  check('route: it starts at the source room', route[0], { x: 0, y: 0 })
  check('route: and ends at the destination', route[route.length - 1], { x: 3, y: 0 })
  const throughARoom = route.some((p, i) => {
    if (i === 0) return false
    const q = route[i - 1]
    // Sample each segment finely and see whether it enters a box.
    for (let t = 0; t <= 1; t += 0.05) {
      const x = q.x + (p.x - q.x) * t
      const y = q.y + (p.y - q.y) * t
      if (rooms.some((r) => Math.abs(x - r.x) < 0.3 && Math.abs(y - r.y) < 0.3)) return true
    }
    return false
  })
  check('route: it never enters a room box', throughARoom, false)
  const orthogonal = route.every((p, i) => i === 0 || p.x === route[i - 1].x || p.y === route[i - 1].y)
  check('route: every segment is axis-aligned', orthogonal, true)
  check('route: corners only, no collinear points', route.length <= 4, true)
  const back = routeLink({ x: 3, y: 0 }, { x: 0, y: 0 }, occ)!
  check('route: asked from the other end it is the same wire reversed', back, [...route].reverse())
  const straight = routeLink({ x: 0, y: 0 }, { x: 3, y: 0 }, occupiedAt([{ x: 0, y: 0 }, { x: 3, y: 0 }]))!
  check('route: with nothing in the way it is the straight line', straight, [{ x: 0, y: 0 }, { x: 3, y: 0 }])
}

// ---- polyline sampling ----
{
  const pts = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }]
  check('poly: start', polyPoint(pts, 0), { x: 0, y: 0 })
  check('poly: end', polyPoint(pts, 1), { x: 2, y: 2 })
  check('poly: the midpoint is the corner', polyPoint(pts, 0.5), { x: 2, y: 0 })
  check('poly: a quarter of the way along runs east', polyTangent(pts, 0.25), { x: 2, y: 0 })
  check('poly: three quarters along runs south', polyTangent(pts, 0.75), { x: 0, y: 2 })
}

// ---- scoring: what the renderer would have to draw ----
function room(id: string, x: number, y: number, exits: Array<[string, string]>, z = 0): MapRoom {
  return {
    id,
    name: id,
    zoneId: 'z',
    x,
    y,
    z,
    exits: exits.map(([dir, to]) => ({ dir, to, door: false }) as MapExit)
  }
}
function mapOf(rooms: MapRoom[]): MudMap {
  return { version: 1, zones: [{ id: 'z', name: 'Z' }], rooms: Object.fromEntries(rooms.map((r) => [r.id, r])), waypoints: [] }
}
const at = (rooms: MapRoom[]) => (id: string): Pos => {
  const r = rooms.find((x) => x.id === id)!
  return { x: r.x, y: r.y, z: r.z }
}
{
  // A east to B three cells away, off by one row, with C clipping the line:
  // not a straight run, so the old cells-between test saw nothing; the
  // renderer's own test sees the corner it clips.
  const rooms = [room('A', 0, 0, [['e', 'B']]), room('B', 3, 1, [['w', 'A']]), room('C', 2, 1, [])]
  check('score: the renderer would have to route this link', isObstructed({ x: 0, y: 0 }, { x: 3, y: 1 }, occupiedAt([{ x: 2, y: 1 }])), true)
  const s = scoreLayout(rooms, at(rooms))
  check('score: counted as through, both faces', s.through, 2)
  check('score: and as a lie about direction drawn across the map', [s.contrary, s.contraryFar], [2, 2])
  check('score: a diagonal between neighbours is a lesser lie', layoutCost({ contrary: 2, contraryFar: 0, through: 0, long: 0, stretch: 0, crossings: 0 }) < layoutCost({ contrary: 2, contraryFar: 2, through: 0, long: 0, stretch: 0, crossings: 0 }), true)
  check('score: a link drawn five cells long claims more ground than one drawn two', layoutCost({ contrary: 0, contraryFar: 0, through: 0, long: 1, stretch: 4, crossings: 0 }) > layoutCost({ contrary: 0, contraryFar: 0, through: 0, long: 1, stretch: 1, crossings: 0 }), true)
}
{
  // Two links crossing each other.
  const rooms = [
    room('A', 0, 0, [['e', 'B']]), room('B', 2, 0, [['w', 'A']]),
    room('C', 1, -1, [['s', 'D']]), room('D', 1, 1, [['n', 'C']])
  ]
  check('score: two links across each other count one crossing', scoreLayout(rooms, at(rooms)).crossings, 1)
  const fan = [room('A', 0, 0, [['e', 'B'], ['n', 'C']]), room('B', 1, 0, []), room('C', 0, -1, [])]
  check('score: links fanning out of one room do not cross', scoreLayout(fan, at(fan)).crossings, 0)
}

// ---- polish: rooms nudged to where their links are happy ----
{
  // B belongs directly east of A but was left two cells out.
  const rooms = [room('A', 0, 0, [['e', 'B']]), room('B', 2, 0, [['w', 'A']])]
  const out = refineLayout(rooms, new Map(rooms.map((r) => [r.id, at(rooms)(r.id)])), { fixed: new Set(['A']) })
  check('polish: the long link is pulled in', out.get('B'), { x: 1, y: 0, z: 0 })
  check('polish: the fixed room did not move', out.get('A'), { x: 0, y: 0, z: 0 })
}
{
  // A ring of four around a block of two: the corners have to stretch.
  //   NW - NE
  //   |     |      with I1 - I2 inside, I1 north of SW? no: I1 east of NW's
  //   SW - SE      south neighbour... keep it small: NW e NE, NE s SE, SE w SW, SW n NW
  // and the block I1 e I2 sits between NW and NE on the same row, so the
  // greedy walk that placed NE right next to NW draws NW->NE through I1.
  const rooms = [
    room('NW', 0, 0, [['e', 'NE'], ['s', 'SW']]),
    room('NE', 1, 0, [['w', 'NW'], ['s', 'SE']]),
    room('SE', 1, 1, [['n', 'NE'], ['w', 'SW']]),
    room('SW', 0, 1, [['n', 'NW'], ['e', 'SE']]),
    room('I1', 2, 0, [['e', 'I2']]),
    room('I2', 3, 0, [['w', 'I1']])
  ]
  // Start from a bad layout: NE and SE dropped on the far side of the block.
  const start = new Map<string, Pos>([
    ['NW', { x: 0, y: 0, z: 0 }], ['SW', { x: 0, y: 1, z: 0 }],
    ['I1', { x: 1, y: 0, z: 0 }], ['I2', { x: 2, y: 0, z: 0 }],
    ['NE', { x: 3, y: 0, z: 0 }], ['SE', { x: 3, y: 1, z: 0 }]
  ])
  const before = layoutCost(scoreLayout(rooms, (id) => start.get(id)!))
  // The block stays; the ring has to step around it, and no single room
  // can (moving one corner alone bends its link into the block).
  const out = refineLayout(rooms, start, { fixed: new Set(['I1', 'I2']) })
  const after = layoutCost(scoreLayout(rooms, (id) => out.get(id)!))
  check('polish: a ring around a block ends up cheaper to draw', after < before, true)
  check('polish: and draws no link through a room', scoreLayout(rooms, (id) => out.get(id)!).through, 0)
}

// ---- tidy end to end: the polish is part of the tidy, and a tidy zone stays put ----
{
  const rooms = [room('A', 0, 0, [['e', 'B']]), room('B', 3, 1, [['w', 'A']]), room('C', 2, 1, [])]
  const map = mapOf(rooms)
  const res = relayoutZone(map, 'z', 'A')
  check('tidy: the layout that lies less is found', layoutCost(res.after) < layoutCost(res.before), true)
  check('tidy: B is directly east of A', res.moves['B'], { x: 1, y: 0, z: 0 })
  check('tidy: the anchor stays put', res.moves['A'], undefined)
  for (const [id, p] of Object.entries(res.moves)) Object.assign(map.rooms[id], p)
  const again = relayoutZone(map, 'z', 'A')
  check('tidy: nothing moves on a second tidy', Object.keys(again.moves).length, 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
