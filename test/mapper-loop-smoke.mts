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
