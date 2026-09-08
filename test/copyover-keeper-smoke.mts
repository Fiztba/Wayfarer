/** Real TLS socket and authentication across keeper client lifetimes. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import net from 'node:net'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wayfarer-keeper-test-'))
await build({ entryPoints: ['src/main/KeeperClient.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(base, 'client.cjs') })
await build({ entryPoints: ['src/main/keeper.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(base, 'keeper.cjs') })
const { KeeperClient } = createRequire(import.meta.url)(path.join(base, 'client.cjs'))
const cert = path.resolve('test/fixtures/copyover-test-cert.pem')
// Only this fixture's child runtime trusts this test-only self-signed CA.
const previousCA = process.env.NODE_EXTRA_CA_CERTS
process.env.NODE_EXTRA_CA_CERTS = cert
let count = 0, closed = 0, socket: tls.TLSSocket
const server = tls.createServer({ key: fs.readFileSync('test/fixtures/copyover-test-key.pem'), cert: fs.readFileSync(cert) }, (s) => {
  count++; socket = s
  s.on('close', () => closed++)
  s.on('data', () => {})
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const wait = async (fn: () => boolean) => { const end = Date.now() + 5000; while (!fn()) { assert.ok(Date.now() < end, 'Timed out'); await new Promise(r => setTimeout(r, 10)) } }
const events: any[] = []
const client = () => new KeeperClient(base, process.execPath, path.join(base, 'keeper.cjs'), 'test', (id: string, event: any) => events.push({ id, event }))
let active = client()
try {
  const id = await active.connect({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, tls: true })
  await active.resume()
  await wait(() => count === 1)
  socket!.write('before\n')
  await wait(() => events.some(e => e.event.data === 'before\n'))
  const descriptor = JSON.parse(fs.readFileSync(path.join(base, 'connection-keeper.json'), 'utf8'))
  const intruder = net.connect(descriptor.port, '127.0.0.1')
  intruder.on('error', () => {})
  await new Promise<void>(resolve => { intruder.on('close', resolve); intruder.write(JSON.stringify({ id: 1, method: 'hello', args: [], token: 'wrong', protocol: 1 }) + '\n') })
  const malformed = net.connect(descriptor.port, '127.0.0.1')
  malformed.on('error', () => {})
  await new Promise<void>(resolve => { malformed.on('close', resolve); malformed.write('null\n') })
  await active.pause()
  await active.checkpoint({ protocol: 1, snapshot: { test: 'saved' } })
  active.detach()
  await new Promise(r => setTimeout(r, 50))
  socket!.write('during café\n')
  active = client()
  await active.initialize()
  assert.deepEqual(await active.restore(), { protocol: 1, snapshot: { test: 'saved' } })
  const before = events.length
  await active.resume()
  await wait(() => events.length > before)
  assert.equal(events.filter(e => e.event.data === 'during café\n').length, 1)
  assert.equal(count, 1)
  assert.equal(closed, 0)
  await active.shutdown()
  await wait(() => closed === 1)
  console.log('ok authenticated keeper retains one verified TLS session and replays UTF-8 output once')
  await new Promise(r => setTimeout(r, 50))
  active = client()
  await active.connect({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, tls: true })
  await wait(() => count === 2)
  active.detach()
  await new Promise(r => setTimeout(r, 50))
  active = client()
  await active.initialize()
  await wait(() => closed === 2)
  assert.equal(await active.restore(), null)
  assert.equal(active.count, 0)
  console.log('ok an abandoned session without a checkpoint is closed instead of stranded invisibly')
} finally {
  await active.shutdown().catch(() => {})
  socket!?.destroy(); server.close()
  if (previousCA === undefined) delete process.env.NODE_EXTRA_CA_CERTS
  else process.env.NODE_EXTRA_CA_CERTS = previousCA
}
