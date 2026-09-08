import assert from 'node:assert/strict'
import { MapModel } from '../src/renderer/src/map/MapModel.ts'
import { MapTracker } from '../src/renderer/src/map/MapTracker.ts'
import { hashText } from '../src/renderer/src/map/types.ts'

const descriptions = {
  square: 'The two largest cobblestone roads intersect at a large plaza with a fountain.',
  hall: 'The tavern stands to the east and the smithy stands to the west.',
  smithy: 'A forge burns brightly beside the anvil.',
  west: 'The smithy stands to the north of this cobblestone street.',
  east: 'The tavern stands to the north of this cobblestone street.'
}
function fixture() {
  const model = new MapModel(null, () => {})
  const tracker = new MapTracker(model, { info: () => {} })
  const see = (name: string, body: string, exits: string) => {
    tracker.onLine(name); tracker.onLine(body); tracker.onLine(`Exits: ${exits}`)
  }
  return { model, tracker, see, close() { tracker.dispose(); model.flush() } }
}
{
  const f = fixture()
  try {
    f.see('Blackmoor Square', descriptions.square, 'north east south west up')
    const square = f.tracker.currentRoom!
    f.tracker.onCommand('n'); f.see('Hall Street', descriptions.hall, 'north east south west')
    f.tracker.onCommand('w'); f.see('Sword and Steel Smithy', descriptions.smithy, 'north east south')
    f.tracker.onCommand('s'); f.see('Main Street', descriptions.west, 'north east south west')
    const west = f.tracker.currentRoom!
    f.tracker.onCommand('e'); f.see('Blackmoor Square', descriptions.square, 'north east south west up')
    assert.equal(f.tracker.currentRoomId, square.id)
    assert.equal(f.tracker.speculative, false, 'a uniquely matching recently visited square closes the loop')
    assert.equal(f.model.exitOf(west, 'e')?.to, square.id)
    assert.equal(Object.keys(f.model.map.rooms).length, 4)
    f.tracker.onCommand('e'); f.see('Main Street', descriptions.east, 'north east west')
    assert.equal(Object.keys(f.model.map.rooms).length, 5, 'exploring east must not duplicate the square')
    f.tracker.onCommand('n'); f.tracker.onLine('The door is closed.')
    f.tracker.onCommand('w'); f.see('Blackmoor Square', descriptions.square, 'north east south west up')
    assert.equal(f.tracker.currentRoomId, square.id, 'a failed door attempt does not shift the return movement')
    console.log('ok Blackmoor north-west-south-east loop returns to the original square and exploration adds only the new street')
  } finally { f.close() }
}

// A unique, adjacent description match can survive an uncharted exit, but
// geometry alone and contradictory saved links cannot grant that exception.
for (const variant of ['supported', 'no-description', 'distant', 'duplicate', 'contradiction']) {
  const f = fixture()
  try {
    const square = f.model.createRoom({ name: 'Blackmoor Square', x: variant === 'distant' ? 8 : 0, y: 0,
      descHashes: variant === 'no-description' ? [] : [hashText(descriptions.square)],
      exits: [{ dir: 'e', to: null, door: false }, { dir: 'w', to: null, door: false }] })
    const west = f.model.createRoom({ name: 'West Approach', x: -1, y: 0,
      exits: [{ dir: 'e', to: null, door: false }] })
    if (variant === 'duplicate') f.model.createRoom({ ...square, id: undefined, x: 10 })
    if (variant === 'contradiction') {
      const other = f.model.createRoom({ name: 'Wrong Destination', x: 10, y: 10 })
      f.model.linkRooms(square.id, 'e', other.id, false)
    }
    f.tracker.setCurrentRoom(west.id)
    f.tracker.onCommand('e'); f.see('Blackmoor Square', descriptions.square, 'east west')
    assert.equal(f.tracker.speculative, true, 'a first match alone remains tentative')
    f.tracker.onCommand('e'); f.see('Main Street', descriptions.east, 'north east west')
    if (variant === 'supported' || variant === 'duplicate') {
      assert.equal(f.model.exitOf(west, 'e')?.to, square.id)
      assert.equal(Object.keys(f.model.map.rooms).length, variant === 'duplicate' ? 4 : 3)
    } else {
      assert.notEqual(f.model.exitOf(west, 'e')?.to, square.id, `${variant} cannot confirm on geometry`)
    }
  } finally { f.close() }
}
console.log('ok unexplored exits preserve supported re-entry; weak and contradictory matches remain guarded')

