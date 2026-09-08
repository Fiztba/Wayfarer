/** Built app, real preload and main stores; only native file dialogs are fixtures. */
const electron = require('electron')
const { app, BrowserWindow } = electron
const Module = require('node:module')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const assert = require('node:assert/strict')
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wayfarer-tools-test-'))
const transfer = path.join(base, 'transfer.wayfarer.json')
app.setPath('userData', base); app.disableHardwareAcceleration()
app.getVersion = () => require('../package.json').version
fs.writeFileSync(path.join(base, 'mud-directory-cache.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), snapshot: { muds: [], counts: {}, builtAt: new Date().toISOString() } }))
const load = Module._load
Module._load = function(name, ...args) {
  if (name === 'electron') return { ...electron,
    dialog: { ...electron.dialog, showSaveDialog: async () => ({ canceled: false, filePath: transfer }), showOpenDialog: async () => ({ canceled: false, filePaths: [transfer] }) },
    BrowserWindow: class extends BrowserWindow {
      constructor(options) { super({ ...options, show: false, width: 1120, height: 850, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } }) }
    }
  }
  return load.call(this, name, ...args)
}
const timeout = setTimeout(() => { console.error('World tools test timed out'); app.exit(1) }, 30000)
const wait = async (fn) => { const until = Date.now() + 5000; while (!await fn()) { assert.ok(Date.now() < until, 'Timed out'); await new Promise((r) => setTimeout(r, 20)) } }
;(async () => {
  require('../out/main/index.js'); await app.whenReady()
  await wait(() => BrowserWindow.getAllWindows().length === 1)
  const win = BrowserWindow.getAllWindows()[0]
  await wait(() => !win.webContents.isLoading())
  const js = (code) => win.webContents.executeJavaScript(code)
  const click = (text) => js(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`)
  const value = (selector, text) => js(`{const e=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set.call(e,${JSON.stringify(text)}); e.dispatchEvent(new Event('input',{bubbles:true}));}`)
  const p = await js(`window.mud.profiles.save({name:'Silver Coast',host:'example.invalid',port:4000})`)
  const id = JSON.stringify(p.id)
  await js(`(async()=>{const s=await window.mud.settings.get(${id}); s.variables.hp='42'; await window.mud.settings.save(${id},s);})()`)
  await js(`window.mud.map.persist(${id}, ${JSON.stringify(require('./fixtures/twisted-map.cjs')())})`)
  await click('Worlds')
  await wait(() => js(`document.querySelector('.tools-panel select')?.options.length === 1 && !document.querySelector('fieldset').disabled`))
  await click('Create backup')
  await wait(() => js(`document.body.textContent.includes('World snapshot saved.')`))
  await click('Export world…')
  await wait(() => fs.existsSync(transfer))
  assert.equal(JSON.parse(fs.readFileSync(transfer,'utf8')).settings.variables.hp, '42')
  await wait(() => js(`!document.querySelector('fieldset').disabled`))
  await click('Import world…')
  await wait(() => js(`!!document.querySelector('.world-preview')`))
  assert.equal((await js('window.mud.profiles.list()')).length, 1, 'preview cannot write a world')
  if (process.env.WAYFARER_TOOLS_CAPTURE) fs.writeFileSync(path.join(process.env.WAYFARER_TOOLS_CAPTURE, 'world-library.png'), (await win.webContents.capturePage()).toPNG())
  await click('Import as new world')
  await wait(async () => (await js('window.mud.profiles.list()')).length === 2)
  await wait(() => js(`!document.querySelector('fieldset').disabled`))
  console.log('ok real world export, preview and non-destructive import through the built UI')
  await js(`document.querySelector('[aria-label="Close world library"]').click()`)
  await js(`window.mud.log.start('fixture','Silver Coast')`)
  await js(`{window.mud.log.line('fixture','The harbor falls quiet.',{character:'Aster'}); window.mud.log.line('fixture','Mira tells you: the silver key opens the gate.',{character:'Aster',channel:'Tells'}); window.mud.log.line('fixture','Waves roll against the quay.',{character:'Aster'});}`)
  await js(`window.mud.log.stop('fixture')`)
  await wait(() => fs.readdirSync(path.join(base,'logs')).some((f) => f.endsWith('.jsonl') && fs.readFileSync(path.join(base,'logs',f),'utf8').includes('Waves roll')))
  await click('History')
  await wait(() => js(`!!document.querySelector('[aria-label="Search text"]')`))
  await value('[aria-label="Search text"]', 'silver key')
  await js(`document.querySelector('.tools-panel form').requestSubmit()`)
  await wait(() => js(`document.querySelectorAll('.history-results button').length === 1`))
  await js(`document.querySelector('.history-results button').click()`)
  await wait(() => js(`document.querySelector('.history-context')?.textContent.includes('Waves roll')`))
  assert.ok(await js(`document.querySelector('.history-context').textContent.includes('harbor falls quiet')`))
  if (process.env.WAYFARER_TOOLS_CAPTURE) fs.writeFileSync(path.join(process.env.WAYFARER_TOOLS_CAPTURE, 'history-search.png'), (await win.webContents.capturePage()).toPNG())
  win.setSize(620,760)
  await new Promise((r) => setTimeout(r, 100))
  assert.ok(await js(`document.querySelector('.tools-panel').scrollWidth <= document.querySelector('.tools-panel').clientWidth`))
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await wait(() => js(`!document.querySelector('.tools-panel')`))
  console.log('ok saved capture search opens surrounding context, fits narrow windows and closes by keyboard')
  win.destroy(); clearTimeout(timeout); app.exit(0)
})().catch((err) => { console.error(err); clearTimeout(timeout); app.exit(1) })
