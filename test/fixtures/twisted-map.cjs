/** Fictional non-Euclidean zone: crossings, asymmetric returns and shortcuts. */
module.exports = function twistedMap() {
  const rooms = {}
  const add = (id, name, x, y, z = 0, zoneId = 'maze') => {
    rooms[id] = { id, name, x, y, z, zoneId, exits: [], fingerprint: name, descHashes: [] }
  }
  add('hall', 'Hall of Mirrors', 0, 0)
  add('chapel', 'Folded Chapel', 4, 0)
  add('dock', 'Sunken Landing', 0, 3)
  add('gate', 'Western Gate', -4, 0)
  add('cellar', 'Impossible Cellar', 3, -3)
  add('tower', 'Bell Tower', 0, 0, 1, 'tower')
  add('a', 'Gallery', -2, -2)
  add('b', 'Library', 0, -2)
  add('c', 'Observatory', 2, -2)
  add('d', 'Court', -2, 0)
  add('e', 'Crossroads', 2, 0)
  add('f', 'Garden', -2, 2)
  add('g', 'Well', 0, 2)
  add('h', 'Crypt', 2, 2)
  const link = (from, dir, to, back, extra = {}) => {
    rooms[from].exits.push({ dir, to, door: false, ...extra })
    if (back) rooms[to].exits.push({ dir: back, to: from, door: false })
  }
  link('hall', 'n', 'chapel', 'e', { door: true, doorName: 'mirror' })
  link('hall', 'e', 'dock', 'w')
  link('hall', 's', 'cellar', null)
  link('hall', 'w', 'gate', 'e')
  link('hall', null, 'chapel', null, { command: 'enter mirror' })
  link('hall', 'u', 'tower', 'd')
  link('hall', 'nw', null, null, { destName: 'Unexplored passage' })
  link('a', 'e', 'b', 'w'); link('b', 'e', 'c', 'w')
  link('a', 's', 'd', 'n'); link('c', 's', 'e', 'n')
  link('d', 's', 'f', 'n'); link('e', 's', 'h', 'n')
  link('f', 'e', 'g', 'w'); link('g', 'e', 'h', 'w')
  link('a', 'se', 'h', 'nw'); link('f', 'ne', 'c', 'sw')
  link('gate', 's', 'dock', 'n'); link('dock', 'e', 'chapel', 's')
  return { version: 1, rooms, zones: [{ id: 'maze', name: 'The Folded Halls' }, { id: 'tower', name: 'Upper Tower' }],
    waypoints: [{ name: 'Home', roomId: 'hall' }], lastRoomId: 'hall' }
}
