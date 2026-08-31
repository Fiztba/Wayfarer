/**
 * Headless tests for the mapper core: capture, model, tracker, pathfinder.
 * Run with: node --experimental-strip-types test/map-smoke.mts
 */
import {
  closedDoorName,
  parseExitListLine,
  parseExitsLine,
  RoomCapture
} from '../src/renderer/src/map/capture.ts'
import { MapModel } from '../src/renderer/src/map/MapModel.ts'
import {
  MODEL_ACTION_METHODS,
  RemoteMapModel,
  type MapAction
} from '../src/renderer/src/map/RemoteMap.ts'
import { MapTracker } from '../src/renderer/src/map/MapTracker.ts'
import { exitOpenCommand, findPath } from '../src/renderer/src/map/Pathfinder.ts'
import { Walker } from '../src/renderer/src/map/Walker.ts'
import {
  emptyMap,
  hashText,
  stripPromptPrefix,
  type MudMap
} from '../src/renderer/src/map/types.ts'
import {
  cubicPoint,
  cubicTangent,
  drawnAsClaimed,
  isObstructed,
  linkPath
} from '../src/renderer/src/map/geometry.ts'
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

// ---- capture: staff-decorated titles and stray prompts (The Builder Academy) ----
// Format is do_look_at_room()'s, exactly: "[%5d] " then "%s[ %s][ %s ]" for
// name/flags/sector, then "[T" plus " %d" per trigger. Note the flag group has
// no space before its "]", and the vnum is width-5 space-padded.
{
  // Judged raw this line is 71 chars and 11 words, so both title heuristics
  // reject it and the room ends up named after a line of description prose.
  const cap = new RoomCapture()
  cap.feedLine("[57701] Fizban's Mind[ INDOORS PRIVATE HOUSE ATRIUM][ Inside ][T 57792]")
  cap.feedLine("   Fizban's evil mind and ambitions will surely destroy all the world over time.")
  cap.feedLine('It is just a matter of time till you wake up to realize your life and the world')
  const det = cap.feedLine('[ Exits: n s ]')
  check('roomflag decorations stripped', det?.name, "Fizban's Mind")
  check('title vnum becomes a server id', det?.serverId, 'vnum:57701')
}
{
  // Stock tbaMUD vnums are 4 digits, so "%5d" pads a space INSIDE the bracket.
  const cap = new RoomCapture()
  cap.feedLine('[ 3001] The Temple Of Midgaard[ INDOORS PEACEFUL][ Inside ]')
  const det = cap.feedLine('[ Exits: n e s d ]')
  check('padded vnum still parsed', det?.serverId, 'vnum:3001')
  check('padded vnum title clean', det?.name, 'The Temple Of Midgaard')
}
{
  // Several triggers on the room; and no trailing tag at all when unscripted.
  const cap = new RoomCapture()
  cap.feedLine('[ 3001] The Temple Of Midgaard[ INDOORS PEACEFUL][ Inside ][T 3010 3011]')
  check('multi-trigger tag stripped', cap.feedLine('[ Exits: n ]')?.name, 'The Temple Of Midgaard')
  cap.feedLine('[ 3002] The Reading Room[ INDOORS][ Inside ]')
  check('unscripted room, no T tag', cap.feedLine('[ Exits: s ]')?.name, 'The Reading Room')
}
{
  // Automap rows sit between the title and the exits line, and the scan walks
  // backward — so they get first refusal on being the title.
  const cap = new RoomCapture()
  cap.feedLine('[ 3001] The Temple Of Midgaard[ INDOORS PEACEFUL][ Inside ]')
  cap.feedLine('   - - -')
  cap.feedLine('  | . . |')
  cap.feedLine('   - - -')
  const det = cap.feedLine('[ Exits: n e s d ]')
  check('automap rows are not titles', det?.name, 'The Temple Of Midgaard')
}
{
  // The MUD spoke while a prompt was open, so the prompt was terminated and
  // became a line directly above the room description. It must not win the
  // title scan — it did, and the first room got mapped as "1144H >".
  const cap = new RoomCapture()
  cap.feedLine('1144H >')
  cap.feedLine('[ Losing descriptor without char. ]')
  cap.feedLine('[ WARNING: Attempting to get content from iterator with NULL list. ]')
  cap.feedLine('')
  cap.feedLine("[57700] Fizban's Zone Description Room[ INDOORS PRIVATE HOUSE ATRIUM][ Inside ][T 57792]")
  cap.feedLine('   Fizban is a rather peculiar old man who enjoys filling his zone with strange')
  cap.feedLine('triggers, if you were to walk through this zone and explore it thoroughly with')
  cap.feedLine('nohassle off you would likely regret it.  A sign is seen to the right.')
  const det = cap.feedLine('[ Exits: s ]')
  check('prompt never becomes a title', det?.name, "Fizban's Zone Description Room")
}
{
  const cap = new RoomCapture()
  cap.feedLine('<221hp 340mv>')
  cap.feedLine('Temple Square')
  const det = cap.feedLine('[ Exits: n e s w ]')
  check('bracket-style prompt skipped too', det?.name, 'Temple Square')
}
{
  // A title the MUD wraps in brackets is the title, not a decoration.
  const cap = new RoomCapture()
  cap.feedLine('[ The Temple Of Midgaard ]')
  const det = cap.feedLine('[ Exits: n e s w ]')
  check('wholly bracketed title unwrapped', det?.name, 'The Temple Of Midgaard')
}
{
  const cap = new RoomCapture()
  cap.feedLine('Temple Square [anchorage:temple]')
  const det = cap.feedLine('[ Exits: n ]')
  check('single trailing tag still stripped', det?.name, 'Temple Square')
  check('no vnum, no server id', det?.serverId, undefined)
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
  // Two identical cells could both be this one, so nothing is written yet.
  check('maze: held rather than duplicated', Object.keys(model.map.rooms).length, before)
  check('maze: flagged as a guess', tracker.speculative, true)
  // Walking on settles it. Each twin's only exit is west into ground we have
  // never walked, so neither can explain a second step and both readings die.
  tracker.onCommand('w')
  seeRoom('Dead End', '[ Exits: e ]')
  check('maze: settles into new rooms', Object.keys(model.map.rooms).length, before + 2)
  check('maze: no longer guessing', tracker.speculative, false)
  check('maze: not linked to either twin', tracker.currentRoom?.name, 'Dead End')
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
  check('twin: held rather than duplicated', Object.keys(model.map.rooms).length, countBefore)
  // The twin lies WEST while we walked east, so it is never worth showing as a
  // bet either -- the position must not jump backwards.
  check('twin: did not jump west', tracker.currentRoomId !== westTwin.id, true)
  check('twin: flagged as a guess', tracker.speculative, true)

  tracker.onCommand('e')
  seeRoom('A Quiet Lane', '[ Exits: w ]')
  check('twin: settles into new rooms', Object.keys(model.map.rooms).length, countBefore + 2)
  const arrived = model.room(model.exitOf(model.room(here.id)!, 'e')?.to ?? '')!
  check('twin: new room lies east', arrived.x > here.x, true)
  check('twin: linked from origin', arrived.name, 'Northern Outer Courtyard')
  check('twin: never adopted the twin', arrived.id !== westTwin.id, true)
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
  check('ambig: held rather than duplicated', Object.keys(model.map.rooms).length, before2)
  // Nothing corroborates any of the three twins on the next step either, so
  // the run commits as new rooms and still says so.
  tracker.onCommand('e')
  seeRoom('Watchtower Steps', '[ Exits: w ]')
  check('ambig: unresolvable still creates', Object.keys(model.map.rooms).length, before2 + 2)
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
  check('gap: held rather than duplicated', Object.keys(model.map.rooms).length, countBefore)
  check('gap: did not jump to far twin', tracker.currentRoomId !== farTwin.id, true)

  // Continuing west settles it. The far twin cannot explain a second step west
  // -- its own w exit is unexplored -- so the run commits: the room that
  // belongs in the gap is created, and the twin beyond it is then recognised
  // by exact adjacency rather than duplicated a second time.
  tracker.onCommand('w')
  seeRoom('Northern Outer Courtyard', '[ Exits: e s w ]')
  check('gap: new room created', Object.keys(model.map.rooms).length, countBefore + 1)
  const gapRoom = model.room(model.exitOf(model.room(northeast.id)!, 'w')?.to ?? '')!
  check('gap: created in the gap', [gapRoom.x, gapRoom.y], [1, 0])
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

// ---- hidden doors mid-walk: auto-open + retry; hard blocks halt ----
{
  const model = new MapModel(emptyMap(), () => {})
  const lines: string[] = []
  const transmitted: string[] = []
  let retried = false
  // eslint-disable-next-line prefer-const
  let walker!: Walker
  const tracker: MapTracker = new MapTracker(model, {
    info: (t) => lines.push(t),
    onMoveFailed: (dir, closedDoor) => {
      // Mirrors SessionStore.handleMoveFailed: open + retry once, else halt.
      if (closedDoor && !retried) {
        retried = true
        transmit(`open door ${dir}`)
        transmit(dir)
      } else {
        walker.notifyStepFailed(closedDoor ? 'door will not open' : 'the way is blocked')
      }
    }
  })
  const transmit = (c: string) => {
    transmitted.push(c)
    tracker.onCommand(c)
  }
  walker = new Walker(tracker, {
    transmit,
    info: (t) => lines.push(t),
    error: (t) => lines.push('ERR:' + t)
  })
  const seeRoom = (name: string, exitsLine: string) => {
    tracker.onLine(name)
    tracker.onLine(exitsLine)
  }

  // Map A --n--> B with NO door recorded (the door is hidden).
  seeRoom('Guard Hall', '[ Exits: n ]')
  const a = tracker.currentRoom!
  tracker.onCommand('n')
  seeRoom('Armory', '[ Exits: s n ]')
  const b = tracker.currentRoom!
  tracker.setCurrentRoom(a.id)

  // Walk to B; the hidden door bounces the first attempt.
  transmitted.length = 0
  walker.start([{ command: 'n', toRoomId: b.id }], 'the Armory', false)
  check('door-retry: first attempt sent', transmitted, ['n'])
  tracker.onLine('The door seems to be closed.')
  check('door-retry: opened and retried', transmitted, ['n', 'open door n', 'n'])
  check('door-retry: door learned on map', model.exitOf(model.room(a.id)!, 'n')?.door, true)
  seeRoom('Armory', '[ Exits: s n ]')
  check('door-retry: walk completed', lines.some((t) => t.includes('Arrived at the Armory')), true)
  check('door-retry: walker idle', walker.walking, false)

  // Unmapped-territory step (speedwalk style): any arrival counts.
  retried = false
  transmitted.length = 0
  walker.start([{ command: 'n', toRoomId: null }], 'the end of .n', false)
  seeRoom('Winding Stair', '[ Exits: s u ]')
  check('open-step: arrival confirmed without expectation', walker.walking, false)
  check('open-step: arrived message', lines.some((t) => t.includes('Arrived at the end of .n')), true)

  // A genuinely blocked way halts the walk immediately with the reason.
  tracker.setCurrentRoom(a.id)
  lines.length = 0
  walker.start([{ command: 'n', toRoomId: b.id }], 'the Armory', false)
  tracker.onLine('Alas, you cannot go that way.')
  check('hard-block: walk halted', walker.walking, false)
  check('hard-block: reason reported', lines.some((t) => t.includes('the way is blocked')), true)
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

// ---- replay: The Builder Academy, roomflags on (the session that went lost) ----
{
  const { model, tracker, infos } = makeWorld()
  const noise = (): void => {
    // The MUD talking over an open prompt, which is what puts a bare prompt
    // line directly above the next room description.
    tracker.onLine('1144H >')
    tracker.onLine('[ Losing descriptor without char. ]')
    tracker.onLine('[ WARNING: Attempting to get content from iterator with NULL list. ]')
    tracker.onLine('')
  }
  const mind = (): void => {
    tracker.onLine("[57701] Fizban's Mind[ INDOORS PRIVATE HOUSE ATRIUM][ Inside ][T 57792]")
    tracker.onLine("   Fizban's evil mind and ambitions will surely destroy all the world over time.")
    tracker.onLine('It is just a matter of time till you wake up to realize your life and the world')
    tracker.onLine('as you know it never really existed and you and your world are in fact just a')
    tracker.onLine('fictitious reality Fizban imagined...  Most likely while eating shrooms.')
    tracker.onLine('[ Exits: n s ]')
  }
  const zoneRoom = (): void => {
    tracker.onLine("[57700] Fizban's Zone Description Room[ INDOORS PRIVATE HOUSE ATRIUM][ Inside ][T 57792]")
    tracker.onLine('   Fizban is a rather peculiar old man who enjoys filling his zone with strange')
    tracker.onLine('triggers, if you were to walk through this zone and explore it thoroughly with')
    tracker.onLine('nohassle off you would likely regret it.  A sign is seen to the right.')
    tracker.onLine('[ Exits: s ]')
  }

  noise()
  mind() // "look"
  const start = tracker.currentRoomId
  check('replay: mapping started in the real room', tracker.currentRoom?.name, "Fizban's Mind")
  check('replay: room carries the vnum', tracker.currentRoom?.serverId, 'vnum:57701')

  tracker.onCommand('n')
  zoneRoom()
  check('replay: walked north into the zone room', tracker.currentRoom?.name, "Fizban's Zone Description Room")

  tracker.onCommand('s')
  mind()
  check('replay: south returns to the same room', tracker.currentRoomId, start)
  check('replay: never went lost', tracker.lost, false)
  check('replay: no lost message', infos.some((t) => t.startsWith('Mapper lost')), false)
  check('replay: two rooms, not four', Object.keys(model.map.rooms).length, 2)
  check(
    'replay: exits linked both ways',
    model.exitOf(model.room(start)!, 'n')?.to !== null,
    true
  )
}

// ---- displaced diagonal neighbour: recognise it, do not mint a twin ----
// Straight from Dawn of Demise: "A Moldy Tunnel" has an unwalked `nw`, and the
// already-mapped "A Bright Tunnel" holds the matching unwalked `se` -- but
// greedy placement drew it due WEST, so neither the back-link nor the exact
// cell test fires and the mapper created a second Bright Tunnel.
{
  const { model, tracker, seeRoom } = makeWorld()
  const moldy = model.createRoom({
    name: 'A Moldy Tunnel', x: 0, y: 0, z: 0,
    exits: [
      { dir: 'n', to: null, door: false },
      { dir: 's', to: null, door: false },
      { dir: 'nw', to: null, door: false }
    ]
  })
  const bright = model.createRoom({
    name: 'A Bright Tunnel', x: -1, y: 0, z: 0, // drawn WEST, not north-west
    exits: [
      { dir: 'w', to: null, door: false },
      { dir: 'nw', to: null, door: false },
      { dir: 'se', to: null, door: false } // unclaimed, faces back at moldy
    ]
  })
  const before = Object.keys(model.map.rooms).length
  tracker.setCurrentRoom(moldy.id)
  tracker.onCommand('nw')
  seeRoom('A Bright Tunnel', '[ Exits: w nw se ]')
  check('displaced: recognised, no twin', Object.keys(model.map.rooms).length, before)
  check('displaced: standing in the known room', tracker.currentRoomId, bright.id)
  check('displaced: link written', model.exitOf(model.room(moldy.id)!, 'nw')?.to, bright.id)
  check('displaced: not lost', tracker.lost, false)
}

// ---- follow mode identifies known rooms; it just never creates ----
{
  const { model, tracker, seeRoom, infos } = makeWorld()
  const moldy = model.createRoom({
    name: 'A Moldy Tunnel', x: 0, y: 0, z: 0,
    exits: [{ dir: 'nw', to: null, door: false }]
  })
  const bright = model.createRoom({
    name: 'A Bright Tunnel', x: -1, y: 0, z: 0,
    exits: [
      { dir: 'w', to: null, door: false },
      { dir: 'se', to: null, door: false }
    ]
  })
  const before = Object.keys(model.map.rooms).length
  tracker.setCurrentRoom(moldy.id)
  tracker.setMode('follow')
  tracker.onCommand('nw')
  seeRoom('A Bright Tunnel', '[ Exits: w se ]')
  check('follow: identified instead of going lost', tracker.currentRoomId, bright.id)
  check('follow: not lost', tracker.lost, false)
  check('follow: created nothing', Object.keys(model.map.rooms).length, before)
  check('follow: wrote no link', model.exitOf(model.room(moldy.id)!, 'nw')?.to, null)
  check('follow: said nothing about being lost',
    infos.some((t) => t.startsWith('Mapper lost')), false)
}

// ---- follow mode still goes lost in genuinely unknown territory ----
{
  const { model, tracker, seeRoom } = makeWorld()
  const start = model.createRoom({
    name: 'A Moldy Tunnel', x: 0, y: 0, z: 0,
    exits: [{ dir: 'n', to: null, door: false }]
  })
  tracker.setCurrentRoom(start.id)
  tracker.setMode('follow')
  tracker.onCommand('n')
  seeRoom('Somewhere Entirely New', '[ Exits: s ]')
  check('follow: unknown territory is still lost', tracker.lost, true)
}

// ---- the MUD names the door for us ----
check('door name: grate', closedDoorName('The grate is closed.'), 'grate')
check('door name: multiword', closedDoorName('The iron gate seems to be closed.'), 'iron gate')
check('door name: plain door', closedDoorName('The door is closed.'), 'door')
check('door name: not a door line', closedDoorName('Bob says: the grate is closed.'), null)
check('door name: prose is not a name', closedDoorName('Alas, you cannot go that way.'), null)

// ---- opening a door names it only once we know the noun ----
check('open cmd: bare direction when unnamed',
  exitOpenCommand({ dir: 'd', to: null, door: true }), 'open down')
check('open cmd: learned noun once known',
  exitOpenCommand({ dir: 'd', to: null, door: true, doorName: 'grate' }), 'open grate down')
check('open cmd: no door, no command',
  exitOpenCommand({ dir: 'd', to: null, door: false }), undefined)

// ---- the map pane remembers how it was left, per MUD ----
{
  const saves: MudMap[] = []
  // Snapshot: the saver is handed the live map object, so without a copy
  // these assertions would read current state rather than what was written.
  const model = new MapModel(emptyMap(), (m) => saves.push(structuredClone(m)))
  check('pane: never chosen is undefined, not false', model.map.paneOpen, undefined)

  model.setPaneOpen(false)
  check('pane: closing is recorded', model.map.paneOpen, false)
  model.flush()
  check('pane: closing is persisted', saves.at(-1)?.paneOpen, false)

  // Reloading that file restores the choice rather than re-opening the pane.
  const reloaded = new MapModel(structuredClone(saves.at(-1)!), () => {})
  check('pane: closed survives a reload', reloaded.map.paneOpen, false)
  reloaded.setPaneOpen(true)
  reloaded.flush()
  check('pane: reopening is recorded', reloaded.map.paneOpen, true)

  // Undefined must stay distinguishable from an explicit false: it is what
  // makes a first visit fall back to "open if there is a map worth showing".
  check('pane: a fresh map has made no choice', new MapModel(emptyMap(), () => {}).map.paneOpen,
    undefined)
  // Writing the same value twice must not churn the save timer.
  const quiet: MudMap[] = []
  const q = new MapModel(emptyMap(), (m) => quiet.push(structuredClone(m)))
  q.setPaneOpen(true)
  q.flush()
  q.setPaneOpen(true)
  q.flush()
  check('pane: setting the same value does not re-save', quiet.length, 1)
}

// ---- the pop-out window remembers its monitor ----
{
  const saves: MudMap[] = []
  // Snapshot: the saver is handed the live map object, so without a copy
  // these assertions would read current state rather than what was written.
  const model = new MapModel(emptyMap(), (m) => saves.push(structuredClone(m)))
  check('popout: not open by default', model.map.popout ?? null, null)

  // A second monitor sitting left of the primary one has negative x.
  const onSecond = { x: -1720, y: 240, width: 640, height: 560 }
  model.setPopout(onSecond)
  model.flush()
  check('popout: bounds recorded', model.map.popout, onSecond)
  check('popout: bounds persisted', saves.at(-1)?.popout, onSecond)

  const reloaded = new MapModel(structuredClone(saves.at(-1)!), () => {})
  check('popout: survives a reload', reloaded.map.popout, onSecond)

  // Moving it writes the new position...
  const moved = { x: -1400, y: 100, width: 800, height: 600 }
  reloaded.setPopout(moved)
  check('popout: following the window', reloaded.map.popout, moved)
  // ...but re-reporting the same position must not churn the save timer.
  const quiet: MudMap[] = []
  const q = new MapModel(emptyMap(), (m) => quiet.push(structuredClone(m)))
  q.setPopout(moved)
  q.flush()
  q.setPopout({ ...moved })
  q.flush()
  check('popout: identical bounds do not re-save', quiet.length, 1)

  // Closing it forgets it, so it does not come back next launch.
  q.setPopout(null)
  check('popout: closing clears it', q.map.popout, null)
  q.flush()
  check('popout: the clear is persisted', quiet.at(-1)!.popout, null)
}

// ---- Dawn of Demise: the duplicate that used to be unavoidable ----
// "A Moldy Tunnel" has an unwalked `s`; "A Mildew-Filled Tunnel" is already on
// the map with the matching unwalked `n`, but placement drew it two cells away
// so neither a back-link nor the exact cell corroborates. Committing on the
// spot minted a twin. Holding the move does not.
{
  const { model, tracker, seeRoom } = makeWorld()
  const moldy = model.createRoom({
    name: 'A Moldy Tunnel', x: 0, y: 0, z: 0,
    exits: [{ dir: 'n', to: null, door: false }, { dir: 's', to: null, door: false }]
  })
  const mildew = model.createRoom({
    name: 'A Mildew-Filled Tunnel', x: 0, y: 2, z: 0, // two cells south, not one
    exits: [{ dir: 'n', to: null, door: false }, { dir: 's', to: null, door: false }]
  })
  const junction = model.createRoom({
    name: 'A Sewer Junction', x: 0, y: 3, z: 0,
    exits: [{ dir: 'n', to: null, door: false }]
  })
  model.linkRooms(mildew.id, 's', junction.id, true)
  const before = Object.keys(model.map.rooms).length

  tracker.setCurrentRoom(moldy.id)
  tracker.onCommand('s')
  seeRoom('A Mildew-Filled Tunnel', 'Exits: north south')
  check('mildew: nothing written yet', Object.keys(model.map.rooms).length, before)
  check('mildew: knows it is guessing', tracker.speculative, true)
  check('mildew: no bet across the gap', tracker.currentRoomId, moldy.id)

  // One more step decides it: only the real Mildew has a south exit onto the
  // junction, so that reading is the last one standing.
  tracker.onCommand('s')
  seeRoom('A Sewer Junction', 'Exits: north')
  check('mildew: no duplicate created', Object.keys(model.map.rooms).length, before)
  check('mildew: settled', tracker.speculative, false)
  check('mildew: standing in the junction', tracker.currentRoomId, junction.id)
  check('mildew: backfilled the link it held', model.exitOf(model.room(moldy.id)!, 's')?.to,
    mildew.id)
  check('mildew: not lost', tracker.lost, false)
}

// ---- eight identical parapets: resolved by the walk, not by the room ----
// Entering a wall of same-named rooms cannot be resolved on arrival by any
// fingerprint. It resolves at the far end, and the rooms walked through in the
// meantime are backfilled rather than duplicated.
{
  const { model, tracker, seeRoom } = makeWorld()
  const wall = [0, 1, 2, 3].map((i) =>
    model.createRoom({
      name: 'western keep parapet', x: 0, y: -i, z: 0,
      exits: [{ dir: 'n', to: null, door: false }, { dir: 's', to: null, door: false }]
    })
  )
  for (let i = 0; i < wall.length - 1; i++) model.linkRooms(wall[i].id, 'n', wall[i + 1].id, true)
  const tower = model.createRoom({
    name: 'the north tower', x: 0, y: -4, z: 0,
    exits: [{ dir: 's', to: null, door: false }]
  })
  model.linkRooms(wall[3].id, 'n', tower.id, true)
  // Far enough east that position corroborates nothing on arrival.
  const bailey = model.createRoom({
    name: 'the inner bailey', x: 3, y: -2, z: 0,
    exits: [{ dir: 'w', to: null, door: false }]
  })
  const before = Object.keys(model.map.rooms).length

  tracker.setCurrentRoom(bailey.id)
  tracker.onCommand('w')
  seeRoom('western keep parapet', 'Exits: north south')
  check('parapet: all four readings still open', tracker.speculative, true)
  check('parapet: nothing written on arrival', Object.keys(model.map.rooms).length, before)

  // Walking the wall prunes one reading per step: the one already at the top
  // would have to see the tower, and does not.
  tracker.onCommand('n')
  seeRoom('western keep parapet', 'Exits: north south')
  check('parapet: still unsure after one step', tracker.speculative, true)
  tracker.onCommand('n')
  seeRoom('western keep parapet', 'Exits: north south')
  check('parapet: still unsure after two', tracker.speculative, true)
  tracker.onCommand('n')
  seeRoom('western keep parapet', 'Exits: north south')

  check('parapet: resolved by the walk', tracker.speculative, false)
  check('parapet: not one room duplicated', Object.keys(model.map.rooms).length, before)
  check('parapet: standing at the top of the wall', tracker.currentRoomId, wall[3].id)
  check('parapet: backfilled where we came in', model.exitOf(model.room(bailey.id)!, 'w')?.to,
    wall[0].id)
  check('parapet: not lost', tracker.lost, false)
  void tower
}

// ---- description hashing ----
{
  const cap = new RoomCapture()
  cap.feedLine('An Outstretched Tunnel')
  cap.feedLine('The Tunnel is much larger here, and because of that, the smell of')
  cap.feedLine('the sewer is much stronger here.')
  const a = cap.feedLine('Exits: north east south west')
  check('desc: a description is hashed', typeof a?.descHash, 'string')

  // The same room seen again hashes the same, however the lines are wrapped.
  const cap2 = new RoomCapture()
  cap2.feedLine('An Outstretched Tunnel')
  cap2.feedLine('The Tunnel is much larger here, and because of that,  the smell')
  cap2.feedLine('of the sewer is much stronger here.')
  const b = cap2.feedLine('Exits: north east south west')
  check('desc: rewrapping does not change it', b?.descHash, a?.descHash)

  // Objects and mobs sit after a blank line, so picking one up cannot change
  // what the room looks like to the mapper.
  const cap3 = new RoomCapture()
  cap3.feedLine('An Outstretched Tunnel')
  cap3.feedLine('The Tunnel is much larger here, and because of that, the smell of')
  cap3.feedLine('the sewer is much stronger here.')
  cap3.feedLine('')
  cap3.feedLine('A rusty lantern lies here.')
  const c = cap3.feedLine('Exits: north east south west')
  check('desc: objects do not perturb it', c?.descHash, a?.descHash)

  // A different room hashes differently.
  const cap4 = new RoomCapture()
  cap4.feedLine('A Slimey Tunnel')
  cap4.feedLine('Globs of slime pour down from the ceiling.')
  const d = cap4.feedLine('Exits: west down')
  check('desc: a different room differs', d?.descHash !== a?.descHash, true)

  // A room with no description at all simply has none.
  const cap5 = new RoomCapture()
  cap5.feedLine('A Bare Room')
  const e = cap5.feedLine('Exits: north')
  check('desc: none printed, none recorded', e?.descHash, undefined)
}

// ---- exploration: a duplicate is created, then reconciled away ----
// The case v0.4.11 could not reach. Nothing is mapped ahead, so holding the
// move cannot help -- every reading dies on the next step and a copy IS made.
// The evidence that it was a copy only turns up two rooms later.
{
  const { model, tracker, infos } = makeWorld()
  const DESC = {
    tunnel: 'The Tunnel is much larger here, and the smell of the sewer is stronger.',
    corner: 'A dark corner where the tunnels meet. Something scuttles out of sight.',
    slime: 'Globs of slime pour down from the ceiling and pool on the floor.',
    squeeze: 'The walls press in close here and the air is thin.'
  }
  const see = (name: string, desc: string, exits: string): void => {
    tracker.onLine(name)
    tracker.onLine(desc)
    tracker.onLine(exits)
  }

  // Already mapped, from a previous visit that came in from the north only.
  const corner = model.createRoom({
    name: 'A Dark Corner', x: 5, y: 4, z: 0, descHashes: [hashText(DESC.corner)],
    exits: [{ dir: 's', to: null, door: false }]
  })
  const known = model.createRoom({
    name: 'An Outstretched Tunnel', x: 5, y: 5, z: 0, descHashes: [hashText(DESC.tunnel)],
    exits: [
      { dir: 'n', to: null, door: false },
      { dir: 'e', to: null, door: false },
      { dir: 's', to: null, door: false },
      { dir: 'w', to: null, door: false }
    ]
  })
  model.linkRooms(corner.id, 's', known.id, true)
  const start = model.createRoom({
    name: 'A Tight Squeeze', x: 0, y: 0, z: 0,
    exits: [{ dir: 'e', to: null, door: false }]
  })
  const before = Object.keys(model.map.rooms).length
  tracker.setCurrentRoom(start.id)

  // East into a room whose name is already taken: held, nothing written.
  tracker.onCommand('e')
  see('An Outstretched Tunnel', DESC.tunnel, 'Exits: north east south west')
  check('explore: held on arrival', Object.keys(model.map.rooms).length, before)

  // East again into genuinely new ground. The known tunnel's east exit has
  // never been walked, so that reading dies and a copy has to be created.
  tracker.onCommand('e')
  see('A Slimey Tunnel', DESC.slime, 'Exits: west down')
  check('explore: a copy was created', Object.keys(model.map.rooms).length, before + 2)
  check('explore: warned about it', infos.some((t) => t.includes('identical name/exits')), true)
  const copy = model.room(model.exitOf(model.room(start.id)!, 'e')?.to ?? '')!
  check('explore: the copy remembers its rival', copy.rivals, [known.id])

  // Back west, then north -- which is how the previous visit reached it.
  tracker.onCommand('w')
  see('An Outstretched Tunnel', DESC.tunnel, 'Exits: north east south west')
  tracker.onCommand('n')
  see('A Dark Corner', DESC.corner, 'Exits: south')
  // Still unsure: one dark corner could be any dark corner.
  tracker.onCommand('s')
  see('An Outstretched Tunnel', DESC.tunnel, 'Exits: north east south west')

  // That settles it. Both rooms now agree their north leads to the same dark
  // corner, and they look identical -- two independent signals, so the copy is
  // merged away without anyone being asked.
  check('explore: the copy is gone', model.room(copy.id), null)
  check('explore: back to the original count', Object.keys(model.map.rooms).length, before + 1)
  check('explore: standing in the real room', tracker.currentRoomId, known.id)
  check('explore: told what happened',
    infos.some((t) => t.includes('already on the map')), true)
  check('explore: the way in was kept', model.exitOf(model.room(start.id)!, 'e')?.to, known.id)

  // ...and it can be put back, because an automatic merge must be reversible.
  const restored = model.undoLastMerge()
  check('explore: undo restores the copy', restored?.id, copy.id)
  check('explore: undo restores the count', Object.keys(model.map.rooms).length, before + 2)
  check('explore: undo restores the way in', model.exitOf(model.room(start.id)!, 'e')?.to, copy.id)
}

// ---- a direction cannot be reciprocal between two rooms ----
// Straight from a corrupted live map: room A's north exit was wired to the
// room drawn SOUTH of it, and since the mapper trusts its own links, every
// later walk north followed it back. The tell is that north from B already
// led to A, so north from A cannot also lead to B.
{
  const model = new MapModel(emptyMap(), () => {})
  const north = model.createRoom({ name: 'A Long Water-filled Tunnel', x: 0, y: -1, z: 0 })
  const south = model.createRoom({ name: 'A Long Water-filled Tunnel', x: 0, y: 0, z: 0 })
  model.linkRooms(south.id, 'n', north.id, false)
  check('mutual: the true link is written', model.exitOf(model.room(south.id)!, 'n')?.to, north.id)

  model.linkRooms(north.id, 'n', south.id, false)
  check('mutual: the contradiction is refused',
    model.exitOf(model.room(north.id)!, 'n')?.to ?? null, null)
  // The honest link the other way is still allowed.
  model.linkRooms(north.id, 's', south.id, false)
  check('mutual: the opposite direction is fine',
    model.exitOf(model.room(north.id)!, 's')?.to, south.id)
  // And a room may still lead to itself, which some MUDs really do.
  model.linkRooms(north.id, 'e', north.id, false)
  check('mutual: a self-loop is untouched', model.exitOf(model.room(north.id)!, 'e')?.to, north.id)
}

// ---- a stored link is not trusted past the room's description ----
{
  const { model, tracker } = makeWorld()
  const DESC_B = 'The walls are all of a different blue colour and a shallow pool lies here.'
  const DESC_NEW = 'The walls here are bare rock and the water has drained away entirely.'
  const here = model.createRoom({
    name: 'A Long Water-filled Tunnel', x: 0, y: 0, z: 0,
    exits: [{ dir: 'n', to: null, door: false }]
  })
  const linked = model.createRoom({
    name: 'A Long Water-filled Tunnel', x: 0, y: -1, z: 0,
    descHashes: [hashText(DESC_B)],
    exits: [{ dir: 's', to: null, door: false }]
  })
  model.linkRooms(here.id, 'n', linked.id, true)
  tracker.setCurrentRoom(here.id)

  // Walk north and see a room of the same name whose description is NOT the
  // one recorded for the room the link points at. Same name, same exits --
  // only the description says this is somewhere else.
  tracker.onCommand('n')
  tracker.onLine('A Long Water-filled Tunnel')
  tracker.onLine(DESC_NEW)
  tracker.onLine('Exits: south')
  check('desc-guard: did not adopt the linked room', tracker.currentRoomId !== linked.id, true)
}

// ---- AwakeMUD CE: exits listed one per line, each naming its room ----
// This codebase prints a bare "Obvious exits:" header and then a line per
// exit. Nothing matched, so no room was ever detected and the map stayed
// empty on a MUD that was otherwise working fine.
{
  check('awake: bare header is not a single-line exits list',
    parseExitsLine('Obvious exits:'), null)
  check('awake: an exit line names its destination',
    parseExitListLine('South - Interacting in the Shadowrun Universe'),
    { dir: 's', door: false, destName: 'Interacting in the Shadowrun Universe' })
  check('awake: a destination may itself contain dashes',
    parseExitListLine('North - Archetypal Chargen - Mage / Shaman Start Room')?.destName,
    'Archetypal Chargen - Mage / Shaman Start Room')
  check('awake: prose is not an exit line',
    parseExitListLine('Welcome - to the machine'), null)
  check('awake: a parenthesised direction is a door',
    parseExitListLine('(North) - A Sealed Vault')?.door, true)
}

{
  const { model, tracker } = makeWorld()
  // Verbatim from the session, including the twenty-line description that
  // used to push the title out of the scan-back window.
  const lines = [
    'Archetypal Chargen - Mage / Shaman Start Room (Peaceful)',
    '   Welcome to Awake CE. This room stands on the event horizon of a great rift,',
    'the rift connecting our world to that which lies beyond. You stand now at the',
    'sole entrance to this realm. As you explore these hallowed halls, you will',
    'discover everything you need to know to survive in the cruel, cold world the',
    'Earth has become in what is our present - midway through the 21st century.',
    'Mind you, here you will only be taught the theory of what you must do. Living',
    'long enough to learn how to apply it is completely up to you. Welcome, and',
    'good luck.',
    '   If you are using a screenreader, you should type TOGGLE SCREENREADER now.',
    'First things first: You will want to know how to interact with your new world.',
    'To look around at your surroundings, just type LOOK (or L for short). This',
    'will give you the description of the area you are in and show any objects,',
    'people, and/or monsters in the same area. You can also look more closely at',
    'things.',
    '   The HELPFILES will also help you a great deal. Type HELP <command> to',
    'gain help on a specific command or concept if you are having trouble.',
    '   Type SOUTH or S to continue on your journey.',
    'Obvious exits:',
    'South - Interacting in the Shadowrun Universe',
    ''
  ]
  for (const line of lines) tracker.onLine(line)

  check('awake: the room was detected at all', Object.keys(model.map.rooms).length, 1)
  const room = tracker.currentRoom!
  check('awake: named from the title, not the prose',
    room.name, 'Archetypal Chargen - Mage / Shaman Start Room')
  check('awake: the (Peaceful) flag is not part of the name',
    room.name.includes('Peaceful'), false)
  check('awake: the exit was recorded', room.exits.map((e) => e.dir), ['s'])
  check('awake: and it knows where it leads',
    room.exits[0].destName, 'Interacting in the Shadowrun Universe')
  check('awake: the description was hashed', (room.descHashes?.length ?? 0) > 0, true)

  // Walking south maps the second room and links the two.
  tracker.onCommand('s')
  for (const line of [
    'Interacting in the Shadowrun Universe (Peaceful)',
    '   The Shadowrun universe is set in the year 2064. International',
    'mega-corporations have gained control of the systems of power.',
    'Obvious exits:',
    'North - Archetypal Chargen - Mage / Shaman Start Room',
    'South - The Path of the Magician',
    ''
  ]) {
    tracker.onLine(line)
  }
  check('awake: the second room was mapped', Object.keys(model.map.rooms).length, 2)
  check('awake: linked from the first', model.exitOf(model.room(room.id)!, 's')?.to,
    tracker.currentRoomId)
  check('awake: both its exits were read',
    tracker.currentRoom!.exits.map((e) => e.dir).sort(), ['n', 's'])
  check('awake: an unwalked exit still names its room',
    tracker.currentRoom!.exits.find((e) => e.dir === 's')?.destName, 'The Path of the Magician')
  check('awake: not lost', tracker.lost, false)
}

// ---- a MUD nobody has written a built-in for ----
// The point of the rule: someone whose MUD prints rooms in a shape none of the
// built-ins know can describe it themselves, share it, and have it work --
// without editing this file and rebuilding the client.
{
  // Invented format: a boxed title, exits behind a bullet, chatter interleaved.
  const rule = {
    title: '^==\\s*(.+?)\\s*==$',
    exitsLine: '^\\s*>>\\s*ways out:\\s*(.+?)\\s*$',
    ignore: ['^\\[chat\\]']
  }
  const cap = new RoomCapture(rule)
  cap.feedLine('== The Glass Terrace ==')
  cap.feedLine('Sunlight falls through a roof of coloured panes.')
  cap.feedLine('[chat] Someone: anyone selling a lantern?')
  const det = cap.feedLine('>> ways out: north, east, down')
  check('rule: the title came from the rule', det?.name, 'The Glass Terrace')
  check('rule: the exits came from the rule',
    det?.exits.map((e) => e.dir), ['n', 'e', 'd'])
  check('rule: the description was still hashed', typeof det?.descHash, 'string')

  // Chatter must not become the description, or one person talking would
  // change what the room looks like.
  const quiet = new RoomCapture(rule)
  quiet.feedLine('== The Glass Terrace ==')
  quiet.feedLine('Sunlight falls through a roof of coloured panes.')
  const det2 = quiet.feedLine('>> ways out: north, east, down')
  check('rule: ignored lines do not alter identity', det2?.descHash, det?.descHash)
}

// ---- a rule for a listed-exits MUD, written by hand ----
{
  const cap = new RoomCapture({
    exitsHeader: '^\\s*Ways out:\\s*$',
    exitsItem: '^\\s*([A-Za-z]+)\\s*=>\\s*(.+?)\\s*$'
  })
  cap.feedLine('The Iron Bridge')
  cap.feedLine('A span of riveted iron crosses the chasm.')
  cap.feedLine('Ways out:')
  cap.feedLine('  North => The Far Bank')
  cap.feedLine('  South => The Near Bank')
  const det = cap.feedLine('')
  check('rule: header and item patterns drive the block',
    det?.exits.map((e) => e.dir).sort(), ['n', 's'])
  check('rule: destinations are read from the rule too',
    det?.exits.find((e) => e.dir === 'n')?.destName, 'The Far Bank')
  check('rule: the title is still found by scanning back', det?.name, 'The Iron Bridge')
}

// ---- the built-ins keep working alongside, and can be switched off ----
{
  const withBoth = new RoomCapture({ exitsLine: '^\\s*>>\\s*(.+?)\\s*$' })
  withBoth.feedLine('Temple Square')
  check('rule: built-ins still apply by default',
    withBoth.feedLine('[ Exits: n e ]')?.exits.map((e) => e.dir), ['n', 'e'])

  const only = new RoomCapture({ exitsLine: '^\\s*>>\\s*(.+?)\\s*$', builtins: false })
  only.feedLine('Temple Square')
  check('rule: built-ins can be turned off', only.feedLine('[ Exits: n e ]'), null)
}

// ---- a broken pattern is a typo, not an outage ----
{
  const cap = new RoomCapture({ title: '^(unclosed', exitsLine: '^\\s*Exits:\\s*(.+)$' })
  check('rule: the bad field is reported', cap.badPatterns, ['title'])
  cap.feedLine('Temple Square')
  const det = cap.feedLine('Exits: north east')
  check('rule: the rest of the rule still works',
    det?.exits.map((e) => e.dir), ['n', 'e'])
  check('rule: and the title falls back to the heuristic', det?.name, 'Temple Square')
}

// ---- lost on an empty map is a dead end, and must not be ----
// Reported live: two hand-made rooms anchored the tracker, the real room did
// not match either, so it went lost -- and deleting them left it lost with
// nothing to re-anchor onto. The banner tells you to right-click your room on
// the map, which is impossible when there are none, so nothing ever mapped.
{
  const { model, tracker, seeRoom, infos } = makeWorld()
  const stray = model.createRoom({ name: 'New room', x: 0, y: 0, z: 0 })
  tracker.setCurrentRoom(stray.id)

  // A real room arrives that matches nothing: lost, correctly.
  seeRoom('Archetypal Chargen - Mage / Shaman Start Room', 'Exits: south')
  check('stuck: went lost as before', tracker.lost, true)

  // The hand-made room is deleted, leaving nothing to re-anchor onto.
  model.deleteRoom(stray.id)
  check('stuck: the map is empty', Object.keys(model.map.rooms).length, 0)

  seeRoom('Archetypal Chargen - Mage / Shaman Start Room', 'Exits: south')
  check('stuck: starts mapping again', Object.keys(model.map.rooms).length, 1)
  check('stuck: no longer lost', tracker.lost, false)
  check('stuck: standing in it', tracker.currentRoom?.name,
    'Archetypal Chargen - Mage / Shaman Start Room')
  check('stuck: said so', infos.some((t) => t.startsWith('Mapping started')), true)
}

// ---- but a map with rooms in it still waits to be told where we are ----
{
  const { model, tracker, seeRoom } = makeWorld()
  const a = model.createRoom({ name: 'Temple Square', x: 0, y: 0, z: 0 })
  model.createRoom({ name: 'Temple Square', x: 5, y: 5, z: 0 })
  tracker.setCurrentRoom(a.id)
  seeRoom('Somewhere Else Entirely', 'Exits: north')
  check('stuck: lost with rooms present', tracker.lost, true)
  const before = Object.keys(model.map.rooms).length
  seeRoom('Another Unknown Place', 'Exits: south')
  check('stuck: does not seed over an existing map',
    Object.keys(model.map.rooms).length, before)
  check('stuck: still lost, still waiting', tracker.lost, true)
}

// ---- link geometry: obstruction, direction fidelity, long spans ----
{
  const occ = (cells: Array<[number, number]>) => {
    const set = new Set(cells.map(([x, y]) => `${x},${y}`))
    return (x: number, y: number): boolean => set.has(`${x},${y}`)
  }
  const empty = occ([])
  const r3 = (n: number) => Math.round(n * 1000) / 1000

  // ---- obstruction ----
  // The reported case: c(0,1) linked east to e(2,1) with d(1,1) between them,
  // d itself connected only north. Drawn straight, the c–e line is painted
  // over by d's opaque box and survives as "c–d" plus "d–e".
  const cde = occ([[0, 1], [1, 1], [2, 1]])
  check('geometry: link across an occupied cell is obstructed',
    isObstructed({ x: 0, y: 1 }, { x: 2, y: 1 }, cde), true)
  const bowed = linkPath({ x: 0, y: 1 }, { x: 2, y: 1 }, 'e', cde)
  check('geometry: obstructed link is bowed', bowed.bowed, true)
  check('geometry: bow leaves the chord', bowed.c1.y !== 1 && bowed.c2.y !== 1, true)

  check('geometry: adjacent link is not bowed',
    linkPath({ x: 0, y: 0 }, { x: 1, y: 0 }, 'e', occ([[0, 0], [1, 0]])).bowed, false)

  // A two-cell span over EMPTY ground is not an obstruction — that gap is
  // unmapped ground, and bowing it would imply something is hiding there.
  check('geometry: two-cell span over empty ground is not bowed',
    linkPath({ x: 0, y: 0 }, { x: 2, y: 0 }, 'e', occ([[0, 0], [2, 0]])).bowed, false)

  // A perpendicular-nudged destination threads between (1,0) and (1,1),
  // clipping neither box.
  check('geometry: nudged span threads between two rooms',
    isObstructed({ x: 0, y: 0 }, { x: 2, y: 1 }, occ([[0, 0], [1, 0], [1, 1], [2, 1]])), false)
  check('geometry: nudged span blocked by a room on the line',
    isObstructed({ x: 0, y: 0 }, { x: 4, y: 2 }, occ([[0, 0], [2, 1], [4, 2]])), true)

  // A room appearing elsewhere must not flip an established bow, or the map
  // wiggles as the player explores.
  check('geometry: bow side unchanged by unrelated rooms',
    linkPath({ x: 0, y: 1 }, { x: 2, y: 1 }, 'e',
      occ([[0, 1], [1, 1], [2, 1], [5, 5], [0, 3]])).c1, bowed.c1)
  // Occupying the apex cell itself is the one thing that flips it.
  const flipped = linkPath({ x: 0, y: 1 }, { x: 2, y: 1 }, 'e',
    occ([[0, 1], [1, 1], [2, 1], [1, 2]]))
  check('geometry: bow flips when its apex cell is taken',
    Math.sign(flipped.c1.y - 1) === -Math.sign(bowed.c1.y - 1), true)

  // Asked from the far end the SAME curve must come back, controls swapped —
  // the highlight pass redraws a selected room's own face, and two disagreeing
  // arcs for one link would render a lens.
  const back = linkPath({ x: 2, y: 1 }, { x: 0, y: 1 }, 'w', cde)
  check('geometry: same curve from either endpoint',
    [r3(back.c1.x), r3(back.c1.y), r3(back.c2.x), r3(back.c2.y)],
    [r3(bowed.c2.x), r3(bowed.c2.y), r3(bowed.c1.x), r3(bowed.c1.y)])

  // ---- bearing fidelity ----
  // An unobstructed link is dead straight: controls sit on the chord. Bending
  // it to convey direction does not work -- a true departure tangent at both
  // ends of a link between two level rooms makes an S symmetric about the
  // chord, so half of it leans the wrong way and reads as the opposite
  // diagonal. Bearing is marked, not drawn.
  const honest = linkPath({ x: 0, y: 0 }, { x: 0, y: -1 }, 'n', empty)
  check('geometry: unobstructed link is straight',
    [r3(honest.c1.x), r3(honest.c1.y), r3(honest.c2.x), r3(honest.c2.y)],
    [0, -0.45, 0, -0.55])
  const sideways = linkPath({ x: 0, y: 0 }, { x: -1, y: 0 }, 'nw', empty)
  check('geometry: a mis-drawn link is straight too, not bent',
    [r3(sideways.c1.y), r3(sideways.c2.y)], [0, 0])

  // Bearing test: distance may differ, direction may not.
  check('bearing: one step the right way', drawnAsClaimed({ x: 0, y: 0 }, { x: 0, y: -1 }, 'n'), true)
  check('bearing: two steps the right way is still the right way',
    drawnAsClaimed({ x: -7, y: -11 }, { x: -7, y: -9 }, 's'), true)
  check('bearing: correct diagonal', drawnAsClaimed({ x: 0, y: 0 }, { x: 1, y: 1 }, 'se'), true)
  // The Dawn of Demise case: `nw` out of A Moldy Tunnel reaching a room that
  // placement drew due WEST. This is what earns an arrow.
  check('bearing: nw drawn due west is a lie',
    drawnAsClaimed({ x: -7, y: -11 }, { x: -8, y: -11 }, 'nw'), false)
  check('bearing: backwards is a lie', drawnAsClaimed({ x: 0, y: 0 }, { x: -1, y: 0 }, 'e'), false)
  check('bearing: right axis wrong sense is a lie',
    drawnAsClaimed({ x: 0, y: 0 }, { x: 0, y: 1 }, 'n'), false)
  check('bearing: up and down are never marked',
    drawnAsClaimed({ x: 0, y: 0 }, { x: 3, y: 3 }, 'u'), true)

  // ---- span ----
  check('geometry: one-step link spans 1',
    linkPath({ x: 0, y: 0 }, { x: 1, y: 0 }, 'e', empty).span, 1)
  check('geometry: two-step link spans 2 (gets the direct-connection mark)',
    linkPath({ x: -7, y: -11 }, { x: -7, y: -9 }, 's', empty).span, 2)
  check('geometry: diagonal span uses Chebyshev distance',
    linkPath({ x: 0, y: 0 }, { x: 2, y: 2 }, 'se', empty).span, 2)

  // ---- curve sampling ----
  const P0 = { x: 0, y: 1 }, P3 = { x: 2, y: 1 }
  check('geometry: midpoint is the same sampled from either end',
    [r3(cubicPoint(P0, bowed.c1, bowed.c2, P3, 0.5).x),
     r3(cubicPoint(P0, bowed.c1, bowed.c2, P3, 0.5).y)],
    [r3(cubicPoint(P3, bowed.c2, bowed.c1, P0, 0.5).x),
     r3(cubicPoint(P3, bowed.c2, bowed.c1, P0, 0.5).y)])
  check('geometry: tangent on a straight link points along it',
    r3(cubicTangent({ x: 0, y: 0 }, honest.c1, honest.c2, { x: 0, y: -1 }, 0.5).x), 0)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
