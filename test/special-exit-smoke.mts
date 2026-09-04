/**
 * Headless checks for walking a special exit by typing its command.
 *
 * Run with: node --experimental-strip-types test/special-exit-smoke.mts
 */
import { MapModel } from '../src/renderer/src/map/MapModel.ts'
import { MapTracker } from '../src/renderer/src/map/MapTracker.ts'
import { normalizeCommand, specialExitIndex } from '../src/renderer/src/map/Pathfinder.ts'
import type { MudMap } from '../src/renderer/src/map/types.ts'

let passed = 0
let failed = 0
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`)
}
const emptyMap = (): MudMap => ({ version: 1, zones: [], rooms: {}, waypoints: [] })

// ---- the match ----
check('normalise: case, spacing and a full stop', normalizeCommand('Say  I seek entrance to the spire.'), 'say i seek entrance to the spire')
check('normalise: a bang too', normalizeCommand('enter portal!'), 'enter portal')
const room = { exits: [{ dir: 'n' as const, to: null, door: false }, { dir: null, command: 'say I seek entrance to the spire.', to: null, door: false }] }
check('the exit is found without the full stop', specialExitIndex(room, 'say I seek entrance to the spire'), 1)
check('and in any case', specialExitIndex(room, 'SAY i seek entrance to the SPIRE'), 1)
check('a compass exit is never a special one', specialExitIndex(room, 'n'), -1)
check('another phrase is not it', specialExitIndex(room, 'say hello'), -1)

// ---- the walk ----
function world() {
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
  const { model, tracker, infos, seeRoom } = world()
  seeRoom('Before the Tower of Innocence', '[ Exits: sw ]')
  const tower = tracker.currentRoom!
  model.addSpecialExit(tower.id, 'say I seek entrance to the spire.', null)

  // Typed without the full stop: the exit is walked, and the unknown room
  // beyond it is created and linked.
  tracker.onCommand('say I seek entrance to the spire')
  seeRoom('The Silver Stairwell', '[ Exits: n u d ]')
  check('walked: not lost', tracker.lost, false)
  check('walked: standing in the new room', tracker.currentRoom?.name, 'The Silver Stairwell')
  const stair = tracker.currentRoom!
  const exit = model.room(tower.id)!.exits.find((e) => e.dir === null)!
  check('walked: the exit now leads there', exit.to, stair.id)
  check('walked: the new room is not drawn as a compass neighbour', Math.max(Math.abs(stair.x - tower.x), Math.abs(stair.y - tower.y)) >= 2, true)
  check('walked: same floor', stair.z, tower.z)
  check('walked: no lost message', infos.some((t) => t.includes('lost')), false)

  // A phrase that is not an exit of this room queues nothing: the next room
  // text is a look, not a step.
  tracker.onCommand('say I seek entrance to the spire')
  seeRoom('The Silver Stairwell', '[ Exits: n u d ]')
  check('not an exit here: still in the stairwell', tracker.currentRoom?.id, stair.id)
  check('not an exit here: no room created', Object.keys(model.map.rooms).length, 2)

  // Back at the tower (by hand), the same command lands in the known room --
  // even when the MUD prints only flavour text and the room appears half a
  // minute later, when the player finally types "look". A compass move
  // would have expired by then.
  tracker.setCurrentRoom(tower.id)
  tracker.onCommand('SAY i seek entrance to the spire.')
  tracker.onLine('You feel a pulling sensation as the air rushes past your ears.')
  const realNow = Date.now
  Date.now = () => realNow() + 40_000
  try {
    seeRoom('The Silver Stairwell', '[ Exits: n u d ]')
  } finally {
    Date.now = realNow
  }
  check('again, 40s later: arrives in the room the exit leads to', tracker.currentRoom?.id, stair.id)
  check('again: no duplicate', Object.keys(model.map.rooms).length, 2)
  check('again: not lost', tracker.lost, false)
}
{
  // The exit leads somewhere it turns out not to: the text describes a
  // different, known room -- adopt it and correct the exit.
  const { model, tracker, seeRoom } = world()
  seeRoom('Hub', '[ Exits: n ]')
  const hub = tracker.currentRoom!
  tracker.onCommand('n')
  seeRoom('Chapel', '[ Exits: s ]')
  const chapel = tracker.currentRoom!
  tracker.setCurrentRoom(hub.id)
  const wrong = model.createRoom({ name: 'Old Portal Room', x: 5, y: 5, z: 0, zoneId: hub.zoneId })
  model.addSpecialExit(hub.id, 'enter portal', wrong.id)
  tracker.onCommand('enter portal')
  seeRoom('Chapel', '[ Exits: s ]')
  check('corrected: standing in the chapel', tracker.currentRoom?.id, chapel.id)
  check('corrected: the exit learned it', model.room(hub.id)!.exits.find((e) => e.dir === null)!.to, chapel.id)
}
{
  // Follow mode creates nothing: an unknown room beyond a special exit is lost.
  const { model, tracker, infos, seeRoom } = world()
  seeRoom('Hub', '[ Exits: n ]')
  const hub = tracker.currentRoom!
  model.addSpecialExit(hub.id, 'enter portal', null)
  tracker.setMode('follow')
  tracker.onCommand('enter portal')
  seeRoom('Somewhere Else', '[ Exits: e ]')
  check('follow: lost', tracker.lost, true)
  check('follow: says which command', infos.some((t) => t.includes('"enter portal"')), true)
  check('follow: no room created', Object.keys(model.map.rooms).length, 1)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
