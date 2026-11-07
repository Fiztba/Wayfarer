/**
 * Headless checks for agent control's local pipe (src/main/AgentBridge.ts)
 * and its command-line client (scripts/agent.mjs), against a fake renderer
 * that echoes each command and answers a moment later like a MUD.
 *
 * Run with: node --experimental-strip-types test/agent-smoke.mts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AgentBridge } from '../src/main/AgentBridge.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wayfarer-agent-test-'))

/** One request over the pipe, one reply back. */
function ask(pipe: string, body: unknown, raw?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe)
    let buffered = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write((raw ?? JSON.stringify(body)) + '\n'))
    socket.on('data', (chunk: string) => {
      buffered += chunk
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      socket.destroy()
      resolve(JSON.parse(buffered.slice(0, newline)))
    })
    socket.on('error', reject)
  })
}

function cli(args: string[], config: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(root, 'scripts/agent.mjs'), ...args],
      { env: { ...process.env, WAYFARER_AGENT_CONFIG: config }, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({ code, out: stdout, err: stderr })
      }
    )
  })
}

const texts = (reply: any): string[] => reply.lines.map((l: any) => l.text)

try {
  fs.writeFileSync(path.join(base, 'agent.json'), '{"pipe":"gone","token":"stale"}')
  const delivered: Array<[string, string]> = []
  const active: boolean[] = []
  let refuse: string | null = null
  let answerAfterMs = 150
  const answers: Array<ReturnType<typeof setTimeout>> = []
  const bridge: AgentBridge = new AgentBridge(
    base,
    async (id, text) => {
      if (refuse) return { ok: false, error: refuse }
      delivered.push([id, text])
      // What the renderer does synchronously: echo the command, prompt and all.
      bridge.line(id, { kind: 'input', text: `<10hp>${text}` })
      bridge.prompt(id, '')
      answers.push(setTimeout(() => bridge.line(id, { kind: 'output', text: `You ${text}.` }), answerAfterMs))
      answers.push(setTimeout(() => bridge.prompt(id, '<10hp>'), answerAfterMs + 30))
      return { ok: true }
    },
    (on) => active.push(on)
  )
  assert.equal(fs.existsSync(bridge.configPath), false, 'a stale agent.json from a crash is removed')
  assert.equal(bridge.active, false)

  // Nothing listens, and nothing is recorded, until a session opts in.
  bridge.line('s1', { kind: 'output', text: 'before agent control' })
  await bridge.enable('s1', { name: 'Dawn of Demise', character: null })
  const config = JSON.parse(fs.readFileSync(bridge.configPath, 'utf8'))
  assert.equal(typeof config.pipe, 'string')
  assert.match(config.token, /^[0-9a-f]{48}$/)
  assert.deepEqual(active, [true])
  const token = config.token as string
  console.log('ok enabling a session starts the pipe and publishes a fresh token')

  assert.match((await ask(config.pipe, { op: 'sessions' })).error, /token/)
  assert.match((await ask(config.pipe, { token: 'nope', op: 'sessions' })).error, /token/)
  assert.match((await ask(config.pipe, null, 'not json')).error, /JSON/)
  assert.match((await ask(config.pipe, { token, op: 'shutdown' })).error, /Unknown op/)
  assert.match((await ask(config.pipe, { token, op: 'send', text: 'x'.repeat(70_000) })).error, /too large|limited/)
  console.log('ok requests without the token, garbled requests and unknown ops are refused')

  bridge.line('s2', { kind: 'output', text: 'a session that never opted in' })
  const listed = await ask(config.pipe, { token, op: 'sessions' })
  assert.deepEqual(listed.sessions, [{ id: 's1', name: 'Dawn of Demise', character: null }])
  console.log('ok only sessions with agent control on are visible')

  const started = Date.now()
  const look = await ask(config.pipe, { token, op: 'send', text: 'look' })
  assert.equal(look.ok, true)
  assert.deepEqual(delivered, [['s1', 'look']])
  assert.deepEqual(texts(look), ['<10hp>look', 'You look.'], 'the echo alone must not end the wait')
  assert.equal(look.prompt, '<10hp>')
  assert.ok(Date.now() - started >= 150 + 400 - 20, 'a send waits for the answer and then for quiet')
  assert.ok(!texts(look).includes('before agent control'))
  console.log('ok send runs the command, waits for the answer to go quiet, and returns it with the prompt')

  const empty = await ask(config.pipe, { token, op: 'read' })
  assert.deepEqual(empty.lines, [])
  setTimeout(() => bridge.line('s1', { kind: 'output', text: 'A rat arrives from the north.' }), 100)
  const waited = await ask(config.pipe, { token, op: 'read', waitMs: 3000, quietMs: 100 })
  assert.deepEqual(texts(waited), ['A rat arrives from the north.'])
  const peek = await ask(config.pipe, { token, op: 'read', last: 2 })
  assert.deepEqual(texts(peek), ['You look.', 'A rat arrives from the north.'])
  assert.deepEqual((await ask(config.pipe, { token, op: 'read' })).lines, [], 'looking back leaves nothing marked unread')
  console.log('ok read returns only unread text, can wait for more, and can look back')

  bridge.line('s1', { kind: 'output', text: 'The rat bites you!' })
  const kill = await ask(config.pipe, { token, op: 'send', text: 'kill rat' })
  assert.deepEqual(texts(kill), ['The rat bites you!', '<10hp>kill rat', 'You kill rat.'])
  console.log('ok text that arrived between commands comes back with the next send')

  answerAfterMs = 5000
  const slow = await ask(config.pipe, { token, op: 'send', text: 'wait', maxMs: 300 })
  assert.deepEqual(texts(slow), ['<10hp>wait'], 'maxMs bounds a send the game never answers')
  for (const timer of answers.splice(0)) clearTimeout(timer)
  answerAfterMs = 150

  refuse = 'The game is asking for a password. The player types it in Wayfarer.'
  const refused = await ask(config.pipe, { token, op: 'send', text: 'hunter2' })
  assert.deepEqual([refused.ok, refused.error], [false, refuse])
  refuse = null
  assert.match((await ask(config.pipe, { token, op: 'send', text: 'say a\nsay b' })).error, /One command/)
  assert.equal(delivered.length, 3, 'refused and multi-line commands never reach the session')
  console.log('ok the session can refuse a command, and multi-line text never reaches it')

  await bridge.enable('s2', { name: 'The Builder Academy', character: 'Mystra' })
  assert.match((await ask(config.pipe, { token, op: 'send', text: 'look' })).error, /More than one/)
  assert.equal((await ask(config.pipe, { token, op: 'read', session: 'builder' })).session.id, 's2')
  assert.equal((await ask(config.pipe, { token, op: 'read', session: 'mystra' })).session.id, 's2')
  assert.match((await ask(config.pipe, { token, op: 'read', session: 'nowhere' })).error, /No session/)
  await bridge.enable('s1', { name: 'Dawn of Demise', character: 'Wanderer' })
  assert.equal((await ask(config.pipe, { token, op: 'read', session: 'wanderer' })).session.id, 's1')
  console.log('ok with several sessions on, a request names one by world or character')

  const pending = ask(config.pipe, { token, op: 'read', session: 's1', waitMs: 20_000 })
  await new Promise((r) => setTimeout(r, 100))
  const releasedAt = Date.now()
  await bridge.disable('s1')
  await pending
  assert.ok(Date.now() - releasedAt < 2000, 'turning a session off releases a waiting read')
  assert.deepEqual(active, [true], 'still active while another session is on')

  const hanging = new Promise<string>((resolve) => {
    const socket = net.connect(config.pipe)
    socket.on('connect', () => socket.write(JSON.stringify({ token, op: 'read', waitMs: 20_000 }) + '\n'))
    socket.on('close', () => resolve('closed'))
    socket.on('error', () => {})
  })
  await new Promise((r) => setTimeout(r, 100))
  await bridge.disable('s2')
  assert.equal(await hanging, 'closed', 'the last session turning off closes open connections')
  assert.deepEqual(active, [true, false])
  assert.equal(fs.existsSync(bridge.configPath), false, 'agent.json goes away with the pipe')
  await assert.rejects(ask(config.pipe, { token, op: 'sessions' }))
  console.log('ok turning the last session off closes the pipe, its connections and agent.json')

  // The command-line client, against a fresh pipe and token.
  await bridge.enable('s1', { name: 'Dawn of Demise', character: 'Wanderer' })
  const listedCli = await cli(['sessions'], bridge.configPath)
  assert.equal(listedCli.code, 0, listedCli.err)
  assert.match(listedCli.out, /^s1\tDawn of Demise\tWanderer$/m)
  const sent = await cli(['send', 'open', 'door'], bridge.configPath)
  assert.equal(sent.code, 0, sent.err)
  assert.deepEqual(sent.out.trim().split(/\r?\n/), ['<10hp>open door', 'You open door.', '<10hp>'])
  bridge.line('s1', { kind: 'system', text: 'Connected to example.org:4000' })
  bridge.line('s1', { kind: 'trigger', text: 'get all corpse' })
  const read = await cli(['read'], bridge.configPath)
  assert.deepEqual(read.out.trim().split(/\r?\n/), ['--- Connected to example.org:4000 ---', '» get all corpse', '<10hp>'])
  const asJson = JSON.parse((await cli(['read', '--last', '1', '--json'], bridge.configPath)).out)
  assert.deepEqual(asJson.lines, [{ kind: 'trigger', text: 'get all corpse' }])
  refuse = 'Agent control is off for this session.'
  const off = await cli(['send', 'look'], bridge.configPath)
  assert.equal(off.code, 1)
  assert.match(off.err, /Agent control is off/)
  refuse = null
  await bridge.disableAll()
  const gone = await cli(['sessions'], bridge.configPath)
  assert.equal(gone.code, 1)
  assert.match(gone.err, /agent control is off/)
  console.log('ok the command-line client lists, sends, reads, and explains refusals and a closed pipe')
} finally {
  assert.equal(path.dirname(base), path.resolve(os.tmpdir()))
  assert.ok(path.basename(base).startsWith('wayfarer-agent-test-'))
  fs.rmSync(base, { recursive: true, force: true })
}
