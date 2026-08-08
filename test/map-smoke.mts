/**
 * Headless tests for the mapper core: capture, model, tracker, pathfinder.
 * Run with: node --experimental-strip-types test/map-smoke.mts
 */
import { parseExitsLine, RoomCapture } from '../src/renderer/src/map/capture.ts'
import { MapModel } from '../src/renderer/src/map/MapModel.ts'
import {
  MODEL_ACTION_METHODS,
  RemoteMapModel,
  type MapAction
} from '../src/renderer/src/map/RemoteMap.ts'
import { MapTracker } from '../src/renderer/src/map/MapTracker.ts'
import { findPath } from '../src/renderer/src/map/Pathfinder.ts'
import { emptyMap, stripPromptPrefix } from '../src/renderer/src/map/types.ts'
import { AnsiParser } from '../src/renderer/src/ansi.ts'

let failures = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) console.log(`  ok  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}\n      expected ${e}\n      got      ${a}`)
  }
}

// ---- line-ending handling (bare CR, \r\n, Diku's \n\r) ----
{
  const flat = (input: string) =>
    new AnsiParser()
      .parse(input)
      .map((t) => (t.kind === 'newline' ? '|' : t.span.text))
      .join('')
  check('crlf is one break', flat('a\r\nb\r\n'), 'a|b|')
  check('diku lfcr is one break', flat('a\n\rb\n\r'), 'a|b|')
  check('bare CR breaks the line', flat('<prompt> \rTitle\r\n'), '<prompt> |Title|')
  check('bare LF still breaks', flat('a\nb'), 'a|b')
  check('pair split across chunks', (() => {
    const p = new AnsiParser()
    const t1 = p.parse('a\r')
    const t2 = p.parse('\nb')
    return [...t1, ...t2].map((t) => (t.kind === 'newline' ? '|' : t.span.text)).join('')
  })(), 'a|b')
}

// ---- prompt-prefix stripping ----
check(
  'strip prompt prefix',
  stripPromptPrefix('<221hp 340mv [day]> Southern Outer Courtyard'),
  'Southern Outer Courtyard'
)
check('strip leaves clean titles alone', stripPromptPrefix('Temple Square'), 'Temple Square')
{
  const cap = new RoomCapture()
  cap.feedLine('<221hp 340mv [day]> Southern Outer Courtyard')
  const det = cap.feedLine('[ Exits: n e s w ]')
  check('glued prompt stripped from title', det?.name, 'Southern Outer Courtyard')
}

// ---- exits line parsing ----
check(
  'circle exits',
  parseExitsLine('[ Exits: n e s w ]'),
  [
    { dir: 'n', door: false },
    { dir: 'e', door: false },
    { dir: 's', door: false },
    { dir: 'w', door: false }
  ]
)
check(
  'smaug exits full words',
  parseExitsLine('Exits: north southeast up.'),
  [
    { dir: 'n', door: false },
    { dir: 'se', door: false },
    { dir: 'u', door: false }
  ]
)
check(
  'closed door in parens',
  parseExitsLine('[Exits: n (e) w]'),
  [
    { dir: 'n', door: false },
    { dir: 'e', door: true },
    { dir: 'w', door: false }
  ]
)
check('non-exits prose ignored', parseExitsLine('The exits here are blocked by rubble'), null)
check('plain chatter ignored', parseExitsLine('Bob says: hi there'), null)

// ---- capture: title selection ----
{
  const cap = new RoomCapture()
  cap.feedLine('Temple Square')
  cap.feedLine('A wide plaza stretches before the great temple. Pigeons scatter as')
  cap.feedLine('you walk across the worn flagstones.')
  const det = cap.feedLine('[ Exits: n e s w ]')
  check('title found past prose', det?.name, 'Temple Square')
}

// ---- model + tracker ----
function makeWorld() {
  const model = new MapModel(emptyMap(), () => {})
  const infos: string[] = []
  const tracker = new MapTracker(model, { info: (t) => infos.push(t) })
  const seeRoom = (name: string, exitsLine: string) => {
    tracker.onLine(name)
    tracker.onLine(exitsLine)
  }
  return { model, tracker, infos, seeRoom }
}

