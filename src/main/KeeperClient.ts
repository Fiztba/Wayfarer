import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import type { ConnectOptions, SessionEvent } from '../shared/types'
import { COPYOVER_LIMIT, COPYOVER_PROTOCOL } from '../shared/copyover'

export class KeeperClient {
  private socket: net.Socket | null = null
  private starting: Promise<void> | null = null
  private nextId = 1
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private entries = new Map<string, ConnectOptions>()
  private preserving = false
  constructor(private root: string, private executable: string, private script: string,
    private version: string, private emit: (id: string, event: SessionEvent) => void) {}

  hasProfile(id: string): boolean { return [...this.entries.values()].some((opts) => opts.profileId === id) }
  get count(): number { return this.entries.size }
  private get descriptor(): string { return path.join(this.root, 'connection-keeper.json') }

  async initialize(): Promise<void> {
    if (fs.existsSync(this.descriptor)) {
      await this.ensure()
      if (await this.restore()) this.preserving = true
      else if (this.entries.size > 0) {
        // A crashed client without a checkpoint cannot restore these stores.
        // Do not strand invisible sessions when a fresh window is opened.
        await this.shutdown()
        this.socket?.destroy(); this.socket = null
      }
    }
  }
  private async ensure(): Promise<void> {
    if (this.socket) return
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => { this.starting = null })
    return this.starting
  }
  private async start(): Promise<void> {
    if (fs.existsSync(this.descriptor)) {
      try {
        await this.attach()
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw error
        fs.unlinkSync(this.descriptor)
      }
    }
    // Both files are copied outside the install directory. NSIS can replace
    // every installed file while this version of the engine remains alive.
    const code = fs.readFileSync(this.script)
    const binary = fs.readFileSync(this.executable)
    const hash = crypto.createHash('sha256').update(binary).update(code).digest('hex').slice(0, 20)
    const runtime = path.join(this.root, 'connection-runtimes', hash)
    fs.mkdirSync(runtime, { recursive: true })
    const exe = path.join(runtime, process.platform === 'win32' ? 'WayfarerConnection.exe' : 'wayfarer-connection')
    const script = path.join(runtime, 'keeper.cjs')
    if (!fs.existsSync(exe)) fs.writeFileSync(exe, binary, { mode: 0o700 })
    fs.writeFileSync(script, code)
    const license = path.join(path.dirname(this.script), 'node-LICENSE')
    if (fs.existsSync(license)) fs.copyFileSync(license, path.join(runtime, 'node-LICENSE'))
    const child = spawn(exe, [script, this.descriptor, this.version], {
      detached: true, windowsHide: true, stdio: 'ignore', cwd: runtime
    })
    let failure: Error | null = null
    child.on('error', (error) => { failure = error })
    child.unref()
    const deadline = Date.now() + 10_000
    while (!fs.existsSync(this.descriptor)) {
      if (failure) throw failure
      if (Date.now() > deadline) throw new Error('Connection keeper did not start')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await this.attach()
  }
  private async attach(): Promise<void> {
    const descriptor = JSON.parse(fs.readFileSync(this.descriptor, 'utf8'))
    if (descriptor.protocol !== COPYOVER_PROTOCOL || !Number.isInteger(descriptor.port) || typeof descriptor.token !== 'string') {
      throw new Error('The running connection keeper is incompatible with this build. Finish those sessions before changing versions.')
    }
    const socket = net.createConnection({ host: '127.0.0.1', port: descriptor.port })
    socket.setEncoding('utf8')
    let input = ''
    socket.on('error', () => {})
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    this.socket = socket
    socket.on('data', (chunk) => {
      input += chunk
      if (Buffer.byteLength(input) > COPYOVER_LIMIT * 2) { socket.destroy(); return }
      for (;;) {
        const end = input.indexOf('\n')
        if (end < 0) break
        const line = input.slice(0, end); input = input.slice(end + 1)
        let msg: any
        try { msg = JSON.parse(line) } catch { socket.destroy(); return }
        if (!msg || typeof msg !== 'object') { socket.destroy(); return }
        if (msg.event) this.emit(msg.event.id, msg.event.event)
        else {
          const pending = this.pending.get(msg.id)
          if (!pending) continue
          clearTimeout(pending.timer); this.pending.delete(msg.id)
          if (msg.error) pending.reject(new Error(msg.error))
          else pending.resolve(msg.result)
        }
      }
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Connection keeper stopped responding')) }
      this.pending.clear()
      if (!this.preserving) for (const id of this.entries.keys()) this.emit(id, { type: 'disconnected', hadError: true })
    })
    try {
      await this.rpc('hello', [], { token: descriptor.token, protocol: COPYOVER_PROTOCOL })
      const entries = await this.rpc('list') as Array<{ id: string; opts: ConnectOptions }>
      this.entries = new Map(entries.map(({ id, opts }) => [id, opts]))
    } catch (error) { socket.destroy(); throw error }
  }
  private rpc(method: string, args: unknown[] = [], extra = {}): Promise<any> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error('Connection keeper is not attached'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Connection keeper timed out: ${method}`)) }, 15_000)
      this.pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ id, method, args, ...extra }) + '\n')
    })
  }
  async connect(opts: ConnectOptions): Promise<string> {
    await this.ensure()
    await this.pause()
    try {
      const id = await this.rpc('connect', [opts]) as string
      this.entries.set(id, opts)
      return id
    } catch (error) { await this.resume(); throw error }
  }
  /** Renderer has registered its store before the first event is delivered. */
  async resume(): Promise<void> { if (this.socket) await this.rpc('resume'); this.preserving = false }
  async pause(): Promise<void> { if (this.socket) await this.rpc('pause') }
  async checkpoint(value: unknown): Promise<void> { if (this.socket) await this.rpc('checkpoint', [value]) }
  async restore(): Promise<unknown> { return this.socket ? this.rpc('restore') : null }
  async disconnect(id: string): Promise<void> { await this.rpc('disconnect', [id]); this.entries.delete(id) }
  async reconnect(id: string): Promise<void> { await this.rpc('reconnect', [id]) }
  send(id: string, text: string): void { void this.rpc('send', [id, text]).catch((e) => this.emit(id, { type: 'error', message: String(e) })) }
  resize(id: string, cols: number, rows: number): void { void this.rpc('resize', [id, cols, rows]).catch(() => {}) }
  preserve(): void { this.preserving = true }
  get isPreserving(): boolean { return this.preserving }
  async shutdown(): Promise<void> {
    if (this.preserving || !this.socket) return
    await this.rpc('shutdown')
    this.entries.clear()
  }
  detach(): void { this.preserving = true; this.socket?.end(); this.socket = null }
  destroyAll(): void {
    if (this.preserving) return
    if (this.socket) { void this.rpc('shutdown').catch(() => {}); this.socket.unref() }
    this.entries.clear()
  }
}
