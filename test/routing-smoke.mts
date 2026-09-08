import assert from 'node:assert/strict'
import { MapModel } from '../src/renderer/src/map/MapModel.ts'
import { findPath } from '../src/renderer/src/map/Pathfinder.ts'
import { RemoteMapModel } from '../src/renderer/src/map/RemoteMap.ts'

const model = new MapModel(null, () => {})
for (const id of ['a','b','c','d']) model.createRoom({ id, name: id })
model.addSpecialExit('a', 'enter portal', 'd')
model.setExitAt('a', 0, { cost: 10, door: true, doorName: 'portal' })
model.linkRooms('a', 'n', 'b', false)
model.linkRooms('b', 'e', 'c', false)
model.linkRooms('c', 'd', 'd', false)
assert.deepEqual(findPath(model, 'a', 'd')?.map((s) => s.command), ['n','e','d'])
model.updateRoom('b', { avoid: true })
assert.deepEqual(findPath(model, 'a', 'd')?.map((s) => s.command), ['enter portal'])
assert.equal(findPath(model, 'a', 'd')?.[0].openCommand, 'open portal')
model.setExitAt('a', 0, { avoid: true })
assert.equal(findPath(model, 'a', 'd'), null)
model.updateRoom('b', { avoid: false, cost: 20 })
model.setExitAt('a', 0, { avoid: false })
assert.equal(findPath(model, 'a', 'd')?.length, 1)
model.updateRoom('d', { avoid: true })
assert.equal(findPath(model, 'a', 'd'), null)
assert.deepEqual(findPath(model, 'a', 'a'), [])
const actions: any[] = []
const remote = new RemoteMapModel(structuredClone(model.map), (action) => actions.push(action))
remote.updateRoom('b', { cost: 3 }); remote.setExitAt('a', 0, { avoid: true })
assert.deepEqual(actions.map((a) => a.method), ['updateRoom','setExitAt'])
const reloaded = new MapModel(JSON.parse(JSON.stringify(remote.map)), () => {})
assert.equal(reloaded.room('b')?.cost, 3)
assert.equal(reloaded.room('a')?.exits[0].avoid, true)
model.flush(); remote.flush(); reloaded.flush()
console.log('ok weighted routes prefer longer safe paths, respect room/exit avoidance, preserve doors and survive persistence/popout edits')
