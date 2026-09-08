/** Renderer integration regressions with an in-memory IPC bridge. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const built = await build({
  stdin: { contents: `export { SessionStore, sessionStores } from './src/renderer/src/SessionStore'; export { settingsManager } from './src/renderer/src/SettingsManager'; export { defaultSettings } from './src/shared/types';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  plugins: [{ name: 'wasm-url', setup(b) {
    b.onResolve({ filter: /glue\.wasm\?url$/ }, () => ({ path: 'wasm', namespace: 'test' }))
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export default ""' }))
  } }]
})
function deferred() {
  let resolve!: (value: any) => void
  const promise = new Promise<any>((r) => { resolve = r })
  return { promise, resolve }
}
const reads = new Map<string | null, ReturnType<typeof deferred>>()
const maps = new Map<string, ReturnType<typeof deferred>>()
const sent: string[] = [], popouts: string[] = []
const frames: (() => void)[] = []
let beforeUnload: () => void = () => {}
const saves: any[] = []
;(globalThis as any).requestAnimationFrame = (fn: () => void) => frames.push(fn)
;(globalThis as any).window = {
  addEventListener(type: string, fn: () => void) { if (type === 'beforeunload') beforeUnload = fn },
  mud: {
    send: (_id: string, text: string) => sent.push(text),
    settings: {
      get: (key: string | null) => {
        const d = deferred(); reads.set(key, d); return d.promise
      },
      save: async (_key: unknown, value: unknown) => { saves.push(value); return value }
    },
    map: {
      load: (key: string) => { const d = deferred(); maps.set(key, d); return d.promise },
      save() {}, popout: async (id: string) => { popouts.push(id) }, mirrorState() {}
    },
    log: { start: async () => 'test.log', stop: async () => {}, line() {} }
  }
}
const mod = { exports: {} as any }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports)
const { SessionStore, sessionStores, settingsManager, defaultSettings } = mod.exports
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok ${name}`) } catch (err) { failures++; console.error(`FAIL ${name}`, err) }
}

const first = settingsManager.ensure('world')
let secondDone = false
const second = settingsManager.ensure('world').then(() => { secondDone = true })
await settle()
await check('concurrent ensure waits for the same reads', () => assert.equal(secondDone, false))
reads.get(null)!.resolve(defaultSettings())
const settings = defaultSettings()
settings.scripts.push({ id: 'startup', name: 'Startup', enabled: true, language: 'js', code: 'client.sendRaw("startup")' })
reads.get('world')!.resolve(settings)
await Promise.all([first, second])

const store = new SessionStore('cold-session', 'Cold world', 'localhost', 4000, 'cold-world')
store.handleEvent({ type: 'connected' })
reads.get('cold-world')!.resolve(settings)
await settle()
await check('startup scripts wait for settings', () => assert.deepEqual(sent, ['startup']))
store.dispose()
maps.get('cold-world')!.resolve({ rooms: {}, zones: [], waypoints: [], popout: { x: 0, y: 0, width: 640, height: 480 } })
await settle()
await check('late map load cannot resurrect a closed session', () => {
  assert.equal(store.mapModel, null)
  assert.deepEqual(popouts, [])
})
store.dispose()

const live = new SessionStore('live', 'World', 'localhost', 4000, 'world')
maps.get('world')!.resolve(null)
await settle()
live.handleEvent({ type: 'connected' })
await settle()
live.handleEvent({ type: 'msdp', data: { ROOM: { VNUM: '100', NAME: 'Square', EXITS: ['north', 'east'] } } })
await settle()
await check('MSDP array exits reach the mapper', () => {
  assert.deepEqual(live.tracker.currentRoom.exits.map((e: any) => e.dir).sort(), ['e', 'n'])
})
live.handleEvent({ type: 'mxpEnabled' })
settingsManager.getScope('world').triggers.push({ id: 'highlight', enabled: true, pattern: 'link', matchType: 'substring', highlight: 'red', commands: '', gag: false })
live.handleEvent({ type: 'text', data: '\x1b[1z<SEND HREF="look">link</SEND>\n' })
await check('highlighting retains MXP link actions', () => {
  const line = live.lines.find((l: any) => l.spans.some((s: any) => s.text === 'link'))
  assert.equal(line.spans[0].link?.command, 'look')
})
live.dispose()
await check('closed tracker unsubscribes from the shared map', () => assert.equal(live.mapModel.subs.size, 0))

const staleLoad = settingsManager.ensure('edited-during-load')
const edited = defaultSettings()
edited.variables.target = 'new value'
await settingsManager.save('edited-during-load', edited)
reads.get('edited-during-load')!.resolve(defaultSettings())
await staleLoad
await check('late reads do not overwrite a newer save', () => assert.equal(settingsManager.getScope('edited-during-load').variables.target, 'new value'))

sent.length = 0
const disconnected = new SessionStore('dropped', 'Dropped', 'localhost', 4000, 'dropped-world')
disconnected.handleEvent({ type: 'connected' })
disconnected.handleEvent({ type: 'disconnected', hadError: false })
reads.get('dropped-world')!.resolve(settings)
maps.get('dropped-world')!.resolve(null)
await settle()
await check('late settings do not run startup scripts after disconnect', () => assert.deepEqual(sent, []))
disconnected.dispose()

const logStart = deferred()
let starts = 0, stops = 0
window.mud.log.start = () => { starts++; return logStart.promise }
window.mud.log.stop = async () => { stops++ }
const closing = new SessionStore('logging', 'Logging', 'localhost', 4000, 'world')
await settle()
const pendingLog = closing.toggleLogging()
await closing.toggleLogging()
closing.dispose()
logStart.resolve('test.log')
await pendingLog
await check('closing during log start closes the late stream', () => {
  assert.equal(starts, 1)
  assert.equal(stops, 1)
  assert.equal(closing.logging, false)
})
const quitting = new SessionStore('quitting', 'Quitting', 'localhost', 4000, 'world')
await settle()
sessionStores.set(quitting.id, quitting)
quitting.setVariable('lastTarget', 'saved before quit')
beforeUnload()
await check('window shutdown flushes debounced variables', () => {
  assert.equal(saves.at(-1).variables.lastTarget, 'saved before quit')
})
sessionStores.clear()
console.log(`${failures} failures`)
process.exitCode = failures ? 1 : 0
