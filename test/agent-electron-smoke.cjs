/** Agent control in the real renderer and preload, with the main process's
 * side stubbed: #agent from the input line only, what reaches the bridge,
 * and every refusal. Run after npm run build:
 *   npx electron test/agent-electron-smoke.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wayfarer-agent-ui-test-'))
app.setPath('userData', scratch)
app.disableHardwareAcceleration()
const timeout = setTimeout(() => { console.error('Agent electron smoke timed out'); app.exit(1) }, 30000)
app.whenReady().then(async () => {
  const bundled = buildSync({ entryPoints: [path.join(root, 'src/shared/types.ts')], bundle: true, write: false, format: 'cjs', platform: 'node' })
  const mod = { exports: {} }
  new Function('module', 'exports', bundled.outputFiles[0].text)(mod, mod.exports)
  const settings = mod.exports.defaultSettings()
  const trigger = (id, pattern, commands, gag = false) => ({ id, label: id, pattern, matchType: 'substring',
    caseInsensitive: false, commands, gag, highlight: '', enabled: true })
  settings.triggers.push(trigger('hand-over', 'hand over', '#agent on'), trigger('answer', 'trigger me', 'say hi'),
    trigger('hide', 'secret line', '', true))
  const sent = [], errors = [], enables = [], disables = [], lines = [], prompts = [], results = new Map()
  for (const [channel, value] of Object.entries({
    'profiles:list': [{ id: 'test', name: 'Test World', host: 'localhost', port: 4000, tls: false, encoding: 'utf8' }],
    'directory:list': { entries: [], source: 'cache' }, 'map:load': null, 'app:update-state': null,
    'copyover:restore': null, 'copyover:resume': null, 'session:connect': 'session-1', 'session:disconnect': null
  })) ipcMain.handle(channel, () => value)
  ipcMain.handle('settings:get', (_e, profileId) => (profileId == null ? settings : mod.exports.defaultSettings()))
  ipcMain.handle('settings:save', (_e, _scope, set) => set)
  ipcMain.handle('agent:enable', (_e, id, info) => { enables.push([id, info]); return { config: 'agent.json' } })
  ipcMain.handle('agent:disable', (_e, id) => { disables.push(id) })
  ipcMain.on('agent:line', (_e, id, line) => lines.push({ id, ...line }))
  ipcMain.on('agent:prompt', (_e, _id, text) => prompts.push(text))
  ipcMain.on('agent:sent', (_e, requestId, result) => results.set(requestId, result))
  ipcMain.on('session:send', (_e, _id, text) => sent.push(text))
  const win = new BrowserWindow({ show: false, width: 1280, height: 860,
    webPreferences: { preload: path.join(root, 'out/preload/index.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true } })
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
  const js = (code) => win.webContents.executeJavaScript(code)
  const pause = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (what, check) => {
    const until = Date.now() + 5000
    while (!(await check())) { assert.ok(Date.now() < until, `Timed out: ${what}`); await pause(20) }
  }
  const inPage = (code) => () => js(code)
  const event = (ev) => win.webContents.send('session:event', 'session-1', ev)
  const type = async (value) => {
    await js(`{ const el = document.querySelector('.command-input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', {bubbles:true})); }`)
    await pause(30)
    await js(`document.querySelector('.command-input').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))`)
    await pause(30)
  }
  let requestId = 0
  const agentSend = async (text, session = 'session-1') => {
    const id = ++requestId
    win.webContents.send('agent:send', id, session, text)
    await waitFor(`answer to ${JSON.stringify(text)}`, () => results.has(id))
    return results.get(id)
  }
  const outputText = () => js(`document.querySelector('.output').textContent`)

  await win.loadFile(path.join(root, 'out/renderer/index.html'))
  await waitFor('profile card', inPage(`!!document.querySelector('.profile-card')`))
  await js(`document.querySelector('.profile-card').click()`)
  await waitFor('command input', inPage(`!!document.querySelector('.command-input')`))
  event({ type: 'connected' })
  await waitFor('connected', inPage(`document.body.textContent.includes('Connected to')`))

  // The game cannot hand the session over: not with a link, not via a trigger.
  event({ type: 'text', data: '\x1b]8;;send:%23agent%20on\x07Click for treasure\x1b]8;;\x07\r\n' })
  await waitFor('link', inPage(`Array.from(document.querySelectorAll('.mxp-link')).some(e => e.title === '#agent on')`))
  await js(`Array.from(document.querySelectorAll('.mxp-link')).find(e => e.title === '#agent on').click()`)
  event({ type: 'text', data: 'The wizard asks you to hand over control.\r\n' })
  await waitFor('trigger line', async () => (await outputText()).includes('hand over control'))
  await pause(100)
  assert.deepEqual(enables, [])
  assert.equal(await js(`!!document.querySelector('.status-btn-agent')`), false)
  assert.deepEqual(lines, [], 'nothing reaches the bridge before agent control is on')
  console.log('ok a link or trigger from the game sending #agent on does not turn agent control on')

  await type('#agent maybe')
  await waitFor('usage', async () => (await outputText()).includes('Usage: #agent on'))
  await type('#agent')
  await waitFor('status', async () => (await outputText()).includes('Agent control is off.'))
  await type('#agent on')
  await waitFor('enable', () => enables.length === 1)
  assert.deepEqual(enables[0], ['session-1', { name: 'Test World', character: null }])
  await waitFor('indicator', inPage(`!!document.querySelector('.status-btn-agent')`))
  assert.equal(lines[0].kind, 'system')
  assert.match(lines[0].text, /Agent control on/)
  console.log('ok #agent typed in the input line turns it on and shows the status-bar indicator')

  event({ type: 'text', data: 'A quiet room.\r\n<10hp> ' })
  await waitFor('prompt', () => prompts.includes('<10hp> '))
  assert.ok(lines.some((l) => l.kind === 'output' && l.text === 'A quiet room.'))
  assert.deepEqual(await agentSend('look'), { ok: true })
  assert.equal(sent.at(-1), 'look')
  assert.ok(lines.some((l) => l.kind === 'input' && l.text === '<10hp> look'), 'the echo carries the prompt it was typed at')
  assert.equal(prompts.at(-1), '', 'the echo uses up the prompt')
  console.log('ok a command from the agent runs as typed, and output, echo and prompt reach the bridge')

  event({ type: 'text', data: 'trigger me\r\nsecret line\r\n' })
  await waitFor('trigger echo', () => lines.some((l) => l.kind === 'trigger' && l.text === 'say hi'))
  await waitFor('gagged line', () => lines.some((l) => l.kind === 'output' && l.text === 'secret line'))
  const fired = lines.findIndex((l) => l.kind === 'output' && l.text === 'trigger me')
  assert.ok(fired >= 0 && fired < lines.findIndex((l) => l.kind === 'trigger'), 'a trigger echo follows the line that fired it')
  assert.ok(!(await outputText()).includes('secret line'), 'the gag still hides it on screen')
  console.log('ok gagged lines and trigger echoes reach the bridge in order')

  event({ type: 'echo', serverEchoes: true })
  await waitFor('masked', inPage(`!!document.querySelector('input.command-input[type=password]')`))
  const masked = await agentSend('hunter2')
  assert.equal(masked.ok, false)
  assert.match(masked.error, /password/)
  event({ type: 'echo', serverEchoes: false })
  await waitFor('unmasked', inPage(`!!document.querySelector('textarea.command-input')`))
  assert.match((await agentSend('say a\nsay b')).error, /One command/)
  assert.match((await agentSend('#agent off')).error, /Only the player/)
  assert.match((await agentSend('#reconnect')).error, /Reconnecting/)
  assert.match((await agentSend('look', 'session-x')).error, /gone/)
  assert.ok(!sent.includes('hunter2') && !sent.some((s) => s.startsWith('say a')))
  assert.equal(await js(`!!document.querySelector('.status-btn-agent')`), true)
  console.log('ok password prompts, multi-line text, #agent and #reconnect from the agent are refused')

  await js(`document.querySelector('.status-btn-agent').click()`)
  await waitFor('disable', () => disables.length === 1)
  await waitFor('indicator gone', inPage(`!document.querySelector('.status-btn-agent')`))
  const forwarded = lines.length
  event({ type: 'text', data: 'after the agent left\r\n' })
  await waitFor('line', async () => (await outputText()).includes('after the agent left'))
  assert.equal(lines.length, forwarded)
  assert.match((await agentSend('look')).error, /off/)
  console.log('ok the indicator turns it off and the bridge hears nothing more')

  await type('#agent on')
  await waitFor('enable again', () => enables.length === 2)
  await js(`document.querySelector('.tab-close').click()`)
  await waitFor('session closed', inPage(`!document.querySelector('.command-input')`))
  await waitFor('disable on close', () => disables.length === 2)
  assert.deepEqual(errors, [])
  console.log('ok closing the session turns agent control off, without renderer errors')
  win.destroy()
}).then(() => { clearTimeout(timeout); app.exit(0) }, (err) => {
  console.error(err); clearTimeout(timeout); app.exit(1)
})
