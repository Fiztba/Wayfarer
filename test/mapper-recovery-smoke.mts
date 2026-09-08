import assert from 'node:assert/strict'
import { MapModel } from '../src/renderer/src/map/MapModel.ts'
import { MapTracker } from '../src/renderer/src/map/MapTracker.ts'
import { RoomCapture } from '../src/renderer/src/map/capture.ts'
import { hashText, type Direction } from '../src/renderer/src/map/types.ts'

// The reported Blackmoor sequence: three moves south, but only two north
// to return to Wyverns Way. Stock alleys have identical titles and prose.
const alley = [
  'This thin, winding alley, is dimly lit and filthy. A large amount of',
  'broken, worthless items are strewn about. The alley walls to the east',
  'and west are of mixed color and made from different materials, depending',
  'on what building it belongs to. The walls tower high above and dim out',
  'any natural light that seeps down. The alleyway stretches from the north',
  'to the south.'
]
const street = [
  'This is a grayish cobblestoned street. On the sides are a few guttering',
  'lanterns hung from tall posts to provide ample lighting during the',
  'nighttime hours. A few residential buildings lie to the north, while the',
  'street goes from the east to the west. A dark alley arrows off to the',
  'south here.'
]
const end = [...alley.slice(0, 4), 'any natural light that seeps down. The only exits are to the north, or', 'through an open pothole that leads into the darkness.']
const title = 'Wyverns Way, before an Alley'
function fixture(duplicateStreet = false) {
  const model = new MapModel(null, () => {})
  const add = (id: string, name: string, body: string[], y: number, dirs: Direction[]) => model.createRoom({
    id, name, x: -12, y, descHashes: [hashText(body.join(' '))],
    exits: dirs.map((dir) => ({ dir, to: null, door: false }))
  })
  add('street', title, street, -4, ['e','s','w'])
  add('upper', 'Alley', alley, -3, ['n','s'])
  add('lower', 'Alley', alley, -2, ['n','s'])
  add('end', 'Deadend of an Alley', end, -1, ['n','d'])
  add('other', 'Alley', alley, 4, ['n','s'])
  add('east', 'Lantern Market', ['A market of copper lanterns.'], 20, ['n','w'])
  add('tower', 'Clock Tower', ['A tall clock overlooks the town.'], -30, ['s'])
  if (duplicateStreet) add('street-copy', title, street, 10, ['e','s','w'])
  model.linkRooms('street', 's', 'upper', true)
  model.linkRooms('upper', 's', 'lower', true)
  model.linkRooms('lower', 's', 'end', true)
  model.linkRooms('street', 'e', 'east', false)
  model.linkRooms('east', 'n', 'tower', false)
  const infos: string[] = []
  const tracker = new MapTracker(model, { info: (text) => infos.push(text), characterName: () => 'Mystra' })
  tracker.setCurrentRoom('street')
  const see = (name: string, body: string[], exits: string) => {
    tracker.onLine('<364/379hp 273/273mana 445/450mv 251664 TNL (E) $3319>')
    tracker.onLine(name); body.forEach((line) => tracker.onLine(line)); tracker.onLine(`Exits: ${exits}`)
    tracker.onLine('a mustang arrives from the south.')
  }
  return { model, tracker, see, infos, close() { tracker.dispose(); model.flush() } }
}

