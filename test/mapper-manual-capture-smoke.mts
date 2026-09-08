import assert from 'node:assert/strict'
import { MapModel } from '../src/renderer/src/map/MapModel.ts'
import { MapTracker } from '../src/renderer/src/map/MapTracker.ts'
import { hashText } from '../src/renderer/src/map/types.ts'

function fixture() {
  const model = new MapModel(null, () => {})
  const old = model.createRoom({ name: 'Old Recall Point', x: 0, y: 0 })
  const room = model.createRoom({ name: 'New room', x: 20, y: 30, z: 2, notes: 'My recall point' })
  const tracker = new MapTracker(model, { info: () => {} })
  const look = (name = 'Town of Blackmoor') => {
    tracker.onLine(name)
    tracker.onLine('A broad cobbled square surrounds an ancient fountain.')
    tracker.onLine('Exits: north east south west')
  }
  return { model, old, room, tracker, look, close() { tracker.dispose(); model.flush() } }
}

{
  const f = fixture()
  try {
    f.tracker.setCurrentRoom(f.old.id)
    f.tracker.onCommand('recall')
    f.look()
    assert.equal(f.tracker.lost, true)
    f.tracker.setCurrentRoom(f.room.id)
    f.tracker.onCommand('look')
    f.look()
    assert.equal(f.tracker.currentRoomId, f.room.id)
    assert.equal(f.tracker.lost, false)
    assert.equal(f.tracker.speculative, false)
    assert.equal(f.room.name, 'Town of Blackmoor')
    assert.deepEqual(f.room.descHashes, [hashText('A broad cobbled square surrounds an ancient fountain.')])
    assert.deepEqual(f.room.exits.map(e => e.dir), ['n', 'e', 's', 'w'])
    assert.deepEqual([f.room.x, f.room.y, f.room.z, f.room.notes], [20, 30, 2, 'My recall point'])
    assert.equal(f.old.exits.length, 0, 'recall must not invent a connecting exit')
    assert.equal(Object.keys(f.model.map.rooms).length, 2)
    f.look('An Unexpected Destination')
    assert.equal(f.room.name, 'Town of Blackmoor', 'manual binding is consumed once')
    console.log('ok manual room captures the first post-recall look without relocating or duplicating it')
  } finally { f.close() }
}

for (const cancel of ['n', 'recall', 'reset', 'mode']) {
  const f = fixture()
  try {
    f.tracker.setCurrentRoom(f.room.id)
    if (cancel === 'reset') f.tracker.reset()
    else if (cancel === 'mode') f.tracker.setMode('follow')
    else f.tracker.onCommand(cancel)
    f.look()
    assert.equal(f.room.name, 'New room', `${cancel} cancels the one-shot capture`)
  } finally { f.close() }
}
console.log('ok movement, recall, reset and mode changes cannot populate the wrong manual room')

{
  const f = fixture()
  try {
    f.tracker.setCurrentRoom(f.room.id)
    f.tracker.onCommand('l')
    f.tracker.onServerRoom({ serverId: 'blackmoor-recall', name: 'Town of Blackmoor' })
    f.look()
    assert.equal(f.tracker.currentRoomId, f.room.id)
    assert.equal(f.room.serverId, 'blackmoor-recall')
    assert.equal(f.room.name, 'Town of Blackmoor')
    assert.equal(f.room.exits.length, 4)
    assert.equal(Object.keys(f.model.map.rooms).length, 2)
    console.log('ok authoritative room data populates the selected placeholder too')
  } finally { f.close() }
}