{
  const { model, tracker, seeRoom } = makeWorld()
  seeRoom('Temple Square', '[ Exits: n e ]')
  check('seed room created', Object.keys(model.map.rooms).length, 1)
  const seed = tracker.currentRoom
  check('seed room name', seed?.name, 'Temple Square')

  tracker.onCommand('n')
  seeRoom('Market Street', '[ Exits: s w ]')
  check('room created on move', Object.keys(model.map.rooms).length, 2)
  const market = tracker.currentRoom
  check('current advanced', market?.name, 'Market Street')
  check('forward link', model.exitOf(seed!, 'n')?.to, market!.id)
  check('reverse link (return exit seen)', model.exitOf(market!, 's')?.to, seed!.id)

  // Walk back: should follow the existing link, not create a room.
  tracker.onCommand('s')
  seeRoom('Temple Square', '[ Exits: n e ]')
  check('no duplicate on return', Object.keys(model.map.rooms).length, 2)
  check('back at seed', tracker.currentRoomId, seed!.id)

  // n;u vs u;n must NOT merge — even if coordinates would collide.
  tracker.onCommand('e')
  seeRoom('East Gate', '[ Exits: w u ]')
  tracker.onCommand('u')
  seeRoom('Gate Tower', '[ Exits: d n ]')
  const tower = tracker.currentRoom
  tracker.onCommand('n')
  seeRoom('Tower Walk', '[ Exits: s ]')
  const walk1 = tracker.currentRoom
  // Return and take the other order from East Gate: n first (unmapped), then u.
  tracker.onCommand('s')
  seeRoom('Gate Tower', '[ Exits: d n ]')
  check('back at tower', tracker.currentRoomId, tower!.id)
  check('rooms so far', Object.keys(model.map.rooms).length, 5)
  check('walk1 distinct from tower', walk1!.id !== tower!.id, true)

  // Mismatch → lost, no new rooms created.
  tracker.onCommand('d')
  seeRoom('Completely Wrong Room', '[ Exits: n s e w ]')
  check('lost on mismatch', tracker.lost, true)
  check('no junk room created while lost', Object.keys(model.map.rooms).length, 5)

  // Manual re-sync clears lost.
  tracker.setCurrentRoom(seed!.id)
  check('resync clears lost', tracker.lost, false)
  check('resync sets room', tracker.currentRoomId, seed!.id)
}

// ---- doors ----
{
  const { model, tracker, seeRoom } = makeWorld()
  seeRoom('Hallway', '[ Exits: n ]')
  const hall = tracker.currentRoom!
  tracker.onCommand('n')
  tracker.onLine('The door seems to be closed.')
  check('door marked on closed-door failure', model.exitOf(model.room(hall.id)!, 'n')?.door, true)
  check('still in hallway', tracker.currentRoomId, hall.id)

  tracker.onCommand('open door north')
  check('open command keeps door flag', model.exitOf(model.room(hall.id)!, 'n')?.door, true)
  tracker.onCommand('n')
  seeRoom('Guard Post', '[ Exits: s ]')
  check('moved through opened door', tracker.currentRoom?.name, 'Guard Post')
  // Door mirrored on the far side once linked.
  const post = tracker.currentRoom!
  check('door mirrored on return exit', model.exitOf(post, 's')?.door, true)
}

// ---- pathfinding with doors and special exits ----
{
  const model = new MapModel(emptyMap(), () => {})
  const a = model.createRoom({ name: 'A', x: 0, y: 0, z: 0 })
  const b = model.createRoom({ name: 'B', x: 1, y: 0, z: 0 })
  const c = model.createRoom({ name: 'C', x: 2, y: 0, z: 0 })
  const d = model.createRoom({ name: 'D', x: 0, y: 5, z: 0 })
  model.linkRooms(a.id, 'e', b.id, true)
  model.linkRooms(b.id, 'e', c.id, true)
  model.setDoor(b.id, 'e', true, 'gate')
  model.addSpecialExit(c.id, 'enter portal', d.id)

  const path = findPath(model, a.id, d.id)
  check(
    'path commands',
    path?.map((s) => s.command),
    ['e', 'e', 'enter portal']
  )
  check('door open injected', path?.[1].openCommand, 'open gate east')
  check('unreachable is null', findPath(model, d.id, a.id), null)
  check('same room is empty path', findPath(model, a.id, a.id), [])
}

