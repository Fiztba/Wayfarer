/** Real Windows/Electron renderer + preload, isolated IPC fixtures.
 * Run after npm run build: npx electron test/electron-smoke.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wayfarer-ui-test-'))
app.setPath('userData', scratch)
app.disableHardwareAcceleration()
const timeout = setTimeout(() => { console.error('Electron smoke timed out'); app.exit(1) }, 30000)
app.whenReady().then(async () => {
  const bundled = buildSync({ entryPoints: [path.join(root, 'src/shared/types.ts')], bundle: true, write: false, format: 'cjs', platform: 'node' })
  const mod = { exports: {} }
  new Function('module', 'exports', bundled.outputFiles[0].text)(mod, mod.exports)
  const settings = mod.exports.defaultSettings()
  settings.triggers.push({ id: 'pause-test', label: 'Pause test', pattern: 'pause probe', matchType: 'substring',
    caseInsensitive: false, commands: 'say trigger-fired', gag: true, highlight: '', enabled: true })
  const sent = [], errors = []
  let finishUpdate
  ipcMain.handle('app:check-update', () => new Promise(resolve => { finishUpdate = resolve }))
  for (const [channel, value] of Object.entries({
    'profiles:list': [{ id: 'test', name: 'Test World', host: 'localhost', port: 4000, tls: false, encoding: 'utf8' }],
    'directory:list': { entries: [], source: 'cache' },
    'settings:get': settings, 'map:load': null, 'app:update-state': null,
    'copyover:restore': null, 'copyover:resume': null,
    'session:connect': 'session-1', 'session:disconnect': null
  })) ipcMain.handle(channel, () => value)
  ipcMain.handle('settings:save', (_e, _scope, set) => set)
  ipcMain.on('session:send', (_e, _id, text) => sent.push(text))
  const win = new BrowserWindow({ show: false, width: 1280, height: 860,
    webPreferences: { preload: path.join(root, 'out/preload/index.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true } })
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
  const js = (code) => win.webContents.executeJavaScript(code)
  const waitFor = async (code) => {
    const until = Date.now() + 5000
    while (!await js(code)) {
      assert.ok(Date.now() < until, `Timed out: ${code}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  const event = (ev) => win.webContents.send('session:event', 'session-1', ev)
  const setInput = async (value) => {
    await js(`{ const el = document.querySelector('.command-input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', {bubbles:true})); }`)
    await new Promise((r) => setTimeout(r, 30))
  }
  const key = (name) => js(`document.querySelector('.command-input').dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(name)}, bubbles:true}))`)
  await win.loadFile(path.join(root, 'out/renderer/index.html'))
  await waitFor(`!!document.querySelector('.profile-card')`)
  await js(`document.querySelector('.profile-card').click()`)
  await waitFor(`!!document.querySelector('.command-input')`)
  event({ type: 'connected' })
  await waitFor(`document.body.textContent.includes('Connected to')`)
  await js(`Array.from(document.querySelectorAll('.status-btn')).find(b => b.textContent.trim() === 'Check For Update').click()`)
  await waitFor(`!!Array.from(document.querySelectorAll('.status-btn')).find(b => b.disabled && b.textContent.includes('Checking'))`)
  finishUpdate('You are up to date (test).')
  await waitFor(`document.querySelector('.status-actions').textContent.includes('You are up to date')`)
  assert.ok(await js(`!!Array.from(document.querySelectorAll('.status-btn')).find(b => !b.disabled && b.textContent.trim() === 'Check For Update')`))
  assert.deepEqual(sent, [])
  console.log('ok Check For Update button uses real preload, shows progress and result, and sends no game commands')
  await setInput('look')
  await key('Enter')
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(sent, ['look'])
  console.log('ok command input crosses the real preload bridge')
  event({ type: 'echo', serverEchoes: true })
  await waitFor(`!!document.querySelector('input.command-input[type=password]')`)
  await setInput('secret-draft')
  await key('ArrowUp')
  assert.equal(await js(`document.querySelector('.command-input').value`), 'secret-draft')
  event({ type: 'echo', serverEchoes: false })
  await waitFor(`!!document.querySelector('textarea.command-input')`)
  assert.equal(await js(`document.querySelector('.command-input').value`), '')
  await key('ArrowDown')
  assert.equal(await js(`document.querySelector('.command-input').value`), '')
  console.log('ok password drafts cannot reappear in history or unmasked input')
  event({ type: 'text', data: 'https://www.las' })
  await waitFor(`document.querySelector('.line-prompt')?.textContent.includes('https://www.las')`)
  event({ type: 'text', data: '\x1b[31mt-outpost.com/\x1b[0m' })
  await waitFor(`document.querySelector('.line-prompt')?.textContent.includes('last-outpost.com/')`)
  assert.deepEqual(await js(`Array.from(document.querySelectorAll('.line-prompt .web-link')).map(e => e.title)`),
    ['Open https://www.last-outpost.com/ in your browser', 'Open https://www.last-outpost.com/ in your browser'])
  event({ type: 'text', data: '\r\n\x1b[21mDoubleul\x1b[24m Plain\r\n' })
  await waitFor(`Array.from(document.querySelectorAll('.line span')).some(e => e.textContent === 'Doubleul')`)
  assert.equal(await js(`getComputedStyle(Array.from(document.querySelectorAll('.line span')).find(e => e.textContent === 'Doubleul')).textDecorationStyle`), 'double')
  assert.ok((await js(`Array.from(document.querySelectorAll('.line-output .web-link')).map(e => e.title)`)).every(t => t === 'Open https://www.last-outpost.com/ in your browser'))
  event({ type: 'text', data: '\x1b]8;;send:say%20please\x07say please\x1b]8;;\x07 \x1b]8;;prompt:buy%20%3Cquantity%3E\x07buy <quantity>\x1b]8;;\x07\r\n' })
  await waitFor(`Array.from(document.querySelectorAll('.mxp-link')).some(e => e.title === 'say please')`)
  const beforeLink = sent.length
  await js(`Array.from(document.querySelectorAll('.mxp-link')).find(e => e.title === 'say please').click()`)
  await waitFor(`Array.from(document.querySelectorAll('.line-input')).some(e => e.textContent.includes('say please'))`)
  assert.equal(sent.length, beforeLink + 1)
  assert.equal(sent.at(-1), 'say please')
  await js(`Array.from(document.querySelectorAll('.mxp-link')).find(e => e.title === 'buy <quantity>').click()`)
  assert.equal(await js(`document.querySelector('.command-input').value`), 'buy <quantity>')
  assert.equal(sent.length, beforeLink + 1)
  event({ type: 'text', data: 'A searchable room description.\r\n' })
  await waitFor(`document.body.textContent.includes('A searchable room description.')`)
  await js(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Settings')).click()`)
  await waitFor(`!!document.querySelector('[role=dialog]')`)
  await js(`document.querySelector('.add-btn').click()`)
  await waitFor(`!!document.querySelector('.editor-form')`)
  for (const width of [1280, 700, 420]) {
    win.setSize(width, 740)
    await new Promise(resolve => setTimeout(resolve, 80))
    const layout = await js(`(() => {
      const panel = document.querySelector('.panel').getBoundingClientRect();
      const form = document.querySelector('.editor-form');
      return { inside: form.getBoundingClientRect().right <= panel.right,
        fits: form.scrollWidth <= form.clientWidth + 1,
        textareaHeight: form.querySelector('textarea').getBoundingClientRect().height,
        tabsFit: document.querySelector('.panel-tabs').getBoundingClientRect().right <= panel.right };
    })()`)
    assert.ok(layout.inside && layout.fits && layout.tabsFit, `settings contained at ${width}px: ${JSON.stringify(layout)}`)
    assert.ok(layout.textareaHeight >= 50, 'command editor must not collapse when the form scrolls')
    if (width === 700 && process.env.WAYFARER_SETTINGS_CAPTURE) {
      fs.writeFileSync(process.env.WAYFARER_SETTINGS_CAPTURE, (await win.webContents.capturePage()).toPNG())
    }
  }
  await js(`document.querySelector('.form-buttons').scrollIntoView()`)
  assert.ok(await js(`document.querySelector('.form-buttons').getBoundingClientRect().bottom <= document.querySelector('.panel').getBoundingClientRect().bottom`))
  console.log('ok trigger editor stays inside settings at desktop and narrow widths with usable scrolling')
  await js(`document.querySelector('.panel-close').click()`)
  await waitFor(`!document.querySelector('[role=dialog]')`)
  console.log('ok output renders and settings opens/closes')
  const sentBeforePause = sent.length
  await js(`Array.from(document.querySelectorAll('.status-btn')).find(b => b.textContent === 'Pause Triggers').click()`)
  await waitFor(`!!document.querySelector('.status-btn[aria-pressed=true]')`)
  event({ type: 'text', data: 'pause probe\r\n' })
  await waitFor(`document.querySelector('.output').textContent.includes('pause probe')`)
  assert.equal(sent.length, sentBeforePause)
  await js(`document.querySelector('.status-btn[aria-pressed=true]').click()`)
  await waitFor(`!!Array.from(document.querySelectorAll('.status-btn')).find(b => b.textContent === 'Pause Triggers')`)
  event({ type: 'text', data: 'pause probe\r\n' })
  await waitFor(`document.querySelector('.output').textContent.includes('trigger-fired')`)
  assert.ok(sent.length > sentBeforePause)
  assert.ok(sent.slice(sentBeforePause).every(command => command === 'say trigger-fired'))
  console.log('ok status toggle pauses and resumes trigger commands and gagging through the real session')
  await js(`document.querySelector('.tab-close').click()`)
  await waitFor(`!document.querySelector('.command-input')`)
  assert.deepEqual(errors, [])
  console.log('ok session closes without renderer errors')
  win.destroy()
}).then(() => { clearTimeout(timeout); app.exit(0) }, (err) => {
  console.error(err); clearTimeout(timeout); app.exit(1)
})