// Bridge -> two distinct Main Street rooms -> square -> back east -> shop.
// The first street has an unexplored east exit; the second an unexplored east
// exit too. Do not lose the anchored route before the player turns south.
{
  const f = fixture()
  try {
    const add = (id: string, name: string, x: number, body: string, dirs: string[]) => f.model.createRoom({
      id, name, x, y: 0, descHashes: [hashText(body)],
      exits: dirs.map(dir => ({ dir: dir as 'e' | 'w' | 's', to: null, door: false }))
    })
    const square = add('square', 'Blackmoor Square', 0, descriptions.square, ['e','w'])
    const tavern = add('tavern', 'Main Street', 1, descriptions.east, ['e','w'])
    const mounts = add('mounts', 'Main Street', 2, 'The inn is north and the animal shop is south.', ['e','w','s'])
    const bridge = add('bridge', 'Bridge on Main Street', 3, 'A sturdy stone bridge crosses the river.', ['e','w'])
    f.model.linkRooms(square.id, 'e', tavern.id, true)
    f.model.linkRooms(mounts.id, 'w', tavern.id, false)
    f.tracker.setCurrentRoom(bridge.id)
    f.tracker.onCommand('w'); f.see(mounts.name, 'The inn is north and the animal shop is south.', 'east west south')
    assert.equal(f.tracker.speculative, true)
    f.tracker.onCommand('w'); f.see(tavern.name, descriptions.east, 'east west')
    assert.equal(f.tracker.speculative, false, 'unique prose + expected location + predicted distinct room confirms')
    f.tracker.onCommand('w'); f.see(square.name, descriptions.square, 'east west')
    f.tracker.onCommand('e'); f.see(tavern.name, descriptions.east, 'east west')
    f.tracker.onCommand('e'); f.see(mounts.name, 'The inn is north and the animal shop is south.', 'east west south')
    f.tracker.onCommand('s'); f.see("Lothend's Companions and Mounts", 'Animals fill the cages behind the long wooden counter.', 'north')
    assert.equal(f.tracker.lost, false)
    assert.equal(f.tracker.speculative, false)
    assert.equal(f.tracker.currentRoom?.name, "Lothend's Companions and Mounts")
    assert.deepEqual([f.tracker.currentRoom?.x, f.tracker.currentRoom?.y], [2, 1])
    assert.equal(f.model.exitOf(mounts, 's')?.to, f.tracker.currentRoomId)
    assert.equal(Object.keys(f.model.map.rooms).length, 5)
    console.log('ok return from the bridge followed by south enters the shop, not the stale bridge anchor')
  } finally { f.close() }
}

// A cloned Crystal Street south of the intersection cannot make north look
// like south. A second north that contradicts its mapped exit creates new rooms.
{
  const f = fixture()
  try {
    const body = 'Residential buildings lie east and the river lies west behind a wooden fence.'
    const intersection = f.model.createRoom({ name: 'Intersection of Crystal Street and Main Street', x: 0, y: 0,
      exits: [{ dir: 'n', to: null, door: false }, { dir: 's', to: null, door: false }] })
    const old = f.model.createRoom({ name: 'Crystal Street', x: 0, y: 1, descHashes: [hashText(body)],
      exits: [{ dir: 'n', to: null, door: false }, { dir: 's', to: null, door: false }] })
    f.model.linkRooms(old.id, 'n', intersection.id, false)
    f.tracker.setCurrentRoom(intersection.id)
    f.tracker.onCommand('n'); f.see('Crystal Street', body, 'north south')
    assert.deepEqual(f.tracker.confidence.expectedPosition, { x: 0, y: -1, z: 0, zoneId: intersection.zoneId })
    assert.equal(f.model.exitOf(intersection, 'n')?.to, null)
    f.tracker.onCommand('n'); f.see('Crystal Street', body, 'north south')
    assert.equal(f.tracker.speculative, false)
    assert.deepEqual([f.tracker.currentRoom?.x, f.tracker.currentRoom?.y], [0, -2])
    const north = f.model.room(f.model.exitOf(intersection, 'n')?.to ?? '')!
    assert.deepEqual([north.x, north.y], [0, -1])
    assert.equal(f.model.exitOf(north, 'n')?.to, f.tracker.currentRoomId)
    assert.equal(f.model.exitOf(old, 'n')?.to, intersection.id)
    assert.equal(Object.keys(f.model.map.rooms).length, 4)
    f.tracker.onCommand('n'); f.see('Crystal Street', body, 'north south')
    f.tracker.onCommand('n'); f.see('Intersection of Crystal Street and Wyverns Way', 'Wyverns Way crosses Crystal Street at this cobbled intersection.', 'north east south west')
    assert.equal(f.tracker.lost, false)
    assert.equal(f.tracker.speculative, false)
    assert.deepEqual([f.tracker.currentRoom?.x, f.tracker.currentRoom?.y], [0, -4])
    assert.equal(Object.keys(f.model.map.rooms).length, 6)
    let cursor = intersection
    for (let y = -1; y >= -4; y--) {
      cursor = f.model.room(f.model.exitOf(cursor, 'n')?.to ?? '')!
      assert.ok(cursor, 'every northbound exit is fully linked')
      assert.equal(cursor.y, y)
    }
    console.log('ok north displays north provisionally, then a disproved clone becomes two new connected rooms')
  } finally { f.close() }
}