// ---- merge, zones, waypoints ----
{
  const model = new MapModel(emptyMap(), () => {})
  const a = model.createRoom({ name: 'Plaza', x: 0, y: 0, z: 0 })
  const b1 = model.createRoom({ name: 'Alley', x: 1, y: 0, z: 0 })
  const b2 = model.createRoom({ name: 'Alley dup', x: 0, y: 1, z: 0 })
  model.linkRooms(a.id, 'e', b1.id, true)
  model.linkRooms(a.id, 's', b2.id, true)
  model.setWaypoint('dup', b2.id)
  model.mergeRooms(b1.id, b2.id)
  check('merge removed room', model.room(b2.id), null)
  check('merge redirected link', model.exitOf(model.room(a.id)!, 's')?.to, b1.id)
  check('merge moved waypoint', model.waypoint('dup')?.id, b1.id)

  const zoneId = model.createZone('Sewers')
  model.createRoom({ name: 'Sewer 1', zoneId, x: 0, y: 0, z: 0 })
  model.createRoom({ name: 'Sewer 2', zoneId, x: 1, y: 0, z: 0 })
  const removed = model.deleteZone(zoneId)
  check('zone delete removes rooms', removed, 2)
  check('other rooms untouched', model.room(a.id)?.name, 'Plaza')

  model.setWaypoint('home', a.id)
  check('waypoint lookup', model.waypoint('HOME')?.id, a.id)
  check('waypoint remove', model.removeWaypoint('home'), true)
  check('waypoint gone', model.waypoint('home'), null)
}

// ---- ring walk: closing a loop links, never duplicates ----
{
  const { model, tracker, seeRoom } = makeWorld()
  // Walk a 2x2 courtyard ring: R1 → n → R2 → e → R3 → s → R4, then w back to R1.
  seeRoom('Southern Courtyard', '[ Exits: n e ]')
  const r1 = tracker.currentRoom!
  tracker.onCommand('n')
  seeRoom('Northern Courtyard', '[ Exits: s e ]')
  tracker.onCommand('e')
  seeRoom('Northeast Courtyard', '[ Exits: s w ]')
  tracker.onCommand('s')
  seeRoom('Southeast Courtyard', '[ Exits: n w s ]')
  const r4 = tracker.currentRoom!
  check('ring: four rooms so far', Object.keys(model.map.rooms).length, 4)

  // Close the loop: w from R4 arrives at R1, whose east exit is a stub.
  tracker.onCommand('w')
  seeRoom('Southern Courtyard', '[ Exits: n e ]')
  check('ring closed without duplicate', Object.keys(model.map.rooms).length, 4)
  check('ring: back at start', tracker.currentRoomId, r1.id)
  check('ring: loop link created', model.exitOf(model.room(r4.id)!, 'w')?.to, r1.id)
  check('ring: reverse loop link', model.exitOf(model.room(r1.id)!, 'e')?.to, r4.id)
  check('ring: not lost', tracker.lost, false)

  // Maze safety: two identical rooms exist → ambiguous match must NOT link.
  // Create two identical maze cells first.
  model.createRoom({ name: 'Twisty Passage', x: 10, y: 10, z: 0, exits: [{ dir: 'w', to: null, door: false }] })
  model.createRoom({ name: 'Twisty Passage', x: 12, y: 10, z: 0, exits: [{ dir: 'w', to: null, door: false }] })
  const before = Object.keys(model.map.rooms).length
  // Walk to R4 (mapped), then s through its unexplored stub into a "Twisty Passage".
  tracker.onCommand('e')
  seeRoom('Southeast Courtyard', '[ Exits: n w s ]')
  check('maze setup: at R4', tracker.currentRoomId, r4.id)
  tracker.onCommand('s')
  seeRoom('Twisty Passage', '[ Exits: w ]')
  check('maze: ambiguous match creates new room', Object.keys(model.map.rooms).length, before + 1)
  check('maze: not linked to either twin', tracker.currentRoom?.name, 'Twisty Passage')
}

