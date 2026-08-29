import { app, BrowserWindow, ipcMain, net, protocol, screen, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
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
/** Version of a downloaded update waiting to install, once one exists. */
let updateReady: string | null = null
/** Where the updater writes; null until the packaged updater starts up. */
let updaterLogPath: string | null = null

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

// Windows toasts are delivered by AppUserModelID, and Electron's runtime
// default does not necessarily match the ID the installer stamped on the
// Start Menu shortcut — when they disagree the toast is dropped silently.
// This is the shortcut's actual ID, so the two now agree.
if (process.platform === 'win32') app.setAppUserModelId('electron.app.Wayfarer')

/**
 * Renderer settings shared by the main window and the map pop-outs.
 *
 * The version rides in on argv so the renderer has it synchronously at
 * startup — it feeds the status bar, the MXP <VERSION> reply and GMCP
 * Core.Hello, none of which can wait on a round trip.
 */
function rendererPreferences() {
  return {
    preload: path.join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    additionalArguments: [`--app-version=${app.getVersion()}`]
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    title: 'Wayfarer',
    webPreferences: rendererPreferences()
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

  // A window that mounts after 'update-downloaded' fired would never hear the
  // event, so the current state is also pullable.
  ipcMain.handle('app:update-state', () => updateReady)
  ipcMain.handle('app:install-update', () => {
    if (!updateReady) return false
    // isSilent=true, isForceRunAfter=true: reinstall and come straight back.
    autoUpdater.quitAndInstall(true, true)
    return true
  })
  ipcMain.handle('app:open-updater-log', async () => {
    if (!updaterLogPath || !fs.existsSync(updaterLogPath)) return false
    await shell.openPath(updaterLogPath)
    return true
  })

  ipcMain.handle('session:connect', (_e, opts: ConnectOptions) => sessions.connect(opts))
  ipcMain.on('session:send', (_e, id: string, text: string) => sessions.send(id, text))
  ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) =>
    sessions.resize(id, cols, rows)
  )
  ipcMain.handle('session:disconnect', (_e, id: string) => sessions.disconnect(id))
  ipcMain.handle('session:reconnect', (_e, id: string) => sessions.reconnect(id))

  ipcMain.handle('profiles:list', () => {
    const result = profiles.list()
    // Durable breadcrumb (userData/diag.log): the parsed count plus the RAW
    // directory read with error text. The raw view is what cracked the
    // vanishing-profiles case — keep it.
    const userData = app.getPath('userData')
    let raw: string
    try {
      raw = fs.readdirSync(path.join(userData, 'profiles')).join('|') || '(empty)'
    } catch (e) {
      raw = 'READDIR-ERR ' + String(e)
    }
    const line = `${new Date().toISOString()} profiles:list -> ${result.length} raw=[${raw}] userData=${userData}`
    console.log(`[diag] ${line}`)
    try {
      fs.appendFileSync(path.join(userData, 'diag.log'), line + '\n')
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
  // Closing a pop-out is the user forgetting it; closing because the app is
  // quitting must NOT be, or a map left open on a second monitor comes back
  // closed next launch.
  let quitting = false
  app.on('before-quit', () => {
    quitting = true
  })

  // ---- Mapper: storage + pop-out windows with a state mirror --------------
  const maps = new MapStore(app.getPath('userData'))
  ipcMain.handle('map:load', (_e, key: string) => maps.load(key))
  ipcMain.on('map:save', (_e, key: string, map: unknown) => maps.save(key, map))

  const popouts = new Map<string, Set<BrowserWindow>>()

  interface PopoutBounds {
    x: number
    y: number
    width: number
    height: number
  }

  /** Only reuse remembered bounds if they still land on an attached display —
   *  a window restored onto a monitor that has since been unplugged is
   *  invisible and looks like the pop-out simply failed to open. */
  const boundsOnScreen = (b: PopoutBounds | null | undefined): PopoutBounds | null => {
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return null
    if (!(b.width > 120) || !(b.height > 120)) return null
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height
    })
    return visible ? b : null
  }

  const reportBounds = (sessionId: string, bounds: PopoutBounds | null): void => {
    mainWindow?.webContents.send('map:popout-bounds', sessionId, bounds)
  }

  ipcMain.handle('map:popout', (_e, sessionId: string, title: string, saved?: PopoutBounds) => {
    const restored = boundsOnScreen(saved)
    const win = new BrowserWindow({
      ...(restored ?? { width: 640, height: 560 }),
      backgroundColor: '#0d1117',
      autoHideMenuBar: true,
      title: `Map — ${title}`,
      webPreferences: rendererPreferences()
    })
    // Record where it opened, then follow it around.
    reportBounds(sessionId, win.getBounds())
    let settle: ReturnType<typeof setTimeout> | null = null
    const remember = (): void => {
      if (settle) clearTimeout(settle)
      settle = setTimeout(() => {
        settle = null
        if (!win.isDestroyed()) reportBounds(sessionId, win.getBounds())
      }, 400)
    }
    win.on('move', remember)
    win.on('resize', remember)
    win.on('close', () => {
      if (settle) clearTimeout(settle)
      // Deliberately closed → forget it. Quitting → leave the last bounds.
      if (!quitting) reportBounds(sessionId, null)
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

  // ---- Auto-update: newest GitHub Release -------------------------------
  // Poll on launch and every 4 hours after, since a client can stay up for
  // days. Downloads happen in the background and install on quit, so a live
  // session is never interrupted; failures (offline, rate-limit) just wait
  // for the next poll.
  if (app.isPackaged) {
    // console.log is invisible in a packaged build, which is how a silent
    // failure stayed silent. Everything the updater says goes to a file the
    // user can actually open (⚙ Settings → General → Open updater log).
    const logPath = path.join(app.getPath('userData'), 'updater.log')
    const log = (...parts: unknown[]): void => {
      const line = `${new Date().toISOString()} ${parts.map(String).join(' ')}\n`
      try {
        fs.appendFileSync(logPath, line)
      } catch {
        /* logging must never take the app down */
      }
    }
    updaterLogPath = logPath

    autoUpdater.logger = { info: log, warn: log, error: log, debug: log }
    autoUpdater.on('error', (err) => log('[error]', String(err)))
    autoUpdater.on('checking-for-update', () => log('[checking] current', app.getVersion()))
    autoUpdater.on('update-not-available', () => log('[none] already current'))
    // The toast is best-effort; the status-bar indicator is what the user is
    // actually meant to notice, so the renderer is told directly.
    autoUpdater.on('update-downloaded', (info) => {
      log('[ready]', info.version, '— installs on quit')
      updateReady = info.version
      mainWindow?.webContents.send('app:update-ready', info.version)
    })

    const check = () => autoUpdater.checkForUpdatesAndNotify().catch(() => {})
    check()
    setInterval(check, 4 * 60 * 60 * 1000)
  }
})

app.on('window-all-closed', () => {
  sessions.destroyAll()
  app.quit()
})
