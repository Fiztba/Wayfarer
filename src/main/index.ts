import { app, BrowserWindow, dialog, ipcMain, net, protocol, screen, shell } from 'electron'
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
/** How long to wait at startup for the update server to answer before giving
 *  up and launching. A slow or captive network must never hold the app shut. */
const STARTUP_CHECK_MS = 5000
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

/**
 * The renderer must only ever show the app's own pages. External links go to
 * the system browser; anything else that tries to take over the window (an
 * MXP <a> the sanitizer missed, a dragged-in file) is refused outright.
 */
function guardNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isOwnPage(url)) event.preventDefault()
  })
}

function isOwnPage(url: string): boolean {
  if (url.startsWith('file:')) return true
  const dev = process.env.ELECTRON_RENDERER_URL
  if (!dev) return false
  try {
    return new URL(url).origin === new URL(dev).origin
  } catch {
    return false
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

  guardNavigation(mainWindow)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  const soundsDir = path.join(app.getPath('userData'), 'sounds')
  fs.mkdirSync(soundsDir, { recursive: true })
  protocol.handle('msp-sound', (request) => {
    let rel: string
    try {
      rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '')
    } catch {
      // A stray '%' in a server-supplied file name is a bad URL, not a crash.
      return new Response('', { status: 404 })
    }
    const resolved = path.normalize(path.join(soundsDir, rel))
    if (!resolved.startsWith(soundsDir + path.sep) || !fs.existsSync(resolved)) {
      return new Response('', { status: 404 })
    }
    return net.fetch(pathToFileURL(resolved).toString())
  })

  profiles = new ProfileStore(app.getPath('userData'))
  // Profile names label the map and settings files. Cached briefly: maps save
  // on a debounce while walking, and re-reading every profile each time would
  // mean a directory scan a second.
  let nameCache: { at: number; names: Map<string, string> } | null = null
  const profileName = (id: string): string | undefined => {
    const now = Date.now()
    if (!nameCache || now - nameCache.at > 5000) {
      nameCache = { at: now, names: new Map(profiles.list().map((p) => [p.id, p.name])) }
    }
    return nameCache.names.get(id)
  }
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
  // ipcMain.on handlers have nobody to reject to: a throw inside one is an
  // uncaught exception in the main process. Each fire-and-forget channel is
  // fenced so a bad write or a dead socket is a log line, not a crash.
  const fenced =
    (what: string, body: (...args: any[]) => void) =>
    (_e: Electron.IpcMainEvent, ...args: any[]): void => {
      try {
        body(...args)
      } catch (err) {
        console.error(`[ipc] ${what} failed: ${String(err)}`)
      }
    }
  ipcMain.on('session:send', fenced('session:send', (id: string, text: string) => sessions.send(id, text)))
  ipcMain.on(
    'session:resize',
    fenced('session:resize', (id: string, cols: number, rows: number) => sessions.resize(id, cols, rows))
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

  const settings = new SettingsStore(app.getPath('userData'), profileName)
  ipcMain.handle('settings:get', (_e, profileId: string | null) => settings.get(profileId))
  ipcMain.handle('settings:save', (_e, profileId: string | null, set: SettingsSet) =>
    settings.save(profileId, set)
  )

  const logs = new LogWriter(app.getPath('userData'))
  ipcMain.handle('log:start', (_e, sessionId: string, name: string) => logs.start(sessionId, name))
  ipcMain.handle('log:stop', (_e, sessionId: string) => logs.stop(sessionId))
  ipcMain.on('log:line', fenced('log:line', (sessionId: string, text: string) => logs.line(sessionId, text)))
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
  const maps = new MapStore(app.getPath('userData'), profileName)
  ipcMain.handle('map:load', (_e, key: string) => maps.load(key))
  ipcMain.on('map:save', fenced('map:save', (key: string, map: unknown) => maps.save(key, map)))

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
    guardNavigation(win)
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
  ipcMain.on(
    'map:mirror-state',
    fenced('map:mirror-state', (sessionId: string, state: unknown) => {
      for (const win of popouts.get(sessionId) ?? []) {
        if (!win.isDestroyed()) win.webContents.send('map:mirror-state', sessionId, state)
      }
    })
  )
  // Pop-out → session renderer (hello requests + user actions).
  ipcMain.on(
    'map:mirror-hello',
    fenced('map:mirror-hello', (sessionId: string) => {
      mainWindow?.webContents.send('map:mirror-hello', sessionId)
    })
  )
  ipcMain.on(
    'map:mirror-action',
    fenced('map:mirror-action', (sessionId: string, action: unknown) => {
      mainWindow?.webContents.send('map:mirror-action', sessionId, action)
    })
  )

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // ---- Auto-update: newest GitHub Release -------------------------------
  // An update found at startup is installed BEFORE anything is shown, so the
  // window you end up looking at is already the new version and no second
  // launch is needed. While the app is running, a later find still downloads
  // in the background and installs on quit, so a live session is never
  // interrupted; failures (offline, rate-limit) just wait for the next poll.
  const updatesWanted = settings.get(null).options.autoUpdate !== false
  if (app.isPackaged && updatesWanted) {
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

    // Driven by hand rather than checkForUpdatesAndNotify, so the download can
    // be held until we know whether this is the startup pass.
    autoUpdater.autoDownload = false

    /** A small window, shown only once a download actually starts. Nothing is
     *  displayed for the common case of "already current", so a normal launch
     *  is not slowed by a progress bar nobody needed to see. Closing it skips
     *  the wait and starts the version already installed. */
    const showProgress = (version: string): BrowserWindow => {
      const win = new BrowserWindow({
        width: 380,
        height: 150,
        resizable: false,
        minimizable: false,
        maximizable: false,
        backgroundColor: '#0d1117',
        title: 'Wayfarer',
        autoHideMenuBar: true
      })
      const body = `<!doctype html><meta charset="utf-8"><body style="margin:0;font:13px system-ui,sans-serif;color:#c8ccd4;background:#0d1117;display:flex;flex-direction:column;justify-content:center;padding:0 22px"><div style="font-size:15px;margin-bottom:10px">Updating to ${version}</div><div id="s">Starting the download…</div><div style="margin-top:12px;height:6px;background:#1c2128;border-radius:3px;overflow:hidden"><div id="b" style="height:100%;width:0;background:#61afef"></div></div><div style="margin-top:12px;color:#8b949e">Close this window to start Wayfarer without updating.</div></body>`
      void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(body))
      return win
    }

    /**
     * Resolves true when an update is being installed, in which case the
     * caller must not open a window -- the app is about to restart into the
     * new version. Everything else resolves false and launches as normal:
     * offline, rate-limited, already current, or simply too slow to be worth
     * making someone wait for.
     */
    const updateBeforeLaunch = (): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        let settled = false
        // Every listener below is unhooked the moment the startup pass settles.
        // Left in place, an 'update-available' from a later background check
        // (or from a startup check that answered after the patience timer)
        // would open the progress window over a live session and quit-and-
        // install on top of it. The handlers refer to one another, so they
        // are function declarations: hoisted, and never used before defined.
        const patience = setTimeout(() => {
          log('[startup] no answer in time — launching')
          finish(false)
        }, STARTUP_CHECK_MS)
        function finish(installing: boolean): void {
          if (settled) return
          settled = true
          clearTimeout(patience)
          autoUpdater.off('update-not-available', onNone)
          autoUpdater.off('error', onNone)
          autoUpdater.off('update-available', onAvailable)
          resolve(installing)
        }
        function onNone(): void {
          finish(false)
        }
        function onAvailable(info: { version: string }): void {
          if (settled) return
          clearTimeout(patience)
          log('[startup] installing', info.version, 'before launch')
          const win = showProgress(info.version)
          const onProgress = (p: { percent: number }): void => {
            if (win.isDestroyed()) return
            const pct = Math.round(p.percent)
            void win.webContents.executeJavaScript(
              `{const s=document.getElementById('s'),b=document.getElementById('b');` +
                `if(s)s.textContent='Downloading… ${pct}%';if(b)b.style.width='${pct}%';}`
            )
          }
          const onClosed = (): void => {
            autoUpdater.off('download-progress', onProgress)
            log('[startup] skipped by the user')
            finish(false)
          }
          // Taking the window down ourselves must not read as the user
          // skipping, so the closed handler comes off before destroy().
          const dismiss = (): void => {
            autoUpdater.off('download-progress', onProgress)
            win.off('closed', onClosed)
            if (!win.isDestroyed()) win.destroy()
          }
          win.on('closed', onClosed)
          autoUpdater.on('download-progress', onProgress)
          autoUpdater.once('update-downloaded', () => {
            if (settled) return
            dismiss()
            autoUpdater.quitAndInstall(true, true)
            finish(true)
          })
          autoUpdater.downloadUpdate().catch((err) => {
            log('[startup] download failed', String(err))
            dismiss()
            finish(false)
          })
        }

        autoUpdater.once('update-not-available', onNone)
        autoUpdater.once('error', onNone)
        autoUpdater.once('update-available', onAvailable)
        autoUpdater.checkForUpdates().catch((err) => {
          clearTimeout(patience)
          log('[startup] check failed', String(err))
          finish(false)
        })
      })

    const installing = await updateBeforeLaunch()
    if (installing) return // the app is restarting into the new version
    createWindow()

    // From here on an update is a background matter: download it and let it
    // install on quit rather than interrupting a session in progress.
    autoUpdater.autoDownload = true
    setInterval(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {})
    }, 4 * 60 * 60 * 1000)
  } else {
    if (app.isPackaged) {
      // Say so once, so a build that never updates is never a mystery.
      updaterLogPath = path.join(app.getPath('userData'), 'updater.log')
    }
    createWindow()
  }
}).catch((err) => {
  // An unhandled rejection here would leave a process running with no window
  // and no explanation.
  dialog.showErrorBox('Wayfarer failed to start', String(err))
  app.quit()
})

app.on('window-all-closed', () => {
  sessions.destroyAll()
  app.quit()
})