// ---- asymmetric exits on a grid: position corroborates, back exit doesn't ----
{
  const { model, tracker, infos, seeRoom } = makeWorld()
  const southern = model.createRoom({
    name: 'Southern Outer Courtyard', x: 0, y: 1, z: 0,
    exits: [
      { dir: 'n', to: null, door: false },
      { dir: 'e', to: null, door: false },
      { dir: 's', to: null, door: false },
      { dir: 'w', to: null, door: false }
    ]
  })
  const gatehouse = model.createRoom({
    name: 'Main Gatehouse', x: 4, y: 4, z: 0,
    exits: [{ dir: 's', to: null, door: false }]
  })
  // Asymmetry: n from Southern goes to the Gatehouse (and s returns).
  model.linkRooms(southern.id, 'n', gatehouse.id, false)
  model.linkRooms(gatehouse.id, 's', southern.id, false)
  const northern = model.createRoom({
    name: 'Northern Outer Courtyard', x: 0, y: 0, z: 0,
    exits: [{ dir: 's', to: null, door: false }]
  })
  const countBefore = Object.keys(model.map.rooms).length

  // s from Northern: Southern is grid-adjacent (corroborated) even though its
  // n exit belongs to the Gatehouse → link one-way, never touch Southern.n.
  tracker.setCurrentRoom(northern.id)
  tracker.onCommand('s')
  seeRoom('Southern Outer Courtyard', '[ Exits: n e s w ]')
  check('asym: no duplicate created', Object.keys(model.map.rooms).length, countBefore)
  check('asym: arrived at real Southern', tracker.currentRoomId, southern.id)
  check('asym: one-way link recorded', model.exitOf(model.room(northern.id)!, 's')?.to, southern.id)
  check('asym: Southern.n untouched', model.exitOf(model.room(southern.id)!, 'n')?.to, gatehouse.id)
  check('asym: not lost', tracker.lost, false)

  // Self-heal: suppose Southern.n had been wrongly guess-linked to Northern.
  model.linkRooms(southern.id, 'n', northern.id, false)
  tracker.setCurrentRoom(southern.id)
  tracker.onCommand('n')
  seeRoom('Main Gatehouse', '[ Exits: s ]')
  check('heal: exit corrected (back-link evidence)', model.exitOf(model.room(southern.id)!, 'n')?.to, gatehouse.id)
  check('heal: followed the player', tracker.currentRoomId, gatehouse.id)
  check('heal: not lost', tracker.lost, false)
  check('heal: correction announced', infos.some((t) => t.includes('corrected the n exit')), true)
}

// ---- name twin in the wrong direction must NOT capture the arrival ----
{
  const { model, tracker, seeRoom } = makeWorld()
  // An existing "Northern Outer Courtyard" (e,s,w) sits WEST of the player.
  const westTwin = model.createRoom({
    name: 'Northern Outer Courtyard', x: 0, y: 0, z: 0,
    exits: [
      { dir: 'e', to: null, door: false },
      { dir: 's', to: null, door: false },
      { dir: 'w', to: null, door: false }
    ]
  })
  const here = model.createRoom({
    name: 'Northern Outer Courtyard', x: 1, y: 0, z: 0,
    exits: [
      { dir: 'n', to: null, door: false },
      { dir: 'e', to: null, door: false },
      { dir: 's', to: null, door: false },
      { dir: 'w', to: null, door: false }
    ]
  })
  const countBefore = Object.keys(model.map.rooms).length

  // Walking EAST arrives at a room matching the west twin's fingerprint.
  // A lone name match with no corroboration must create a new room east —
  // never teleport the player into the western twin.
  tracker.setCurrentRoom(here.id)
  tracker.onCommand('e')
  seeRoom('Northern Outer Courtyard', '[ Exits: e s w ]')
  check('twin: new room created', Object.keys(model.map.rooms).length, countBefore + 1)
  check('twin: did not jump west', tracker.currentRoomId !== westTwin.id, true)
  const arrived = tracker.currentRoom!
  check('twin: new room lies east', arrived.x > here.x, true)
  check('twin: linked from origin', model.exitOf(model.room(here.id)!, 'e')?.to, arrived.id)
  check('twin: not lost', tracker.lost, false)
}

