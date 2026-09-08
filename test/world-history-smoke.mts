import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { build } from 'esbuild'

const built = await build({ stdin: { resolveDir: process.cwd(), contents: `
export { WorldLibrary, validateWorld } from './src/main/WorldLibrary';
export { ProfileStore } from './src/main/ProfileStore'; export { SettingsStore } from './src/main/SettingsStore';
export { MapStore } from './src/main/MapStore'; export { HistoryStore } from './src/main/HistoryStore';
export { LogWriter } from './src/main/LogWriter'; export { defaultSettings } from './src/shared/types';
` }, bundle: true, write: false, platform: 'node', format: 'cjs' })
const mod = { exports: {} as any }
new Function('require','module','exports', built.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports)
const { WorldLibrary, validateWorld, ProfileStore, SettingsStore, MapStore, HistoryStore, LogWriter, defaultSettings } = mod.exports
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wayfarer-world-test-'))
try {
  const profiles = new ProfileStore(base), settings = new SettingsStore(base), maps = new MapStore(base)
  const world = profiles.save({ name: 'Test realm', host: 'example.invalid', port: 4000 })
  let open = false
  const library = new WorldLibrary(base, profiles, settings, maps, () => open)
  const original = defaultSettings(); original.variables = { character: 'Aster', hp: '42' }
  settings.save(world.id, original)
  const map = createRequire(import.meta.url)('./fixtures/twisted-map.cjs')()
  map.rooms.hall.cost = 4
  maps.save(world.id, map)
  const bundle = library.bundle(world.id)
  const preview = library.preview(JSON.parse(JSON.stringify(bundle)), 'file')
  const copy = library.import(preview.token, null)
  assert.notEqual(copy.id, world.id)
  assert.equal(profiles.list().length, 2)
  assert.deepEqual(settings.get(copy.id), settings.get(world.id))
  assert.deepEqual(maps.load(copy.id), map)
  assert.throws(() => library.import(preview.token, null), /expired/)
  console.log('ok world round trip preserves profile, variables and complete map; copies do not replace twins')

  const incoming = structuredClone(bundle); incoming.settings.variables.hp = '99'
  const restore = library.preview(incoming, 'replacement')
  open = true
  assert.throws(() => library.import(restore.token, world.id), /Close all tabs/)
  assert.equal(settings.get(world.id).variables.hp, '42')
  open = false
  library.import(restore.token, world.id)
  const snapshot = library.backups().find((b: any) => b.kind === 'worlds' && b.profileId === world.id)
  assert.ok(snapshot)
  library.import(library.previewBackup(snapshot.id).token, world.id)
  assert.equal(settings.get(world.id).variables.hp, '42')
  console.log('ok active-world restore blocked; replacement snapshot recovers prior complete world')

  const failing = library.preview(incoming, 'failure')
  const saveMap = maps.save.bind(maps)
  let fail = true
  maps.save = (...args: any[]) => { if (fail) { fail = false; throw new Error('simulated write failure') } saveMap(...args) }
  assert.throws(() => library.import(failing.token, world.id), /simulated/)
  assert.equal(settings.get(world.id).variables.hp, '42')
  assert.deepEqual(maps.load(world.id), map)
  maps.save = saveMap
  console.log('ok a failed multi-file restore rolls prior settings and map back')
  const newFilesBefore = ['profiles','settings','maps'].map((dir) => fs.readdirSync(path.join(base, dir)).sort())
  maps.save = () => { throw new Error('new import write failure') }
  assert.throws(() => library.import(library.preview(incoming, 'new failure').token, null), /new import/)
  assert.deepEqual(['profiles','settings','maps'].map((dir) => fs.readdirSync(path.join(base, dir)).sort()), newFilesBefore)
  maps.save = saveMap

  profiles.remove(world.id)
  const deleted = library.backups().find((b: any) => b.kind === 'profile' && b.profileId === world.id)
  const recovery = library.previewBackup(deleted.id)
  library.import(recovery.token, recovery.profileId)
  assert.equal(profiles.list().find((p: any) => p.id === world.id).name, world.name)
  assert.deepEqual(maps.load(world.id), map)
  const invalid = structuredClone(bundle); invalid.map.rooms.hall.exits = [null]
  assert.throws(() => validateWorld(invalid))
  const invalidSettings = structuredClone(bundle); invalidSettings.settings.triggers = [{ id: 'x', pattern: [] }]
  assert.throws(() => library.preview(invalidSettings, 'bad'))
  assert.throws(() => library.previewBackup('../../outside.json'))
  assert.equal(profiles.list().length, 2)
  console.log('ok deleted world identity restored; malformed bundles and traversal rejected before writes')

  const writer = new LogWriter(base)
  const file = writer.start('session', 'Test realm')
  writer.line('session', 'before', { character: 'Aster' })
  writer.line('session', 'The silver key gleams.', { character: 'Aster', channel: 'Tells' })
  writer.line('session', 'The silver key gleams.', { character: 'Other', channel: 'Market' })
  writer.line('session', 'after', { character: 'Aster' })
  const entries = [...(writer as any).streams.values()] as any[]
  const done = entries.flatMap((e) => [once(e.stream, 'finish'), once(e.history, 'finish')])
  writer.stopAll(); await Promise.all(done)
  const history = new HistoryStore(path.join(base, 'logs'))
  const found = await history.search({ text: 'SILVER', world: 'Test', character: 'aster', channel: 'tell', source: 'captures' })
  assert.equal(found.hits.length, 1)
  const hit = found.hits[0]
  const context = await history.context(hit.file, hit.line)
  assert.equal(context[0].text, 'before'); assert.equal(context.at(-1).text, 'after')
  assert.equal((await history.search({ text: 'silver', source: 'logs' })).hits.length, 0)
  assert.equal((await history.search({ text: 'silver', to: '2000-01-01' })).hits.length, 0)
  assert.ok(!fs.readFileSync(file, 'utf8').includes('silver'))
  await assert.rejects(history.context('../profiles.json', 1), /Invalid/)
  fs.writeFileSync(path.join(base, 'logs', 'Old_2024-01-02T12-00-00.log'), '[12:01:00] legacy treasure\n')
  assert.equal((await history.search({ text: 'treasure', world: 'old', from: '2024-01-02', to: '2024-01-02' })).hits.length, 1)
  fs.writeFileSync(path.join(base, 'logs', 'Midnight_2024-01-02T22-00-00.log'), '[23:59:00] before midnight\n[00:01:00] after midnight\n')
  const rollover = await history.search({ text: 'after midnight', from: '2024-01-03', to: '2024-01-03' })
  assert.equal(rollover.hits.length, 1)
  console.log('ok persisted captures filter by world/character/channel/date, include context, and legacy logs stay searchable')
} finally {
  assert.equal(path.dirname(base), path.resolve(os.tmpdir()))
  assert.ok(path.basename(base).startsWith('wayfarer-world-test-'))
  fs.rmSync(base, { recursive: true, force: true })
}
