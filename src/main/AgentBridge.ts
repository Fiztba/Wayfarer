/**
 * AgentBridge — the local endpoint behind agent control (#agent on).
 *
 * While at least one session has agent control on, the main process listens
 * on a local pipe (a Windows named pipe, a Unix socket elsewhere) and
 * publishes its address and a random token in <userData>/agent.json. A
 * program on this computer that can read that file sends one JSON request
 * per line and gets one JSON reply per line:
 *
 *   {"token":"…","op":"sessions"}
 *   {"token":"…","op":"send","text":"look"}        "session" picks one when several are on
 *   {"token":"…","op":"read","waitMs":5000}        or "last": 50 to look back
 *
 * send runs the command exactly as if the player typed it in that session,
 * waits for the game to answer and go quiet, and returns every line since
 * the agent last read plus the current prompt. Only sessions the player
 * turned agent control on for are visible at all. Nothing here knows about
 * Electron, so the bridge can be exercised in plain Node.
 */
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AgentLine, AgentSendResult, AgentSessionInfo } from '../shared/agent'

/** Runs a command in the session's renderer, as typed input. */
export type AgentDeliver = (sessionId: string, text: string) => Promise<AgentSendResult>

/** Lines kept per session for the agent to read; older ones are dropped. */
const KEEP_LINES = 5000
/** A request longer than this is refused and the connection closed. */
const MAX_REQUEST = 64 * 1024
const MAX_COMMAND = 2000
/** Silence that counts as "the game has finished answering". */
const QUIET_MS = 400
const SEND_MAX_MS = 5000
const MAX_WAIT_MS = 60_000
const KINDS = new Set<AgentLine['kind']>(['output', 'input', 'trigger', 'script', 'system', 'error'])

interface Watched {
  id: string
  info: AgentSessionInfo
  lines: Array<AgentLine & { seq: number }>
  nextSeq: number
  /** Highest seq already handed to the agent. */
  read: number
  prompt: string
  /** Bumped by server activity only: output lines and a new non-empty prompt.
   *  The echo of the command itself must not count, or a send would return
   *  before the game had said anything. */
  activity: number
  changedAt: number
  waiters: Set<() => void>
}

type Reply = { ok: boolean } & Record<string, unknown>

export class AgentBridge {
  /** Where the pipe address and token are published while listening. */
  readonly configPath: string
  private server: net.Server | null = null
  private sockets = new Set<net.Socket>()
  private token = ''
  private sessions = new Map<string, Watched>()
  private reportedActive = false
  private queue: Promise<unknown> = Promise.resolve()
  private readonly dir: string
  private readonly deliver: AgentDeliver
  private readonly onActiveChange: (active: boolean) => void

  constructor(dir: string, deliver: AgentDeliver, onActiveChange: (active: boolean) => void = () => {}) {
    this.dir = dir
    this.deliver = deliver
    this.onActiveChange = onActiveChange
    this.configPath = path.join(dir, 'agent.json')
    // A crash leaves the file behind, pointing at a pipe nobody serves.
    fs.rmSync(this.configPath, { force: true })
  }

  get active(): boolean {
    return this.sessions.size > 0
  }

  /** Turn agent control on for a session, or update how it can be named. */
  enable(id: string, info: AgentSessionInfo): Promise<{ config: string }> {
    return this.serial(async () => {
      const clean = { name: String(info?.name ?? ''), character: info?.character ? String(info.character) : null }
      const existing = this.sessions.get(id)
      if (existing) {
        existing.info = clean
        return { config: this.configPath }
      }
      this.sessions.set(id, {
        id, info: clean, lines: [], nextSeq: 1, read: 0, prompt: '', activity: 0,
        changedAt: Date.now(), waiters: new Set()
      })
      try {
        await this.listen()
      } catch (err) {
        this.sessions.delete(id)
        if (this.sessions.size === 0) await this.shutdown()
        throw err
      }
      this.report(true)
      return { config: this.configPath }
    })
  }

  disable(id: string): Promise<void> {
    return this.serial(async () => {
      const watched = this.sessions.get(id)
      if (!watched) return
      this.sessions.delete(id)
      this.wake(watched)
      if (this.sessions.size === 0) await this.shutdown()
    })
  }