// ---- identical room names: arrival context disambiguates ----
{
  const { model, tracker, infos, seeRoom } = makeWorld()
  const wallExits = [
    { dir: 'n' as const, to: null, door: false },
    { dir: 'e' as const, to: null, door: false },
    { dir: 's' as const, to: null, door: false },
    { dir: 'w' as const, to: null, door: false }
  ]
  // A courtyard wall: three identical "Southern Outer Courtyard" rooms in a row,
  // and a "Northern Outer Courtyard" row above them.
  const s0 = model.createRoom({ name: 'Southern Outer Courtyard', x: 0, y: 1, z: 0, exits: JSON.parse(JSON.stringify(wallExits)) })
  const s1 = model.createRoom({ name: 'Southern Outer Courtyard', x: 1, y: 1, z: 0, exits: JSON.parse(JSON.stringify(wallExits)) })
  const s2 = model.createRoom({ name: 'Southern Outer Courtyard', x: 2, y: 1, z: 0, exits: JSON.parse(JSON.stringify(wallExits)) })
  const n1 = model.createRoom({ name: 'Northern Outer Courtyard', x: 1, y: 0, z: 0, exits: [] })
  const countBefore = Object.keys(model.map.rooms).length

  // Walk s from the middle Northern room: three identical candidates, but only
  // s1 sits along the ray → link to it, no new room.
  tracker.setCurrentRoom(n1.id)
  tracker.onCommand('s')
  seeRoom('Southern Outer Courtyard', '[ Exits: n e s w ]')
  check('ambig: no room created', Object.keys(model.map.rooms).length, countBefore)
  check('ambig: grid position picked the right twin', tracker.currentRoomId, s1.id)
  check('ambig: link recorded', model.exitOf(model.room(n1.id)!, 's')?.to, s1.id)
  check('ambig: not lost', tracker.lost, false)

  // Back-links outrank position: make s0 the ONLY room whose n → n1.
  model.linkRooms(s0.id, 'n', n1.id, false)
  const s1n = model.room(s1.id)!.exits.find((e) => e.dir === 'n')
  if (s1n) s1n.to = null // undo the reverse link the first walk created
  const n1b = model.room(n1.id)!
  n1b.exits = n1b.exits.filter((e) => e.dir !== 's') // forget the earlier link
  tracker.setCurrentRoom(n1.id)
  tracker.onCommand('s')
  seeRoom('Southern Outer Courtyard', '[ Exits: n e s w ]')
  check('ambig: back-link wins over position', tracker.currentRoomId, s0.id)

  // Unresolvable: from a room far from every twin, with no back-links.
  const far = model.createRoom({ name: 'Watchtower', x: 30, y: 30, z: 0, exits: [] })
  tracker.setCurrentRoom(far.id)
  const before2 = Object.keys(model.map.rooms).length
  tracker.onCommand('s')
  seeRoom('Southern Outer Courtyard', '[ Exits: n e s w ]')
  check('ambig: unresolvable still creates', Object.keys(model.map.rooms).length, before2 + 1)
  check('ambig: creation warned', infos.some((t) => t.includes('identical name/exits')), true)
  void s2
}

