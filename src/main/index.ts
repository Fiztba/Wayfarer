import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { SessionManager } from './SessionManager'
import { ProfileStore } from './ProfileStore'
import { MudDirectory } from './MudDirectory'
import { SettingsStore } from './SettingsStore'
import { LogWriter } from './LogWriter'
import { MapStore } from './MapStore'
import type { ConnectOptions, Profile, SettingsSet } from '../shared/types'

let mainWindow: BrowserWindow | null = null

// One instance only: two copies sharing the same profile/settings/map files
// would fight over writes. A second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// MSP sounds are served from <userData>/sounds through a locked-down custom
// protocol; `stream: true` is required for <audio> playback.
protocol.registerSchemesAsPrivileged([
  { scheme: 'msp-sound', privileges: { stream: true } }
])

const sessions = new SessionManager(() => mainWindow?.webContents ?? null)
let profiles: ProfileStore

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    title: 'Wayfarer',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Open external links in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const soundsDir = path.join(app.getPath('userData'), 'sounds')
  fs.mkdirSync(soundsDir, { recursive: true })
  protocol.handle('msp-sound', (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '')
    const resolved = path.normalize(path.join(soundsDir, rel))
    if (!resolved.startsWith(soundsDir + path.sep) || !fs.existsSync(resolved)) {
      return new Response('', { status: 404 })
    }
    return net.fetch(pathToFileURL(resolved).toString())
  })

  profiles = new ProfileStore(app.getPath('userData'))
  const directory = new MudDirectory(app.getPath('userData'))

  ipcMain.handle('session:connect', (_e, opts: ConnectOptions) => sessions.connect(opts))
  ipcMain.on('session:send', (_e, id: string, text: string) => sessions.send(id, text))
  ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) =>
    sessions.resize(id, cols, rows)
  )
  ipcMain.handle('session:disconnect', (_e, id: string) => sessions.disconnect(id))
  ipcMain.handle('session:reconnect', (_e, id: string) => sessions.reconnect(id))

  ipcMain.handle('profiles:list', () => {
    const result = profiles.list()
    const line = `${new Date().toISOString()} profiles:list -> ${result.length} from ${app.getPath('userData')}`
    console.log(`[diag] ${line}`)
    try {
      // Durable breadcrumb: if profiles ever look missing again, this file
      // records what the backend actually saw at that moment.
      fs.appendFileSync(path.join(app.getPath('userData'), 'diag.log'), line + '\n')
    } catch {
      // diagnostics must never break the answer
    }
    return result
  })
  ipcMain.handle('profiles:save', (_e, profile: Partial<Profile>) => profiles.save(profile))
  ipcMain.handle('profiles:remove', (_e, id: string) => profiles.remove(id))

  ipcMain.handle('directory:list', () => directory.list())
  ipcMain.handle('directory:refresh', () => directory.list(true))

  const settings = new SettingsStore(app.getPath('userData'))
  ipcMain.handle('settings:get', (_e, profileId: string | null) => settings.get(profileId))
  ipcMain.handle('settings:save', (_e, profileId: string | null, set: SettingsSet) =>
    settings.save(profileId, set)
  )

  const logs = new LogWriter(app.getPath('userData'))
  ipcMain.handle('log:start', (_e, sessionId: string, name: string) => logs.start(sessionId, name))
  ipcMain.handle('log:stop', (_e, sessionId: string) => logs.stop(sessionId))
  ipcMain.on('log:line', (_e, sessionId: string, text: string) => logs.line(sessionId, text))
  ipcMain.handle('log:openFolder', () => shell.openPath(logs.logsDir))
  app.on('before-quit', () => logs.stopAll())

  // ---- Mapper: storage + pop-out windows with a state mirror --------------
  const maps = new MapStore(app.getPath('userData'))
  ipcMain.handle('map:load', (_e, key: string) => maps.load(key))
  ipcMain.on('map:save', (_e, key: string, map: unknown) => maps.save(key, map))

  const popouts = new Map<string, Set<BrowserWindow>>()

  ipcMain.handle('map:popout', (_e, sessionId: string, title: string) => {
    const win = new BrowserWindow({
      width: 640,
      height: 560,
      backgroundColor: '#0d1117',
      autoHideMenuBar: true,
      title: `Map — ${title}`,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    const hash = `#popout/${sessionId}`
    if (process.env.ELECTRON_RENDERER_URL) {
      win.loadURL(process.env.ELECTRON_RENDERER_URL + hash)
    } else {
      win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: hash.slice(1) })
    }
    let set = popouts.get(sessionId)
    if (!set) {
      set = new Set()
      popouts.set(sessionId, set)
    }
    set.add(win)
    win.on('closed', () => {
      popouts.get(sessionId)?.delete(win)
    })
  })

  // Session renderer → pop-outs (map state pushes).
  ipcMain.on('map:mirror-state', (_e, sessionId: string, state: unknown) => {
    for (const win of popouts.get(sessionId) ?? []) {
      if (!win.isDestroyed()) win.webContents.send('map:mirror-state', sessionId, state)
    }
  })
  // Pop-out → session renderer (hello requests + user actions).
  ipcMain.on('map:mirror-hello', (_e, sessionId: string) => {
    mainWindow?.webContents.send('map:mirror-hello', sessionId)
  })
  ipcMain.on('map:mirror-action', (_e, sessionId: string, action: unknown) => {
    mainWindow?.webContents.send('map:mirror-action', sessionId, action)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  sessions.destroyAll()
  app.quit()
})
