/** Explicit Windows installer integration test; never run against the real app identity.
 * Build the isolated WayfarerCopyoverTest / wayfarer-copyover-test installer first.
 * Run: node --experimental-strip-types test/copyover-installer.mts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
assert.equal(process.platform, 'win32', 'Native Windows test only')
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wayfarer-installer-test-'))
const install = path.join(base, 'installed')
const installer = path.resolve('release/copyover-test/copyover-test-installer.exe')
assert.ok(fs.existsSync(installer), 'Build the isolated test installer first')
const run = (exe: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' })
  child.on('error', reject)
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Installer exit ${code}`)))
})
await run(installer, ['/S', `/D=${install}`])
const runtime = path.join(install, 'resources/app.asar.unpacked/out/keeper')
assert.ok(fs.existsSync(path.join(install, 'WayfarerCopyoverTest.exe')))
await build({ entryPoints: ['src/main/KeeperClient.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(base, 'client.cjs') })
const { KeeperClient } = createRequire(import.meta.url)(path.join(base, 'client.cjs'))
let socket: net.Socket, count = 0, closed = 0
const server = net.createServer(s => { socket = s; count++; s.on('data', () => {}); s.on('close', () => closed++) })
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const events: any[] = []
const make = () => new KeeperClient(path.join(base, 'userdata'), path.join(runtime, 'WayfarerConnection.exe'), path.join(runtime, 'keeper.cjs'), 'installer-test', (_id: string, event: any) => events.push(event))
let client = make()
const wait = async (fn: () => boolean) => { const end = Date.now() + 10000; while (!fn()) { assert.ok(Date.now() < end); await new Promise(r => setTimeout(r, 20)) } }
try {
  await client.connect({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port })
  await client.resume(); await wait(() => count === 1)
  await client.pause(); await client.checkpoint({ protocol: 1, snapshot: { preserved: true } })
  client.detach()
  await new Promise(resolve => setTimeout(resolve, 50))
  // The installed copy is demonstrably replaceable while its staged copy runs.
  const exe = path.join(runtime, 'WayfarerConnection.exe')
  assert.ok(path.resolve(exe).startsWith(path.resolve(base) + path.sep))
  fs.renameSync(exe, exe + '.before-update')
  await run(installer, ['/S', `/D=${install}`])
  assert.ok(fs.existsSync(exe), 'Installer replaced the missing installed engine')
  socket!.write('Arrived during installer replacement.\n')
  client = make(); await client.initialize()
  assert.deepEqual(await client.restore(), { protocol: 1, snapshot: { preserved: true } })
  await client.resume()
  await wait(() => events.some(e => e.data === 'Arrived during installer replacement.\n'))
  assert.equal(count, 1); assert.equal(closed, 0)
  await client.shutdown(); await wait(() => closed === 1)
  console.log('ok native NSIS reinstall replaces installed files while staged connection survives and reattaches')
} finally {
  await client.shutdown().catch(() => {})
  socket!?.destroy(); server.close()
  const uninstaller = path.join(install, 'Uninstall WayfarerCopyoverTest.exe')
  if (fs.existsSync(uninstaller)) await run(uninstaller, ['/S', `_?=${install}`])
}