// ---- twin across a gap must not capture; the gap room gets created ----
{
  const { model, tracker, seeRoom } = makeWorld()
  // Twin "Northern Outer Courtyard" (e,s,w) two cells west — a visible gap.
  const farTwin = model.createRoom({
    name: 'Northern Outer Courtyard', x: 0, y: 0, z: 0,
    exits: [
      { dir: 'e', to: null, door: false },
      { dir: 's', to: null, door: false },
      { dir: 'w', to: null, door: false }
    ]
  })
  const northeast = model.createRoom({
    name: 'Northeast Outer Courtyard', x: 2, y: 0, z: 0,
    exits: [
      { dir: 's', to: null, door: false },
      { dir: 'w', to: null, door: false }
    ]
  })
  const countBefore = Object.keys(model.map.rooms).length

  // Walking w must create the room IN the gap (x=1), not jump the gap.
  tracker.setCurrentRoom(northeast.id)
  tracker.onCommand('w')
  seeRoom('Northern Outer Courtyard', '[ Exits: e s w ]')
  check('gap: new room created', Object.keys(model.map.rooms).length, countBefore + 1)
  check('gap: did not jump to far twin', tracker.currentRoomId !== farTwin.id, true)
  const gapRoom = tracker.currentRoom!
  check('gap: created in the gap', [gapRoom.x, gapRoom.y], [1, 0])
  check('gap: linked from origin', model.exitOf(model.room(northeast.id)!, 'w')?.to, gapRoom.id)

  // But exact adjacency still corroborates: continuing w into the twin links.
  tracker.onCommand('w')
  seeRoom('Northern Outer Courtyard', '[ Exits: e s w ]')
  check('gap: adjacent twin still linked', tracker.currentRoomId, farTwin.id)
  check('gap: no extra room', Object.keys(model.map.rooms).length, countBefore + 1)
}

// ---- polluted room names heal on contact ----
{
  const { model, tracker, seeRoom } = makeWorld()
  // A room saved with a prompt glued onto its name (from the old CR bug).
  const polluted = model.createRoom({
    name: '<221hp 340mv [day]> Southern Outer Courtyard',
    x: 0, y: 0, z: 0,
    exits: [{ dir: 'e', to: null, door: false }]
  })
  const east = model.createRoom({
    name: 'Winch Room', x: 1, y: 0, z: 0,
    exits: [{ dir: 'w', to: null, door: false }]
  })
  model.linkRooms(east.id, 'w', polluted.id, true)

  // Walking w through the link: clean detection must MATCH the polluted room
  // (not go lost) and repair its stored name.
  tracker.setCurrentRoom(east.id)
  tracker.onCommand('w')
  seeRoom('Southern Outer Courtyard', '[ Exits: e ]')
  check('heal-name: matched despite pollution', tracker.currentRoomId, polluted.id)
  check('heal-name: not lost', tracker.lost, false)
  check('heal-name: stored name repaired', model.room(polluted.id)?.name, 'Southern Outer Courtyard')
}

// ---- hidden exits: learned exits must not break fingerprint identity ----
{
  const { model, tracker, seeRoom } = makeWorld()
  // Room A's exits line hides its east exit.
  seeRoom('A Granite Passage with Murals', '[ Exits: n s w ]')
  const a = tracker.currentRoom!

  // Walk the hidden exit east: B gets created and linked (B's return west
  // exit is hidden too — its exits line shows only e and s).
  tracker.onCommand('e')
  seeRoom('A Granite Passage Filled with Moss', '[ Exits: e s ]')
  const b = tracker.currentRoom!
  check('hidden: B created', Object.keys(model.map.rooms).length, 2)
  check('hidden: A.e learned', model.exitOf(model.room(a.id)!, 'e')?.to, b.id)

  // Walk back west through B's hidden exit. A now stores n,s,w,e but its
  // exits line still says n,s,w — it must still match itself.
  tracker.onCommand('w')
  seeRoom('A Granite Passage with Murals', '[ Exits: n s w ]')
  check('hidden: no phantom created', Object.keys(model.map.rooms).length, 2)
  check('hidden: back at A', tracker.currentRoomId, a.id)
  check('hidden: B.w learned', model.exitOf(model.room(b.id)!, 'w')?.to, a.id)
  check('hidden: not lost', tracker.lost, false)

  // Round trip again — both hidden exits now known links.
  tracker.onCommand('e')
  seeRoom('A Granite Passage Filled with Moss', '[ Exits: e s ]')
  check('hidden: revisit follows link', tracker.currentRoomId, b.id)
  tracker.onCommand('w')
  seeRoom('A Granite Passage with Murals', '[ Exits: n s w ]')
  check('hidden: stable round trip', tracker.currentRoomId, a.id)
  check('hidden: still two rooms', Object.keys(model.map.rooms).length, 2)
}

