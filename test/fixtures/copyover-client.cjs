// A real app process controlled only by its parent test process.
const electron = require('electron')
const { app, BrowserWindow } = electron
const Module = require('node:module')
const path = require('node:path')
app.setPath('userData', process.argv[2])
app.getVersion = () => process.argv[3]
app.disableHardwareAcceleration()
const load = Module._load
Module._load = function(name, ...args) {
  if (name === 'electron') return { ...electron,
    dialog: { ...electron.dialog, showErrorBox: (title, text) => process.send?.({ failure: `${title}: ${text}` }) },
    BrowserWindow: class extends BrowserWindow {
      constructor(opts) { super({ ...opts, show: false, webPreferences: { ...opts.webPreferences, offscreen: true, backgroundThrottling: false } }) }
    }
  }
  return load.call(this, name, ...args)
}
const updater = require('electron-updater').autoUpdater
updater.quitAndInstall = () => { setTimeout(() => app.exit(0), 30) }
process.on('message', async (message) => {
  try {
    const win = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#popout'))
    if (message.op === 'quit') { app.quit(); return }
    if (message.op === 'update') {
      const descriptor = Object.getOwnPropertyDescriptor(app, 'isPackaged')
      Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
      updater.checkForUpdates = async () => ({ updateInfo: { version: '99.0.0' }, downloadPromise: Promise.resolve([]) })
      await win.webContents.executeJavaScript('window.mud.checkForUpdate()')
      if (descriptor) Object.defineProperty(app, 'isPackaged', descriptor)
      else delete app.isPackaged
      await win.webContents.executeJavaScript('window.mud.installUpdate()')
    } else {
      const result = await win.webContents.executeJavaScript(message.code)
      process.send?.({ id: message.id, result })
    }
  } catch (error) { process.send?.({ id: message.id, failure: String(error) }) }
})
require(path.resolve(__dirname, '../../out/main/index.js'))
app.whenReady().then(async () => {
  const until = Date.now() + 10000
  for (;;) {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.webContents.isLoading() && win.webContents.getURL()) break
    if (Date.now() > until) throw new Error('Window did not load')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  process.send?.({ ready: true })
}).catch(error => { process.send?.({ failure: String(error) }); app.exit(1) })
