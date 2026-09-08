const { app, BrowserWindow } = require('electron')
const { build } = require('esbuild')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wayfarer-map-test-'))
app.setPath('userData', path.join(scratch, 'userData'))
app.disableHardwareAcceleration()
const baseline = process.argv.find((v) => v.startsWith('--baseline='))?.split('=')[1]
const timeout = setTimeout(() => { console.error('Mapper test timed out'); app.exit(1) }, 30000)
app.whenReady().then(async () => {
  const map = require('./fixtures/twisted-map.cjs')()
  const plugins = baseline ? [{ name: 'baseline', setup(b) {
    b.onLoad({ filter: /Map(Canvas|Pane)\.tsx$/ }, (args) => {
      const file = path.relative(root, args.path).replaceAll('\\', '/')
      const result = spawnSync('git', ['show', `${baseline}:${file}`], { cwd: root, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
      return { contents: result.stdout, loader: 'tsx', resolveDir: path.dirname(args.path) }
    })
  } }] : []
  await build({ absWorkingDir: root, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(scratch, 'fixture.js'), plugins,
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { MapPane } from './src/renderer/src/components/MapPane';
      import { MapModel } from './src/renderer/src/map/MapModel';
      import { MapTracker } from './src/renderer/src/map/MapTracker';
      const model = new MapModel(${JSON.stringify(map)}, () => {});
      const tracker = new MapTracker(model, {info: () => {}});
      window.walks = []; window.graph = () => JSON.stringify(model.map);
      createRoot(document.getElementById('root')).render(<MapPane model={model} tracker={tracker} walkTo={(id) => window.walks.push(id)} />);
    ` } })
  const css = fs.readFileSync(path.join(root, 'src/renderer/src/styles.css'), 'utf8')
  fs.writeFileSync(path.join(scratch, 'index.html'), `<!doctype html><meta charset="utf-8"><style>${css}\n#root {height:100vh;display:flex} .map-pane{border:0}</style><div id="root"></div><script src="fixture.js"></script>`)
  const win = new BrowserWindow({ show: false, width: 940, height: 720, webPreferences: { offscreen: true, backgroundThrottling: false } })
  const errors = []
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
  const js = (code) => win.webContents.executeJavaScript(code)
  const waitFor = async (code) => {
    const until = Date.now() + 5000
    while (!await js(code)) { assert.ok(Date.now() < until, code); await new Promise((r) => setTimeout(r, 20)) }
  }
  await win.loadFile(path.join(scratch, 'index.html'))
  await waitFor(`!!document.querySelector('.map-canvas')`)
  const before = await js('window.graph()')
  if (!baseline) {
    await waitFor(`document.querySelectorAll('.map-exit-row').length === 7`)
    assert.ok(await js(`document.querySelector('.map-exit-list').textContent.includes('Back: E')`))
    await js(`document.querySelector('.map-exit-trace').click()`)
    await waitFor(`document.querySelector('.map-exit-trace').getAttribute('aria-pressed') === 'true'`)
    assert.deepEqual(await js('window.walks'), [])
    assert.equal(await js('window.graph()'), before)
    console.log('ok every exit is listed; tracing preserves graph and sends no movement')
  }
  await new Promise((r) => setTimeout(r, 150))
  if (process.env.WAYFARER_MAP_CAPTURE) fs.writeFileSync(process.env.WAYFARER_MAP_CAPTURE, (await win.webContents.capturePage()).toPNG())
  if (!baseline) {
    win.setSize(360, 620)
    await new Promise((r) => setTimeout(r, 100))
    assert.ok(await js(`document.querySelector('.map-exit-inspector').scrollWidth <= document.querySelector('.map-exit-inspector').clientWidth`))
    assert.ok(await js(`document.querySelector('.map-canvas').clientHeight`) > 150)
    console.log('ok narrow mapper pane keeps the inspector contained and canvas usable')
    await js(`document.querySelector('[aria-label="Locate Bell Tower"]').click()`)
    await waitFor(`document.querySelector('.map-zone-select').value === 'tower'`)
    assert.ok(await js(`document.querySelector('.map-level').textContent.includes('L1')`))
    assert.deepEqual(await js('window.walks'), [])
    assert.equal(await js('window.graph()'), before)
    console.log('ok locating a cross-zone exit changes view without walking or editing')
    const height = await js(`document.querySelector('.map-canvas').clientHeight`)
    await js(`document.querySelector('[title="Inspect and trace room exits"]').click()`)
    await waitFor(`!document.querySelector('.map-exit-inspector')`)
    assert.ok(await js(`document.querySelector('.map-canvas').clientHeight`) > height)
    console.log('ok exit inspector can be collapsed for more map space')
  }
  assert.deepEqual(errors, [])
  win.destroy()
}).then(() => { clearTimeout(timeout); app.exit(0) }, (err) => { console.error(err); clearTimeout(timeout); app.exit(1) })
