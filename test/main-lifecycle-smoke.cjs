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
let serverInput = ''
const server = net.createServer((socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('data', (data) => { serverInput += data.toString('latin1') })
})
const deadline = setTimeout(() => { console.error('main lifecycle timed out'); app.exit(1) }, 40000)
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
  assert.match(await call('window.mud.checkForUpdate()'), /installed builds/)
  const packaged = Object.getOwnPropertyDescriptor(app, 'isPackaged')
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
  const updater = require('electron-updater').autoUpdater
  updater.checkForUpdates = async () => { throw new Error('offline test') }
  assert.match(await call('window.mud.checkForUpdate()'), /offline test/)
  updater.checkForUpdates = async () => ({ updateInfo: { version: app.getVersion() } })
  assert.match(await call('window.mud.checkForUpdate()'), /up to date/)
  let checks = 0, finish
  updater.checkForUpdates = async () => {
    checks++
    return { updateInfo: { version: '99.0.0' }, downloadPromise: new Promise((resolve) => { finish = resolve }) }
  }
  const checking = call('Promise.all([window.mud.checkForUpdate(), window.mud.checkForUpdate()])')
  await waitFor(() => !!finish)
  finish([])
  assert.deepEqual(await checking, ['Version 99.0.0 is ready to install.', 'Version 99.0.0 is ready to install.'])
  assert.equal(checks, 1)
  assert.equal(await call('window.mud.updateState()'), '99.0.0')
  assert.equal(quitRequests, 0, 'checking must not restart a live session')
  if (packaged) Object.defineProperty(app, 'isPackaged', packaged)
  else delete app.isPackaged
  console.log('ok manual update IPC handles failure, current version, shared download and ready state without restarting')
  await assert.rejects(call(`window.mud.profiles.save({host:'localhost',port:99999})`), /Port must/)
  await assert.rejects(call(`window.mud.profiles.save({host:'localhost',port:1.5})`), /Port must/)
  await assert.rejects(call(`window.mud.profiles.save({host:'',port:4000})`), /host name/)
  assert.deepEqual(await call('window.mud.profiles.list()'), [])
  console.log('ok invalid profiles are rejected without writing files')
  const opts = JSON.stringify({ host: '127.0.0.1', port: server.address().port })
  const id = await call(`window.mud.connect(${opts})`)
  await waitFor(() => sockets.size === 1)
  // Agent control through the real main process: token file, pipe, the round
  // trip to the renderer, and cleanup on reload and on disconnect.
  const agentJson = path.join(userData, 'agent.json')
  const ask = (body) => new Promise((resolve, reject) => {
    const { pipe, token } = JSON.parse(fs.readFileSync(agentJson, 'utf8'))
    const socket = net.connect(pipe)
    let buffered = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify({ token, ...body }) + '\n'))
    socket.on('data', (chunk) => {
      buffered += chunk
      const newline = buffered.indexOf('\n')
      if (newline >= 0) { socket.destroy(); resolve(JSON.parse(buffered.slice(0, newline))) }
    })
    socket.on('error', reject)
  })
  const enableAgent = () => call(`window.mud.agent.enable(${JSON.stringify(id)}, { name: 'Test', character: null })`)
  assert.equal(fs.existsSync(agentJson), false)
  await enableAgent()
  assert.deepEqual((await ask({ op: 'sessions' })).sessions, [{ id, name: 'Test', character: null }])
  await call(`window.mud.agent.line(${JSON.stringify(id)}, { kind: 'output', text: 'hello from the renderer' })`)
  await waitFor(async () => (await ask({ op: 'read', last: 1 })).lines[0]?.text === 'hello from the renderer')
  // Opened without a tab, this session has no store in the renderer, so the
  // round trip comes back refused instead of typed.
  assert.match((await ask({ op: 'send', text: 'look' })).error, /gone/)
  console.log('ok agent control crosses the real main process: token file, pipe and renderer round trip')
  main.webContents.reload()
  await waitFor(() => !fs.existsSync(agentJson))
  await waitFor(() => !main.webContents.isLoading())
  if (typeof main.webContents.getBackgroundThrottling === 'function') {
    assert.equal(main.webContents.getBackgroundThrottling(), true, 'throttling comes back once no session has agent control')
  }
  await enableAgent()
  assert.ok(fs.existsSync(agentJson))
  console.log('ok reloading the window drops agent control')
  await call(`window.mud.map.popout(${JSON.stringify(id)}, 'Test')`)
  await waitFor(() => BrowserWindow.getAllWindows().length === 2)
  await call(`window.mud.disconnect(${JSON.stringify(id)})`)
  await waitFor(() => sockets.size === 0 && BrowserWindow.getAllWindows().length === 1)
  assert.equal(fs.existsSync(agentJson), false, 'disconnecting turns agent control off')
  console.log('ok closing a session closes its TCP socket, map window and agent control')

  // ---- A session tab moves to a window of its own and back, through the
  // real UI, keeper and sockets.
  const port = server.address().port
  const profile = await call(`window.mud.profiles.save({ name: 'Local MUD', host: '127.0.0.1', port: ${port}, tls: false, encoding: 'utf8' })`)
  main.webContents.reload()
  await waitFor(() => !main.webContents.isLoading())
  await waitFor(() => call(`!!document.querySelector('.profile-card')`))
  await call(`document.querySelector('.profile-card').click()`)
  await waitFor(() => sockets.size === 1)
  const mud = [...sockets][0]
  const textIn = (win, text) => win.webContents.executeJavaScript(`!!document.querySelector('.output')?.textContent.includes(${JSON.stringify(text)})`)
  mud.write('Welcome to the test MUD.\r\n')
  await waitFor(() => textIn(main, 'Welcome to the test MUD.'))
  const sessionId = await call(`document.querySelector('.tab[data-session]').dataset.session`)
  assert.deepEqual(await call(`window.mud.windows.move(${JSON.stringify(sessionId)}, 'new')`), { ok: true })
  assert.equal(BrowserWindow.getAllWindows().length, 2)
  const detached = BrowserWindow.getAllWindows().find((w) => w !== main)
  await waitFor(() => textIn(detached, 'Welcome to the test MUD.'))
  assert.equal(await call(`!!document.querySelector('.output')`), false, 'the main window let go of the session')
  mud.write('This line arrives after the move.\r\n')
  await waitFor(() => textIn(detached, 'This line arrives after the move.'))
  await detached.webContents.executeJavaScript(`{ const el = document.querySelector('.command-input');
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, 'look');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), 30) }`)
  await waitFor(() => serverInput.includes('look\r\n'))
  console.log('ok a tab moves to a new window with its scrollback; output and typing follow it')

  await call(`document.querySelector('.profile-card').click()`)
  await waitFor(() => call(`document.body.textContent.includes('already open in another window')`))
  assert.equal(sockets.size, 1, 'a world open in one window is not opened in another')
  const settings = await call('window.mud.settings.get(null)')
  settings.triggers.push({ id: 'ping', label: 'Ping', pattern: 'ping from the server', matchType: 'substring',
    caseInsensitive: false, commands: 'say pong', gag: false, highlight: '', enabled: true })
  await call(`window.mud.settings.save(null, ${JSON.stringify(settings)})`)
  await new Promise((r) => setTimeout(r, 100))
  mud.write('ping from the server\r\n')
  await waitFor(() => serverInput.includes('say pong\r\n'))
  console.log('ok a world stays in one window, and settings saved in one window reach the others')

  // A different world (its own profile, so its own map) connected from the
  // detached window lives there from its very first line.
  const otherWorld = await call(`window.mud.profiles.save({ name: 'Second World', host: '127.0.0.1', port: ${port}, tls: false, encoding: 'utf8' })`)
  assert.notEqual(otherWorld.id, profile.id, 'a new name for the same MUD is a second profile, with its own map')
  const inDetached = (code) => detached.webContents.executeJavaScript(code)
  await inDetached(`document.querySelector('.tab-new').click()`)
  await waitFor(() => inDetached(`Array.from(document.querySelectorAll('.profile-card')).some(c => c.textContent.includes('Second World'))`))
  await inDetached(`Array.from(document.querySelectorAll('.profile-card')).find(c => c.textContent.includes('Second World')).click()`)
  await waitFor(() => sockets.size === 2)
  const secondMud = [...sockets].find((s) => s !== mud)
  secondMud.write('Second world says hello.\r\n')
  await waitFor(() => inDetached(`document.body.textContent.includes('Second world says hello.')`))
  assert.equal(await call(`document.body.textContent.includes('Second world says hello.')`), false)
  assert.ok(await inDetached(`document.body.textContent.includes('Connected to 127.0.0.1')`), 'its first events reached the window that connected it')
  await inDetached(`document.querySelector('.tab-active .tab-close').click()`)
  await waitFor(() => sockets.size === 1)
  await call(`window.mud.profiles.remove(${JSON.stringify(otherWorld.id)})`)
  console.log('ok a new world connected from a detached window lives in that window')

  detached.close()
  await waitFor(() => BrowserWindow.getAllWindows().length === 1)
  await waitFor(() => textIn(main, 'This line arrives after the move.'))
  mud.write('Home again.\r\n')
  await waitFor(() => textIn(main, 'Home again.'))
  assert.equal(sockets.size, 1, 'closing the window kept the connection')
  console.log('ok closing a detached window brings its sessions back to the main window, still connected')

  assert.deepEqual(await call(`window.mud.windows.move(${JSON.stringify(sessionId)}, 'new')`), { ok: true })
  const second = BrowserWindow.getAllWindows().find((w) => w !== main)
  await waitFor(() => textIn(second, 'Home again.'))
  await second.webContents.executeJavaScript(`document.querySelector('.tab-close').click()`)
  await waitFor(() => sockets.size === 0 && BrowserWindow.getAllWindows().length === 1)
  await call(`window.mud.profiles.remove(${JSON.stringify(profile.id)})`)
  console.log('ok closing the last tab in a detached window ends the session and closes the window')
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
