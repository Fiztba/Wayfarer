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
    if (variant === 'supported') {
      assert.equal(f.model.exitOf(west, 'e')?.to, square.id)
      assert.equal(Object.keys(f.model.map.rooms).length, 3)
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
