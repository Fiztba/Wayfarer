/** Real main-process IPC, sockets and window ownership; no external servers. */
const electron = require('electron')
const { app, BrowserWindow } = electron
const Module = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const assert = require('node:assert/strict')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wayfarer-main-test-'))
app.setPath('userData', userData)
fs.writeFileSync(path.join(userData, 'mud-directory-cache.json'), JSON.stringify({
  fetchedAt: new Date().toISOString(), snapshot: { muds: [], counts: {}, builtAt: new Date().toISOString() }
}))
app.disableHardwareAcceleration()
// Exercise the built main entry with hidden windows and its real preload.
const load = Module._load
Module._load = function (name, ...args) {
  if (name === 'electron') return { ...electron, BrowserWindow: class extends BrowserWindow {
    constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } }) }
  } }
  return load.call(this, name, ...args)
}
let quitRequests = 0
app.quit = () => { quitRequests++ }
const sockets = new Set()
const server = net.createServer((socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('data', () => {})
})
const deadline = setTimeout(() => { console.error('main lifecycle timed out'); app.exit(1) }, 30000)
const waitFor = async (test) => {
  const until = Date.now() + 5000
  while (!await test()) {
    assert.ok(Date.now() < until, 'Timed out waiting for main-process state')
    await new Promise((r) => setTimeout(r, 20))
  }
}
;(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  require('../out/main/index.js')
  await app.whenReady()
  await waitFor(() => BrowserWindow.getAllWindows().length === 1)
  const main = BrowserWindow.getAllWindows()[0]
  await waitFor(() => !main.webContents.isLoading())
  const call = (script) => main.webContents.executeJavaScript(script)
  await assert.rejects(call(`window.mud.profiles.save({host:'localhost',port:99999})`), /Port must/)
  await assert.rejects(call(`window.mud.profiles.save({host:'localhost',port:1.5})`), /Port must/)
  await assert.rejects(call(`window.mud.profiles.save({host:'',port:4000})`), /host name/)
  assert.deepEqual(await call('window.mud.profiles.list()'), [])
  console.log('ok invalid profiles are rejected without writing files')
  const opts = JSON.stringify({ host: '127.0.0.1', port: server.address().port })
  const id = await call(`window.mud.connect(${opts})`)
  await waitFor(() => sockets.size === 1)
  await call(`window.mud.map.popout(${JSON.stringify(id)}, 'Test')`)
  await waitFor(() => BrowserWindow.getAllWindows().length === 2)
  await call(`window.mud.disconnect(${JSON.stringify(id)})`)
  await waitFor(() => sockets.size === 0 && BrowserWindow.getAllWindows().length === 1)
  console.log('ok closing a session closes its TCP socket and map window')
  await call(`window.mud.map.popout('shutdown-test', 'Test')`)
  await waitFor(() => BrowserWindow.getAllWindows().length === 2)
  main.destroy()
  assert.ok(quitRequests > 0, 'Closing the main window must request app quit even with a map open')
  console.log('ok closing the main window requests quit with popouts open')
  for (const win of BrowserWindow.getAllWindows()) win.destroy()
  server.close()
  clearTimeout(deadline)
  app.exit(0)
})().catch((err) => { console.error(err); clearTimeout(deadline); app.exit(1) })