// A forced departure may print no room at all. The next command must not
// become an exit correction from the last room displayed by the server.
{
  const f = fixture()
  try {
    f.tracker.setCurrentRoom('lower')
    f.tracker.onLine('Vines snake up from the ground and entangle horse, forcing horse to flee!')
    assert.equal(f.tracker.lost, false, 'another creature fleeing is not our movement')
    const graph = JSON.stringify(f.model.map.rooms, (key, value) => key === 'inferred' ? undefined : value)
    f.tracker.onLine('Vines snake up from the ground and entangle Mystra, forcing Mystra to flee!')
    assert.equal(f.tracker.lost, true)
    f.tracker.onCommand('w'); f.see(title, street, 'east south west')
    assert.equal(f.tracker.speculative, true)
    assert.equal(f.tracker.speculation?.anchorRoomId, null)
    f.tracker.onCommand('e'); f.see('Lantern Market', ['A market of copper lanterns.'], 'north west')
    f.tracker.onCommand('n'); f.see('Clock Tower', ['A tall clock overlooks the town.'], 'south')
    assert.equal(f.tracker.speculative, false)
    assert.equal(JSON.stringify(f.model.map.rooms, (key, value) => key === 'inferred' ? undefined : value), graph, 'recovery must not fabricate the unobserved movement')
    console.log('ok named forced flee invalidates the origin and recovers without rewriting its exits')
  } finally { f.close() }
}

{
  const f = fixture()
  try {
    f.tracker.setCurrentRoom('lower'); f.tracker.onCommand('n'); f.see(title, street, 'east south west')
    f.tracker.onCommand('e'); f.see('Lantern Market', ['A market of copper lanterns.'], 'north west')
    // A manually mapped return permits a repeated visit, but is no new evidence.
    f.model.linkRooms('east', 'w', 'street', false)
    f.tracker.onCommand('w'); f.see(title, street, 'east south west')
    f.tracker.onCommand('e'); f.see('Lantern Market', ['A market of copper lanterns.'], 'north west')
    assert.equal(f.tracker.speculative, true)
    assert.equal(f.tracker.confidence.score, 70)
    f.tracker.reset()
    assert.equal(f.tracker.currentRoomId, 'lower', 'reset cannot persist a guessed position')
    assert.equal(f.model.map.lastRoomId, 'lower')
    console.log('ok repeating a landmark pair does not confirm; reset restores the confirmed anchor')
  } finally { f.close() }
}

{
  const f = fixture()
  try {
    f.tracker.setMode('follow')
    f.tracker.setCurrentRoom('lower')
    const rooms = JSON.stringify(f.model.map.rooms)
    f.tracker.onCommand('n'); f.see(title, street, 'east south west')
    f.tracker.onCommand('e'); f.see('Lantern Market', ['A market of copper lanterns.'], 'north west')
    f.tracker.onCommand('n'); f.see('Clock Tower', ['A tall clock overlooks the town.'], 'south')
    assert.equal(f.tracker.currentRoomId, 'tower')
    assert.equal(f.tracker.speculative, false)
    assert.equal(JSON.stringify(f.model.map.rooms), rooms)
    console.log('ok follow mode confirms position without editing rooms')
  } finally { f.close() }
}

const capture = new RoomCapture()
let detection
for (const line of [title, ...street, 'Exits: east south west']) detection = capture.feedLine(line)
assert.equal(detection?.name, title)
assert.equal(detection?.descHash, hashText(street.join(' ')))
console.log('ok screenshot room title and wrapped description are detected')

