import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { displayLinks, linkHasFocus } from '../src/renderer/src/map/displayLinks.ts'
import { routeDirectionalLink, isObstructed } from '../src/renderer/src/map/geometry.ts'
const map = createRequire(import.meta.url)('./fixtures/twisted-map.cjs')()
const before = JSON.stringify(map)
const rooms = Object.values(map.rooms).filter((r: any) => r.zoneId === 'maze') as any[]
const links = displayLinks(rooms, map)
const pair = links.filter((l) => [l.room.id, l.destination?.id].includes('hall') && [l.room.id, l.destination?.id].includes('chapel'))
assert.equal(pair.length, 1)
const hallExits = pair[0].room.id === 'hall' ? pair[0].outgoing : pair[0].returning
assert.deepEqual(hallExits.map((r) => r.exit.dir), ['n', null])
assert.equal(linkHasFocus(pair[0], { roomId: 'hall', exitIndex: 0 }), true)
assert.equal(linkHasFocus(pair[0], { roomId: 'hall', exitIndex: 4 }), true)
assert.equal(linkHasFocus(pair[0], { roomId: 'hall', exitIndex: 1 }), false)
const stub = links.find((l) => l.room.id === 'hall' && !l.destination)
assert.equal(stub?.outgoing[0].exit.dir, 'nw')
const oneWay = links.find((l) => l.room.id === 'hall' && l.destination?.id === 'cellar')!
assert.equal(oneWay.returning.length, 0)
const offLevel = links.find((l) => l.destination?.id === 'tower')!
assert.equal(offLevel.returning[0].exit.dir, 'd')
// Every recorded visible exit must remain addressable, regardless of room order.
for (const order of [rooms, [...rooms].reverse()]) {
  const display = displayLinks(order, map)
  for (const room of rooms) room.exits.forEach((_e: unknown, index: number) => {
    assert.equal(display.filter((link) => linkHasFocus(link, { roomId: room.id, exitIndex: index })).length, 1)
  })
}
assert.equal(JSON.stringify(map), before)
const occupied = (x: number, y: number) => rooms.some((r) => r.x === x && r.y === y)
const wire = routeDirectionalLink({x:0,y:0}, {x:4,y:0}, 'n', 'e', occupied)!
assert.deepEqual(wire[0], {x:0,y:0})
assert.deepEqual(wire[1], {x:0,y:-0.5})
assert.deepEqual(wire.at(-2), {x:4.5,y:0})
assert.deepEqual(wire.at(-1), {x:4,y:0})
for (let i = 1; i < wire.length; i++) assert.equal(isObstructed(wire[i-1], wire[i], occupied), false)
const reverse = routeDirectionalLink({x:4,y:0}, {x:0,y:0}, 'e', 'n', occupied)!
assert.deepEqual(reverse, [...wire].reverse())
const loop = routeDirectionalLink({x:0,y:0}, {x:0,y:0}, 'n', '', occupied)!
assert.deepEqual(loop[1], {x:0,y:-0.5})
assert.ok(loop.length >= 4)
for (let i = 1; i < loop.length; i++) assert.equal(isObstructed(loop[i-1], loop[i], occupied), false)
console.log('map-display-smoke: all exits preserved, grouped, traceable; map unchanged')