  /** Forget every session and stop listening (window reloaded, app quitting). */
  disableAll(): Promise<void> {
    return this.serial(async () => {
      const all = [...this.sessions.values()]
      this.sessions.clear()
      for (const watched of all) this.wake(watched)
      await this.shutdown()
    })
  }

  /** A completed line of session text (renderer → here). */
  line(id: string, line: AgentLine): void {
    const watched = this.sessions.get(id)
    if (!watched) return
    const kind = KINDS.has(line?.kind) ? line.kind : 'output'
    watched.lines.push({ seq: watched.nextSeq++, kind, text: String(line?.text ?? '') })
    if (watched.lines.length > KEEP_LINES + 500) watched.lines.splice(0, watched.lines.length - KEEP_LINES)
    this.touch(watched, kind !== 'input')
  }

  /** The unfinished last line, usually the game's prompt; '' when there is none. */
  prompt(id: string, text: string): void {
    const watched = this.sessions.get(id)
    if (!watched || watched.prompt === text) return
    watched.prompt = String(text)
    this.touch(watched, watched.prompt !== '')
  }

  // ---- pipe ---------------------------------------------------------------

  private async listen(): Promise<void> {
    if (this.server) return
    const address =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\wayfarer-agent-${crypto.randomBytes(8).toString('hex')}`
        : path.join(this.dir, 'agent.sock')
    if (process.platform !== 'win32') fs.rmSync(address, { force: true })
    this.token = crypto.randomBytes(24).toString('hex')
    const server = net.createServer((socket) => this.serve(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(address, () => {
        server.off('error', reject)
        resolve()
      })
    })
    server.on('error', (err) => console.error(`[agent] ${String(err)}`))
    this.server = server
    if (process.platform !== 'win32') fs.chmodSync(address, 0o600)
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.configPath}.tmp-${process.pid}`
    const config = { version: 1, pipe: address, token: this.token, pid: process.pid }
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.configPath)
  }

  private async shutdown(): Promise<void> {
    this.report(false)
    const server = this.server
    this.server = null
    this.token = ''
    fs.rmSync(this.configPath, { force: true })
    // close() waits for every connection to end, and a long-poll read would
    // hold it open for up to a minute.
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private serve(socket: net.Socket): void {
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => {}) // a client hanging up mid-reply is its own business
    socket.setEncoding('utf8')
    let buffered = ''
    let chain: Promise<void> = Promise.resolve()
    socket.on('data', (chunk: string) => {
      buffered += chunk
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const request = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (request.trim() === '') continue
        chain = chain.then(async () => this.write(socket, await this.handle(request)))
      }
      if (buffered.length > MAX_REQUEST) {
        buffered = ''
        chain = chain.then(() => {
          this.write(socket, { ok: false, error: 'Request too large.' })
          socket.end()
        })
      }
    })
  }

  private write(socket: net.Socket, reply: Reply): void {
    if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(reply) + '\n')
  }

  private async handle(raw: string): Promise<Reply> {
    if (raw.length > MAX_REQUEST) return { ok: false, error: 'Request too large.' }
    let request: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      request = parsed as Record<string, unknown>
    } catch {
      return { ok: false, error: 'Send one JSON object per line.' }
    }
    if (!this.tokenMatches(request.token)) {
      return { ok: false, error: 'Wrong or missing token: read it from agent.json.' }
    }
    try {
      switch (request.op) {
        case 'sessions':
          return { ok: true, sessions: [...this.sessions.values()].map((s) => ({ id: s.id, ...s.info })) }
        case 'send':
          return await this.send(request)
        case 'read':
          return await this.read(request)
        default:
          return { ok: false, error: `Unknown op ${JSON.stringify(request.op)}: use sessions, send or read.` }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private tokenMatches(candidate: unknown): boolean {
    if (typeof candidate !== 'string' || this.token === '') return false
    const given = Buffer.from(candidate)
    const expected = Buffer.from(this.token)
    return given.length === expected.length && crypto.timingSafeEqual(given, expected)
  }

  // ---- ops ----------------------------------------------------------------

  private async send(request: Record<string, unknown>): Promise<Reply> {
    const watched = this.pick(request.session)
    const text = request.text
    if (typeof text !== 'string') throw new Error('send needs "text".')
    if (/[\r\n]/.test(text)) throw new Error('One command per send: stack commands with ; instead of newlines.')
    if (text.length > MAX_COMMAND) throw new Error(`Commands are limited to ${MAX_COMMAND} characters.`)
    const quietMs = clampMs(request.quietMs, QUIET_MS, 10_000)
    const maxMs = clampMs(request.maxMs, SEND_MAX_MS, MAX_WAIT_MS)
    const before = watched.activity
    const result = await this.deliver(watched.id, text)
    if (!result?.ok) throw new Error(result?.error || 'Wayfarer refused the command.')
    await this.settle(watched, () => watched.activity > before, quietMs, maxMs)
    return this.collect(watched)
  }

  private async read(request: Record<string, unknown>): Promise<Reply> {
    const watched = this.pick(request.session)
    if (request.last !== undefined) {
      const wanted = typeof request.last === 'number' && Number.isFinite(request.last) ? Math.floor(request.last) : 50
      return this.reply(watched, watched.lines.slice(-Math.max(1, Math.min(KEEP_LINES, wanted))))
    }
    const waitMs = clampMs(request.waitMs, 0, MAX_WAIT_MS)
    if (waitMs > 0 && watched.nextSeq - 1 <= watched.read) {
      const before = watched.activity
      await this.settle(watched, () => watched.activity > before, clampMs(request.quietMs, QUIET_MS, 10_000), waitMs)
    }
    return this.collect(watched)
  }

  private pick(ref: unknown): Watched {
    const all = [...this.sessions.values()]
    if (ref === undefined || ref === null || ref === '') {
      if (all.length === 1) return all[0]
      throw new Error(
        all.length === 0
          ? 'No session has agent control on. Type #agent on in the session you want driven.'
          : 'More than one session has agent control on: name one with "session".'
      )
    }
    if (typeof ref !== 'string') throw new Error('"session" must be a string.')
    const exact = this.sessions.get(ref)
    if (exact) return exact
    const want = ref.toLowerCase()
    const hits = all.filter(
      (s) => s.info.name.toLowerCase().includes(want) || (s.info.character ?? '').toLowerCase().includes(want)
    )
    if (hits.length === 1) return hits[0]
    throw new Error(
      hits.length > 1 ? `"${ref}" matches more than one session.` : `No session with agent control on matches "${ref}".`
    )
  }

  /** Every line the agent has not seen yet; marks them seen. */
  private collect(watched: Watched): Reply {
    const oldest = watched.lines.length > 0 ? watched.lines[0].seq : watched.nextSeq
    const missed = Math.max(0, oldest - (watched.read + 1))
    const fresh = watched.lines.filter((l) => l.seq > watched.read)
    watched.read = watched.nextSeq - 1
    return this.reply(watched, fresh, missed)
  }

  private reply(watched: Watched, lines: Array<AgentLine & { seq: number }>, missed = 0): Reply {
    return {
      ok: true,
      session: { id: watched.id, ...watched.info },
      lines: lines.map(({ kind, text }) => ({ kind, text })),
      prompt: watched.prompt,
      ...(missed > 0 ? { missed } : {})
    }
  }

  /** Resolve once ready() holds and the session has been quiet for quietMs, or at maxMs. */
  private settle(watched: Watched, ready: () => boolean, quietMs: number, maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (): void => {
        if (timer) clearTimeout(timer)
        watched.waiters.delete(check)
        resolve()
      }
      const check = (): void => {
        if (timer) clearTimeout(timer)
        timer = null
        const now = Date.now()
        if (this.sessions.get(watched.id) !== watched || now >= deadline) return finish()
        if (!ready()) {
          timer = setTimeout(check, deadline - now)
          return
        }
        const quietLeft = watched.changedAt + quietMs - now
        if (quietLeft <= 0) return finish()
        timer = setTimeout(check, Math.min(quietLeft, deadline - now))
      }
      watched.waiters.add(check)
      check()
    })
  }

  private touch(watched: Watched, activity: boolean): void {
    watched.changedAt = Date.now()
    if (activity) watched.activity++
    this.wake(watched)
  }

  private wake(watched: Watched): void {
    for (const waiter of [...watched.waiters]) waiter()
  }

  private report(active: boolean): void {
    if (this.reportedActive === active) return
    this.reportedActive = active
    this.onActiveChange(active)
  }

  /** enable/disable each await the pipe; one at a time keeps them from racing. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => {})
    return next
  }
}

function clampMs(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(max, Math.floor(value)))
}
