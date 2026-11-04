/**
 * A command's reply glued onto a prompt. Merc-family MUDs (Merc, ROM, SMAUG)
 * start a reply to the player's own command with no line break; when another
 * prompt went out while the command waited its turn, the reply lands on it.
 * Seen live on Dawn of Demise, which never sends GA/EOR:
 *   <379/379hp 208/308mana 470/470mv 1212969 TNL (E) $906>(OOC) You chat, "…"
 * The race is replayed over a real socket, through SessionManager and
 * TelnetSocket into a SessionStore: a ^-anchored trigger must match the reply
 * and its capture copy must carry no prompt.
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const built = await build({
  stdin: {
    contents: `export {SessionStore} from './src/renderer/src/SessionStore'; export {settingsManager} from './src/renderer/src/SettingsManager'; export {defaultSettings} from './src/shared/types'; export {SessionManager} from './src/main/SessionManager'; export {TelnetSocket} from './src/main/telnet/TelnetSocket';`,
    resolveDir: process.cwd()
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  plugins: [{ name: 'wasm-url', setup(b) { b.onResolve({ filter: /glue\.wasm\?url$/ }, () => ({ path: 'wasm', namespace: 'test' })); b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export default ""' })) } }]
})
let settings: any
let toServer: (text: string) => void = () => {}
;(globalThis as any).requestAnimationFrame = () => 0
;(globalThis as any).window = { addEventListener() {}, mud: {
  send: (_id: string, text: string) => toServer(text),
  settings: { get: async () => settings, save: async (_id: unknown, value: any) => (settings = value) },
  map: { load: async () => null, save() {}, persist: async () => {}, pushState() {} },
  log: { start: async () => 'test.log', stop: async () => {}, line() {} }
} }
const mod = { exports: {} as any }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports)
const { SessionStore, settingsManager, defaultSettings, SessionManager, TelnetSocket } = mod.exports

settings = defaultSettings()
settings.triggers = [{ id: 'ooc', label: 'OOC → capture window', enabled: true, pattern: '^\\(OOC\\) ',
  matchType: 'regex', caseInsensitive: false, commands: '', gag: false, highlight: '', captureWindow: 'OOC' }]
await settingsManager.ensure(null)

const PROMPT = '<379/379hp 208/308mana 470/470mv 1212969 TNL (E) $906>'
const COMMAND = "ooc So what's the end goal..."
const REPLY = `(OOC) You chat, "So what's the end goal..."`
const GA = Buffer.from([255, 249])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const text = (line: { spans: { text: string }[] }) => line.spans.map((s) => s.text).join('')
async function waitFor(what: string, ok: () => boolean): Promise<void> {
  for (const end = Date.now() + 5000; !ok(); await sleep(10)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
  }
}

/**
 * The MUD's side of the race. The player's command arrives just too late for
 * this pulse, so the pulse's output — another player's gossip (opened with a
 * line break: no command of the player's is running) and a fresh prompt — goes
 * out first. Next pulse the command runs, and its reply opens with no break.
 */