{
  const f = fixture()
  try {
    for (const name of ['upper','lower']) { f.tracker.onCommand('s'); f.see('Alley', alley, 'north south'); assert.equal(f.tracker.currentRoomId, name) }
    f.tracker.onCommand('s'); f.see('Deadend of an Alley', end, 'north down')
    f.tracker.onCommand('n'); f.see('Alley', alley, 'north south')
    f.tracker.onCommand('n'); f.see(title, street, 'east south west')
    assert.equal(f.tracker.lost, false, 'distinctive known room must recover the mismatching link')
    assert.equal(f.tracker.currentRoomId, 'street')
    assert.equal(f.tracker.speculative, true)
    assert.equal(f.tracker.confidence.score, 55)
    assert.equal(f.model.exitOf(f.model.room('lower')!, 'n')?.to, 'upper', 'no correction before corroboration')
    const unchanged = JSON.stringify(f.model.map)
    f.see(title, street, 'east south west')
    assert.equal(f.tracker.confidence.score, 55, 'repeated looks cannot raise confidence')
    assert.equal(JSON.stringify(f.model.map), unchanged)
    f.tracker.onCommand('e'); f.see('Lantern Market', ['A market of copper lanterns.'], 'north west')
    assert.equal(f.tracker.speculative, true, 'one following room is not enough')
    assert.equal(f.tracker.confidence.score, 70)
    f.tracker.onCommand('n'); f.see('Clock Tower', ['A tall clock overlooks the town.'], 'south')
    assert.equal(f.tracker.speculative, false)
    assert.equal(f.tracker.currentRoomId, 'tower')
    assert.equal(f.model.exitOf(f.model.room('lower')!, 'n')?.to, 'street')
    assert.equal(f.model.exitOf(f.model.room('street')!, 's')?.to, 'upper', 'do not rewrite the asymmetric return')
    assert.equal(Object.keys(f.model.map.rooms).length, 7)
    console.log('ok asymmetric alley return recovers at the landmark without inventing rooms or changing its return exit')
  } finally { f.close() }
}
{
  const f = fixture(true)
  try {
    f.tracker.setCurrentRoom('lower'); f.tracker.onCommand('n'); f.see(title, street, 'east south west')
    assert.equal(f.tracker.speculative, true, 'indistinguishable distant landmarks remain ambiguous')
    assert.equal(f.tracker.confidence.candidates, 2)
    assert.deepEqual(new Set(f.tracker.confidence.candidateRoomIds), new Set(['street', 'street-copy']))
    assert.equal(f.tracker.confidence.observedName, title)
    assert.match(f.tracker.confidence.reason, /may also be a new room/)
    const beforeDoor = JSON.stringify(f.model.map.rooms)
    f.tracker.onCommand('open gate n')
    f.tracker.onCommand('n')
    f.tracker.onLine('The gate is closed.')
    assert.equal(JSON.stringify(f.model.map.rooms), beforeDoor, 'door observations must not edit an arbitrary guessed room')
    assert.equal(f.model.exitOf(f.model.room('lower')!, 'n')?.to, 'upper')
  } finally { f.close() }
}

// Stock Abaris prose with a changing exit list is still a repeated street.
{
  const model = new MapModel(null, () => {})
  const tracker = new MapTracker(model, { info: () => {} })
  const add = (id: string, name: string, dirs: Direction[]) => model.createRoom({ id, name, x: 0, y: 0, exits: dirs.map(dir => ({ dir, to: null, door: false })) })
  const origin = add('origin', 'Side Lane', ['e'])
  add('street1', 'Abaris Street', ['e','w'])
  add('street2', 'Abaris Street', ['n','e','w'])
  add('junction', 'Intersection of Chromatic Road and Abaris Street', ['n','e','s','w'])
  model.linkRooms('street1','e','street2',false)
  model.linkRooms('street2','e','junction',false)
  tracker.setCurrentRoom(origin.id)
  const see = (name: string, exits: string) => { tracker.onLine(name); tracker.onLine('Exits: ' + exits) }
  try {
    tracker.onCommand('e'); see('Abaris Street','east west')
    tracker.onCommand('e'); see('Abaris Street','north east west')
    assert.equal(tracker.speculative, true)
    assert.equal(tracker.confidence.score,55)
    tracker.onCommand('e'); see('Intersection of Chromatic Road and Abaris Street','north east south west')
    assert.equal(tracker.speculative,true,'one intersection after cloned streets is not two independent landmarks')
    assert.equal(tracker.confidence.score,70)
    assert.equal(model.exitOf(origin,'e')?.to,null)
    for (let i=0; i<27; i++) see('Intersection of Chromatic Road and Abaris Street','north east south west')
    assert.equal(tracker.lost,true,'bounded ambiguity cannot force a guess into the graph')
    assert.equal(model.exitOf(origin,'e')?.to,null)
    console.log('ok changing street exits do not inflate confidence; observation cap saves no guessed links')
  } finally { tracker.dispose(); model.flush() }
}
