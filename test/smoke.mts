/**
 * Headless smoke test for the telnet engine. Connects to a real MUD, watches
 * negotiation, collects a few seconds of output, and reports what happened.
 *
 * Run with: node --experimental-strip-types test/smoke.mts <host> <port>
 */
import { TelnetSocket } from '../src/main/telnet/TelnetSocket.ts'

const host = process.argv[2] ?? 'tbamud.com'
const port = Number(process.argv[3] ?? 9091)
const seconds = Number(process.argv[4] ?? 6)

const t = new TelnetSocket({ host, port })
let textBytes = 0
let firstText = ''
let prompts = 0

t.on('connect', () => console.log(`[smoke] connected to ${host}:${port}`))
t.on('text', (data) => {
  textBytes += data.length
  if (firstText.length < 600) firstText += data
})
t.on('prompt', () => prompts++)
t.on('echo', (on) => console.log(`[smoke] server echo (mask input): ${on}`))
t.on('mxpEnabled', () => console.log('[smoke] MXP negotiated'))
t.on('mspEnabled', () => console.log('[smoke] MSP negotiated'))
t.on('compression', (on) => console.log(`[smoke] MCCP2 compression: ${on}`))
t.on('gmcpEnabled', () => {
  console.log('[smoke] GMCP negotiated')
  t.sendGmcp('Core.Hello', { client: 'Wayfarer', version: '0.1.0' })
  t.sendGmcp('Core.Supports.Set', ['Char 1', 'Room 1', 'Comm.Channel 1'])
})
t.on('gmcp', (pkg, data) => console.log(`[smoke] GMCP < ${pkg} ${JSON.stringify(data)?.slice(0, 120)}`))
t.on('mssp', (data) => console.log(`[smoke] MSSP:`, JSON.stringify(data).slice(0, 300)))
t.on('error', (msg) => console.log(`[smoke] error: ${msg}`))
t.on('close', () => {
  console.log('[smoke] closed by server')
  finish()
})

let finished = false
function finish(): void {
  if (finished) return
  finished = true
  t.destroy()
  console.log('---')
  console.log(`[smoke] received ${textBytes} chars of text, ${prompts} prompt marks`)
  console.log('[smoke] first output (ANSI stripped):')
  console.log(
    firstText
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .split('\n')
      .slice(0, 12)
      .join('\n')
  )
  process.exit(textBytes > 0 ? 0 : 1)
}

t.connect()
setTimeout(finish, seconds * 1000)