// ---- duplicate detection & cleanup ----
{
  const model = new MapModel(emptyMap(), () => {})
  const real = model.createRoom({
    name: 'Southern Courtyard',
    x: 0, y: 0, z: 0,
    exits: [{ dir: 'n', to: null, door: false }, { dir: 'e', to: null, door: false }]
  })
  const phantom = model.createRoom({
    name: 'Southern Courtyard',
    x: 0, y: 2, z: 0,
    exits: [{ dir: 'n', to: null, door: false }, { dir: 'e', to: null, door: false }]
  })
  const other = model.createRoom({ name: 'Gatehouse', x: 0, y: -1, z: 0 })
  model.linkRooms(other.id, 's', phantom.id, false) // stale link into the phantom
  model.map.lastRoomId = phantom.id

  const groups = model.findDuplicateGroups()
  check('dupes: one group found', groups.length, 1)
  check('dupes: group has both copies', groups[0].length, 2)
  check('dupes: inbound counts phantom', model.inboundLinkCount(phantom.id), 1)

  model.mergeRooms(real.id, phantom.id)
  check('dupes: merge redirects stale link', model.exitOf(model.room(other.id)!, 's')?.to, real.id)
  check('dupes: merge redirects lastRoomId', model.map.lastRoomId, real.id)
  check('dupes: clean after merge', model.findDuplicateGroups().length, 0)
}

// ---- zone allocation: inherit from origin, #zone arms the boundary ----
{
  const { model, tracker, seeRoom } = makeWorld()
  seeRoom('Town Square', '[ Exits: n e ]')
  const square = tracker.currentRoom!
  const townZone = square.zoneId

  // Ordinary exploration inherits the origin room's zone.
  tracker.onCommand('n')
  seeRoom('Market Street', '[ Exits: s n ]')
  check('zones: inherit origin zone', tracker.currentRoom?.zoneId, townZone)

  // Arm a new zone (#zone Sewers), then walk: next room starts the zone...
  const sewers = model.createZone('Sewers')
  model.pendingZoneId = sewers
  tracker.onCommand('n')
  seeRoom('Slimy Tunnel', '[ Exits: s e ]')
  check('zones: armed zone claims next room', tracker.currentRoom?.zoneId, sewers)
  check('zones: arming consumed', model.pendingZoneId, null)

  // ...and rooms after that inherit Sewers, NOT the old active zone.
  model.setActiveZone(townZone)
  tracker.onCommand('e')
  seeRoom('Dripping Passage', '[ Exits: w ]')
  check('zones: inheritance continues in new zone', tracker.currentRoom?.zoneId, sewers)

  // Walking back into town and exploring: rooms join town again automatically.
  tracker.setCurrentRoom(square.id)
  tracker.onCommand('e')
  seeRoom('East Lane', '[ Exits: w ]')
  check('zones: back home, inherits town', tracker.currentRoom?.zoneId, townZone)

  // Reassignment: move the sewer rooms into a renamed zone in one call.
  const cistern = model.createZone('Cistern')
  const sewerRooms = model.roomsInZone(sewers).map((r) => r.id)
  check('zones: bulk move count', model.moveRoomsToZone(sewerRooms, cistern), 2)
  check('zones: source emptied', model.roomsInZone(sewers).length, 0)
  check('zones: target filled', model.roomsInZone(cistern).length, 2)
  const moved = model.roomsInZone(cistern)[0]
  check('zones: links survive the move', moved.exits.length > 0, true)
}

