/** Standalone Node process. Its executable and code live outside the installer tree. */
import net from 'node:net'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { SessionManager } from './SessionManager'
import { COPYOVER_LIMIT, COPYOVER_PROTOCOL } from '../shared/copyover'

const [descriptor, version] = process.argv.slice(2)
if (!descriptor) throw new Error('Missing keeper descriptor')
const token = crypto.randomBytes(32).toString('hex')
let peer: net.Socket | null = null
let paused = true
let checkpoint: unknown = null
let backlog: string[] = []
let bytes = 0
let expiry: ReturnType<typeof setTimeout> | null = null
const write = (socket: net.Socket, value: unknown) => socket.write(JSON.stringify(value) + '\n')
const manager = new SessionManager(() => ({ send(_channel, id, event) {
  const line = JSON.stringify({ event: { id, event } }) + '\n'
  if (peer && !paused) peer.write(line)
  else {
    backlog.push(line)
    bytes += Buffer.byteLength(line)
    if (bytes > COPYOVER_LIMIT) {
      // Retain the output already received, then close instead of silently
      // dropping part of a live session's stream.
      paused = true
      backlog.push(JSON.stringify({ event: { id, event: { type: 'error', message: 'Update buffer filled; connections were closed to avoid silently losing output.' } } }) + '\n')
      manager.destroyAll()
    }
  }
} }), version)
function finish() {
  manager.destroyAll()
  try { fs.unlinkSync(descriptor) } catch {}
  process.exit(0)
}
function armExpiry() {
  if (expiry) clearTimeout(expiry)
  expiry = setTimeout(finish, checkpoint ? 30 * 60_000 : 30_000)
}
const server = net.createServer((socket) => {
  socket.setEncoding('utf8')
  let authenticated = false
  let input = ''
  socket.setTimeout(5000, () => { if (!authenticated) socket.destroy() })
  socket.on('error', () => {})
  socket.on('close', () => {
    if (peer === socket) { peer = null; paused = true; armExpiry() }
  })
  socket.on('data', (chunk) => {
    input += chunk.toString('utf8')
    if (Buffer.byteLength(input) > (authenticated ? COPYOVER_LIMIT * 2 : 4096)) { socket.destroy(); return }
    for (;;) {
      const end = input.indexOf('\n')
      if (end < 0) break
      const line = input.slice(0, end); input = input.slice(end + 1)
      let request: { id: number; method: string; args: any[]; token?: string; protocol?: number }
      try { request = JSON.parse(line) } catch { socket.destroy(); return }
      if (!request || typeof request !== 'object' || !Number.isInteger(request.id) || typeof request.method !== 'string' || !Array.isArray(request.args)) {
        socket.destroy(); return
      }
      try {
        if (!authenticated) {
          if (request.token !== token || request.protocol !== COPYOVER_PROTOCOL || peer) {
            socket.destroy(); return
          }
          authenticated = true; peer = socket
          socket.setTimeout(0)
          if (expiry) clearTimeout(expiry)
          write(socket, { id: request.id, result: true }); continue
        }
        const a = request.args ?? []
        let result: unknown = null
        switch (request.method) {
          case 'connect': result = manager.connect(a[0]); break
          case 'send': manager.send(a[0], a[1]); break
          case 'resize': manager.resize(a[0], a[1], a[2]); break
          case 'disconnect': manager.disconnect(a[0]); break
          case 'reconnect': manager.reconnect(a[0]); break
          case 'list': result = manager.list(); break
          case 'pause': paused = true; break
          case 'checkpoint': checkpoint = a[0]; break
          case 'restore': result = checkpoint; break
          case 'resume':
            // Send response before replay. All replay precedes later live events
            // on this same ordered stream; the renderer is ready at this point.
            write(socket, { id: request.id, result: true })
            for (const buffered of backlog) socket.write(buffered)
            backlog = []; bytes = 0; paused = false; checkpoint = null
            continue
          case 'shutdown': write(socket, { id: request.id, result: true }); finish(); return
          default: throw new Error('Unknown keeper operation')
        }
        write(socket, { id: request.id, result })
      } catch (error) { write(socket, { id: request.id, error: String(error) }) }
    }
  })
})
server.listen(0, '127.0.0.1', () => {
  const port = (server.address() as net.AddressInfo).port
  fs.writeFileSync(descriptor, JSON.stringify({ port, token, protocol: COPYOVER_PROTOCOL }), { mode: 0o600 })
  armExpiry()
})
