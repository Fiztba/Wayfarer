#!/usr/bin/env node
// Command-line client for Wayfarer's agent control. Type #agent on in the
// session to drive, then:
//
//   node scripts/agent.mjs sessions
//   node scripts/agent.mjs send [options] <command...>
//   node scripts/agent.mjs read [options]
//
// The protocol is described in src/main/AgentBridge.ts and in the
// "Agent Control" help topic.
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const USAGE = `Usage:
  node scripts/agent.mjs sessions
  node scripts/agent.mjs send [options] <command...>   run a command, print what the game says
  node scripts/agent.mjs read [options]                print text that arrived since the last read

Options:
  --session <name>  which session (needed when more than one has agent control on)
  --quiet <ms>      silence that counts as the game being done (default 400)
  --max <ms>        send: longest to wait for the game (default 5000)
  --wait <ms>       read: wait up to this long for new text
  --last <n>        read: show the last n lines instead of unread ones
  --json            print Wayfarer's reply as JSON
  --config <file>   agent.json to use (default: Wayfarer's data folder, or $WAYFARER_AGENT_CONFIG)`

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function parseArgs(argv) {
  const opts = {}
  const words = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      words.push(...argv.slice(i + 1))
      break
    }
    if (!arg.startsWith('--')) {
      words.push(arg)
      continue
    }
    const key = arg.slice(2)
    if (key === 'json' || key === 'help') {
      opts[key] = true
      continue
    }
    if (!['session', 'quiet', 'max', 'wait', 'last', 'config'].includes(key)) fail(`Unknown option --${key}\n\n${USAGE}`, 2)
    const value = argv[++i]
    if (value === undefined) fail(`--${key} needs a value`, 2)
    opts[key] = value
  }
  return { opts, words }
}

function number(opts, key) {
  if (opts[key] === undefined) return undefined
  const value = Number(opts[key])
  if (!Number.isFinite(value) || value < 0) fail(`--${key} must be a number`, 2)
  return value
}

function configPath(opts) {
  if (opts.config) return opts.config
  if (process.env.WAYFARER_AGENT_CONFIG) return process.env.WAYFARER_AGENT_CONFIG
  const home = os.homedir()
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  return path.join(base, 'Wayfarer', 'agent.json')
}

function readConfig(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    fail(`No ${file}: agent control is off. Type #agent on in the session Wayfarer should hand over.`)
  }
  try {
    const config = JSON.parse(text)
    if (typeof config.pipe !== 'string' || typeof config.token !== 'string') throw new Error('incomplete')
    return config
  } catch {
    fail(`${file} is not a Wayfarer agent config.`)
  }
}

function request(config, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(config.pipe)
    let buffered = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new Error('Wayfarer did not answer in time.')), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify({ token: config.token, ...body }) + '\n'))
    socket.on('data', (chunk) => {
      buffered += chunk
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      try {
        finish(resolve, JSON.parse(buffered.slice(0, newline)))
      } catch {
        finish(reject, new Error('Wayfarer sent a reply that is not JSON.'))
      }
    })
    socket.on('error', (err) => {
      const gone = err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
      finish(reject, gone ? new Error('Wayfarer is not listening: is it running, with #agent on?') : err)
    })
    socket.on('close', () => finish(reject, new Error('Wayfarer closed the connection without answering.')))
  })
}

function printLines(reply) {
  if (reply.missed) console.log(`(${reply.missed} older lines were dropped before they were read)`)
  for (const line of reply.lines ?? []) {
    if (line.kind === 'trigger') console.log(`» ${line.text}`)
    else if (line.kind === 'system') console.log(`--- ${line.text} ---`)
    else if (line.kind === 'error') console.log(`!!! ${line.text}`)
    else console.log(line.text)
  }
  if (reply.prompt) console.log(reply.prompt)
}

async function main() {
  const [op, ...rest] = process.argv.slice(2)
  const { opts, words } = parseArgs(rest)
  if (!op || opts.help || op === 'help' || op === '--help') {
    console.log(USAGE)
    return
  }
  const config = readConfig(configPath(opts))
  const quietMs = number(opts, 'quiet')
  const common = { ...(opts.session ? { session: opts.session } : {}), ...(quietMs !== undefined ? { quietMs } : {}) }
  let reply
  if (op === 'sessions') {
    reply = await request(config, { op: 'sessions' }, 5000)
  } else if (op === 'send') {
    if (words.length === 0) fail('send needs a command, e.g. node scripts/agent.mjs send look', 2)
    const maxMs = number(opts, 'max')
    reply = await request(
      config,
      { op: 'send', text: words.join(' '), ...common, ...(maxMs !== undefined ? { maxMs } : {}) },
      (maxMs ?? 5000) + 8000
    )
  } else if (op === 'read') {
    const waitMs = number(opts, 'wait')
    const last = number(opts, 'last')
    reply = await request(
      config,
      { op: 'read', ...common, ...(waitMs !== undefined ? { waitMs } : {}), ...(last !== undefined ? { last } : {}) },
      (waitMs ?? 0) + (quietMs ?? 400) + 5000
    )
  } else {
    fail(`Unknown command "${op}".\n\n${USAGE}`, 2)
  }
  if (opts.json) console.log(JSON.stringify(reply, null, 2))
  else if (!reply.ok) fail(reply.error ?? 'Wayfarer refused the request.')
  else if (op === 'sessions') {
    if (reply.sessions.length === 0) console.log('No session has agent control on.')
    for (const s of reply.sessions) console.log(`${s.id}\t${s.name}${s.character ? `\t${s.character}` : ''}`)
  } else printLines(reply)
  if (!reply.ok) process.exitCode = 1
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