// ---- position persists across sessions ----
{
  const { model, tracker, seeRoom } = makeWorld()
  seeRoom('Temple Square', '[ Exits: n e ]')
  tracker.onCommand('n')
  seeRoom('Market Street', '[ Exits: s w ]')
  const market = tracker.currentRoom!
  check('lastRoomId tracks movement', model.map.lastRoomId, market.id)

  // "Reconnect": same map data, fresh model+tracker (as after app restart).
  const saved = JSON.parse(JSON.stringify(model.map))
  const model2 = new MapModel(saved, () => {})
  const infos2: string[] = []
  const tracker2 = new MapTracker(model2, { info: (t) => infos2.push(t) })
  check('position restored on reconnect', tracker2.currentRoom?.name, 'Market Street')
  check('not lost after restore', tracker2.lost, false)

  // First look at the same room confirms quietly.
  tracker2.onLine('Market Street')
  tracker2.onLine('[ Exits: s w ]')
  check('same-room look keeps position', tracker2.currentRoom?.name, 'Market Street')
  check('still not lost', tracker2.lost, false)

  // Reconnect but the server actually put us elsewhere (unique room) → snap.
  const model3 = new MapModel(JSON.parse(JSON.stringify(model.map)), () => {})
  const tracker3 = new MapTracker(model3, { info: () => {} })
  check('restored before verify', tracker3.currentRoom?.name, 'Market Street')
  tracker3.onLine('Temple Square')
  tracker3.onLine('[ Exits: n e ]')
  check('snapped to actual unique room', tracker3.currentRoom?.name, 'Temple Square')

  // Stale lastRoomId (room deleted) → clean unanchored start, no crash.
  const savedStale = JSON.parse(JSON.stringify(model.map))
  savedStale.lastRoomId = 'nonexistent-room'
  const tracker4 = new MapTracker(new MapModel(savedStale, () => {}), { info: () => {} })
  check('stale lastRoomId ignored', tracker4.currentRoomId, null)
}

// ---- pop-out RPC: remote edits land identically on the real model ----
{
  const real = new MapModel(emptyMap(), () => {})
  const dispatch = (a: MapAction) => {
    if (a.type === 'model' && MODEL_ACTION_METHODS.has(a.method)) {
      const target = real as unknown as Record<string, (...args: unknown[]) => void>
      target[a.method](...a.args)
    }
  }
  const remote = new RemoteMapModel(JSON.parse(JSON.stringify(real.map)), dispatch)

  const room = remote.createRoom({ name: 'Alpha', x: 0, y: 0, z: 0 })
  check('rpc: room created remotely exists locally', real.room(room.id)?.name, 'Alpha')

  const other = remote.createRoom({ name: 'Beta', x: 1, y: 0, z: 0 })
  remote.linkRooms(room.id, 'e', other.id, true)
  check('rpc: link forwarded', real.exitOf(real.room(room.id)!, 'e')?.to, other.id)
  check('rpc: reverse link forwarded', real.exitOf(real.room(other.id)!, 'w')?.to, room.id)

  remote.setDoor(room.id, 'e', true, 'gate')
  check('rpc: door forwarded', real.exitOf(real.room(room.id)!, 'e')?.doorName, 'gate')

  const zid = remote.createZone('Sewers')
  check('rpc: zone id agrees', real.map.zones.some((z) => z.id === zid && z.name === 'Sewers'), true)
  remote.moveRoomsToZone([room.id], zid)
  check('rpc: zone move forwarded', real.room(room.id)?.zoneId, zid)

  remote.setWaypoint('home', other.id)
  check('rpc: waypoint forwarded', real.waypoint('home')?.id, other.id)

  remote.updateRoom(other.id, { name: 'Beta Prime', color: '#123456' })
  check('rpc: update forwarded', real.room(other.id)?.name, 'Beta Prime')

  remote.removeExitAt(room.id, 0)
  check('rpc: exit removal forwarded', real.room(room.id)?.exits.length, 0)

  remote.deleteRoom(other.id)
  check('rpc: delete forwarded', real.room(other.id), null)
  check('rpc: models agree at the end', JSON.stringify(remote.map.rooms), JSON.stringify(real.map.rooms))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
