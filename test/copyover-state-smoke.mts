import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
const built = await build({ stdin: { contents: `export {SessionStore} from './src/renderer/src/SessionStore'; export {settingsManager} from './src/renderer/src/SettingsManager'; export {defaultSettings} from './src/shared/types';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  plugins: [{ name: 'wasm-url', setup(b) { b.onResolve({ filter: /glue\.wasm\?url$/ }, () => ({ path: 'wasm', namespace: 'test' })); b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export default ""' })) } }] })
let settings: any, savedMap: any = null
const sent: string[] = []
;(globalThis as any).requestAnimationFrame = () => 0
;(globalThis as any).window = { addEventListener() {}, mud: {
  send: (_id: string, text: string) => sent.push(text),
  settings: { get: async () => settings, save: async (_id: unknown, value: any) => (settings = value) },
  map: { load: async () => savedMap, save() {}, persist: async (_key: string, value: unknown) => { savedMap = JSON.parse(JSON.stringify(value)) }, pushState() {} },
  log: { start: async () => 'test.log', stop: async () => {}, line() {} }
} }
const mod = { exports: {} as any }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports)
const { SessionStore, settingsManager, defaultSettings } = mod.exports
settings = defaultSettings()
settings.scripts = [{ id: 'startup', enabled: true, language: 'js', code: 'globals.counter=7;client.sendRaw("startup")' }]
settings.timers = [{ id: 'once', enabled: true, oneShot: true, intervalMs: 100, commands: 'once' }]
settings.triggers = [{ id: 'tick', enabled: true, pattern: 'tick', matchType: 'substring', commands: 'ack', gag: false, highlight: '' }]
await settingsManager.ensure(null)
let store = new SessionStore('same-id', 'Test', 'localhost', 4000)
await store.ready
store.handleEvent({ type: 'connected' })
store.engine.setVar('hp', '77', false)
store.handleEvent({ type: 'text', data: 'Old output\n' })
await new Promise(r => setTimeout(r, 150))
assert.deepEqual(sent, ['startup', 'once'])
const snapshot = JSON.parse(JSON.stringify(await store.snapshot()))
store.dispose()
store = new SessionStore('same-id', 'Test', 'localhost', 4000)
await store.restore(snapshot)
store.resumeCopyover()
await new Promise(r => setTimeout(r, 150))
assert.deepEqual(sent, ['startup', 'once'], 'neither login script nor completed one-shot runs twice')
assert.equal(store.engine.variables.hp, '77')
assert.equal(store.scripts.snapshot().counter, 7)
store.handleEvent({ type: 'text', data: 'tick\n' })
assert.deepEqual(sent, ['startup', 'once', 'ack'])
assert.equal(store.lines.filter((line: any) => line.spans.some((span: any) => span.text === 'Old output')).length, 1)
store.scripts.run('js', 'globals.callback=()=>client.sendRaw("wrong")')
await assert.rejects(store.snapshot(), /functions or circular/)
assert.equal(store.copyoverPaused, false, 'unsupported script state rejects before pausing the session')
store.dispose()
console.log('ok copyover restores variables and JSON script globals without rerunning startup scripts, completed timers or old triggers; live functions block safely')