{
  const f = fixture()
  try {
    const street = f.model.createRoom({ name: 'Main Street', x: 0, y: 0, descHashes: [hashText(descriptions.east)], exits: [{ dir: 'e', to: null, door: false }] })
    const body = 'The gray cobblestone street crosses the river on a stone bridge.'
    const bridge = f.model.createRoom({ name: 'Bridge on Main Street', x: 1, y: 0, descHashes: [hashText(body)], exits: [{ dir: 'w', to: null, door: false }] })
    f.tracker.setCurrentRoom(street.id)
    f.tracker.onCommand('e'); f.see(bridge.name, body, 'west')
    assert.equal(f.tracker.speculative, true)
    f.tracker.onCommand('w'); f.see(street.name, descriptions.east, 'east')
    assert.equal(f.tracker.speculative, false)
    assert.equal(f.model.exitOf(street, 'e')?.to, bridge.id)
    assert.equal(f.model.exitOf(bridge, 'w')?.to, street.id)
    assert.equal(f.tracker.currentRoomId, street.id)
    assert.equal(Object.keys(f.model.map.rooms).length, 2)
    console.log('ok walking east to the bridge and back completes both previously unexplored exits')
  } finally { f.close() }
}

// A repeated street run must be retained when it reaches a mapped landmark,
// and retracing it must reuse the cathedral instead of replaying a duplicate.
{
  const f = fixture()
  try {
    const body = 'Residential buildings lie to the north and south. The street stretches east and west.'
    const add = (name, x, desc, dirs) => f.model.createRoom({ name, x, y: 0, descHashes: [hashText(desc)], exits: dirs.map(dir => ({ dir, to: null, door: false })) })
    const junction = add('Intersection of Crystal Street and Main Street', 0, 'Crystal Street crosses Main Street.', ['e','w'])
    const first = add('Main Street', 3, body, ['e','w'])
    const cathedral = add('Main Street, before the Cathedral', 4, 'The elaborate cathedral stands to the east.', ['n','e','s','w'])
    f.model.linkRooms(cathedral.id, 'w', first.id, true)
    f.tracker.setCurrentRoom(cathedral.id)
    for (let x=3; x>=1; x--) { f.tracker.onCommand('w'); f.see('Main Street', body, 'east west') }
    f.tracker.onCommand('w'); f.see(junction.name, 'Crystal Street crosses Main Street.', 'east west')
    assert.equal(Object.keys(f.model.map.rooms).length, 5, 'both missing street rooms are present before retracing')
    for (let x=1; x<=3; x++) { f.tracker.onCommand('e'); f.see('Main Street', body, 'east west') }
    f.tracker.onCommand('e'); f.see(cathedral.name, 'The elaborate cathedral stands to the east.', 'north east south west')
    f.tracker.onCommand('e'); f.see('The Narthex', 'This is the entrance hall of the cathedral.', 'west')
    assert.equal(Object.keys(f.model.map.rooms).length, 6)
    assert.equal(Object.values(f.model.map.rooms).filter(r => r.name === cathedral.name).length, 1)
    assert.equal(f.tracker.currentRoom?.name, 'The Narthex')
    assert.equal(f.tracker.currentRoom?.x, 5)
    console.log('ok missing repeated streets are retained and eastward retracing reuses the cathedral')
  } finally { f.close() }
}