async function mercServer(ga: boolean): Promise<net.Server> {
  const prompt = Buffer.concat([Buffer.from(PROMPT), ga ? GA : Buffer.alloc(0)])
  const server = net.createServer((socket) => {
    socket.write(Buffer.concat([Buffer.from('\n\r'), prompt]))
    socket.once('data', () => {
      const pulse = Buffer.concat([Buffer.from("\n\rKara gossips, 'anyone around?'\n\r\n\r"), prompt])
      const reply = Buffer.concat([Buffer.from(`${REPLY}\n\r\n\r`), prompt])
      // With GA the boundary is explicit, so even one packet must split.
      if (ga) socket.write(Buffer.concat([pulse, reply]))
      else {
        socket.write(pulse)
        setTimeout(() => socket.write(reply), 400) // a pulse or more later
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return server
}

async function playRace(ga: boolean) {
  const server = await mercServer(ga)
  const port = (server.address() as net.AddressInfo).port
  const store = new SessionStore('race', 'Dawn of Demise', '127.0.0.1', port)
  await store.ready
  const manager = new SessionManager(() => ({ send: (_channel: string, _id: string, event: any) => store.handleEvent(event) }))
  const id = manager.connect({ host: '127.0.0.1', port })
  toServer = (line) => manager.send(id, line)
  await waitFor('the first prompt', () => text({ spans: store.openSpans }) === PROMPT)
  store.sendInput(COMMAND, false)
  await waitFor('the reply', () => store.lines.some((l: any) => text(l).includes('(OOC)')))
  const result = { lines: store.lines.map((l: any) => ({ kind: l.kind, text: text(l) })),
    capture: (store.captureWindows.get('OOC') ?? []).map(text) }
  manager.destroyAll()
  store.dispose()
  await new Promise((r) => server.close(r))
  return result
}

for (const ga of [false, true]) {
  const how = ga ? 'with GA' : 'without GA/EOR'
  const { lines, capture } = await playRace(ga)
  assert.deepEqual(capture, [REPLY], `${how}: the ^(OOC) trigger fired on the reply, captured without the prompt`)
  const at = lines.findIndex((l) => l.text === REPLY)
  assert.deepEqual(lines[at - 1], { kind: 'output', text: PROMPT }, `${how}: the prompt ends its own line`)
  assert.ok(!lines.some((l) => l.text.includes(PROMPT + '(OOC)')), `${how}: nothing glued`)
  assert.ok(lines.some((l) => l.kind === 'input' && l.text === PROMPT + COMMAND), `${how}: the echo still joins the prompt`)
}
console.log('ok a reply glued onto a prompt starts its own line: ^ triggers match it and its capture copy has no prompt')

// ---- the keeper only infers a prompt from a real pause after a partial line ----
{
  const run = async (...steps: (string | number[] | number)[]) => {
    const t = new TelnetSocket({ host: 'localhost', port: 4000 })
    const events: unknown[][] = []
    t.on('text', (data: string) => events.push(['text', data]))
    t.on('prompt', (...args: unknown[]) => events.push(['prompt', ...args]))
    for (const step of steps) {
      if (typeof step === 'number') await sleep(step)
      else (t as any).parse(typeof step === 'string' ? Buffer.from(step) : Buffer.from(step))
    }
    return events
  }
  assert.deepEqual(await run(PROMPT, 200, REPLY), [['text', PROMPT], ['prompt', true], ['text', REPLY]])
  assert.deepEqual(await run('A long line, split ', 'mid-burst.\r\n'), [['text', 'A long line, split '], ['text', 'mid-burst.\r\n']],
    'no pause, no prompt')
  assert.deepEqual(await run('Whole line.\r\n', 200, 'Next.'), [['text', 'Whole line.\r\n'], ['text', 'Next.']],
    'nothing was left open')
  assert.deepEqual(await run(PROMPT, 200, '\n\rA tell.'), [['text', PROMPT], ['text', '\n\rA tell.']],
    'text that starts its own line needs no prompt')
  assert.deepEqual(await run(PROMPT, [255, 249], 'Ok.\n\r' + PROMPT, 200, REPLY),
    [['text', PROMPT], ['prompt'], ['text', 'Ok.\n\r' + PROMPT], ['text', REPLY]],
    'a server that marks prompts itself is never second-guessed')
}
console.log('ok the keeper infers a prompt only from a pause after a partial line, and never on a server that sends GA/EOR')

// ---- the renderer only acts on prompt-shaped inferred prompts ----
{
  const store = new SessionStore('shape', 'Test', 'localhost', 4000)
  await store.ready
  const lines = () => store.lines.map((l: any) => text(l))
  store.handleEvent({ type: 'text', data: 'Saving....' })
  store.handleEvent({ type: 'prompt', inferred: true })
  store.handleEvent({ type: 'text', data: ' done.\n\r' })
  assert.deepEqual(lines(), ['Saving.... done.'], 'a pause after prose is a slow server, not a prompt')

  store.handleEvent({ type: 'text', data: PROMPT })
  store.handleEvent({ type: 'prompt' })
  store.handleEvent({ type: 'text', data: "\n\rKara gossips, 'hi'\n\r" })
  assert.deepEqual(lines().slice(1), [PROMPT, "Kara gossips, 'hi'"], 'a line break after a prompt adds no blank line')

  store.handleEvent({ type: 'text', data: PROMPT })
  store.handleEvent({ type: 'prompt' })
  store.sendInput('look', false)
  store.handleEvent({ type: 'text', data: 'A dark room.\n\r' })
  assert.deepEqual(lines().slice(3), [PROMPT + 'look', 'A dark room.'], 'typing on a prompt still echoes cMUD-style')
  store.dispose()
}
console.log('ok inferred prompts must look like prompts; GA prompts add no blank lines and keep the cMUD-style echo')
