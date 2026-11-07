import { app, BrowserWindow, dialog, ipcMain, net, protocol, screen, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { KeeperClient } from './KeeperClient'
import { COPYOVER_PROTOCOL, COPYOVER_LIMIT } from '../shared/copyover'
import { ProfileStore } from './ProfileStore'
import { MudDirectory } from './MudDirectory'
import { SettingsStore } from './SettingsStore'
import { LogWriter } from './LogWriter'
import { AgentBridge } from './AgentBridge'
import { SessionWindows, type WindowResult } from './SessionWindows'
import type { AgentLine, AgentSendResult, AgentSessionInfo } from '../shared/agent'
import { MapStore } from './MapStore'
import { WorldLibrary } from './WorldLibrary'
import { HistoryStore } from './HistoryStore'
import type { HistoryMeta, HistoryQuery } from '../shared/history'
import { atomicWrite, slugify } from './storage'
import { isOwnPage } from './navigation'
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

/** Which window shows which session; set up once the app is ready. */
let sessionWindows: SessionWindows | null = null
const keeperRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked/out/keeper') : path.join(__dirname, '../keeper')
const sessions = new KeeperClient(app.getPath('userData'),
  path.join(keeperRoot, process.platform === 'win32' ? 'WayfarerConnection.exe' : 'wayfarer-connection'),
  path.join(keeperRoot, 'keeper.cjs'), app.getVersion(),
  (id, event) => {
    if (sessionWindows) sessionWindows.deliver(id, event)
    else mainWindow?.webContents.send('session:event', id, event)
  })
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
    const ownPage = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href
    if (!isOwnPage(url, ownPage, process.env.ELECTRON_RENDERER_URL)) event.preventDefault()
  })
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
  sessionWindows?.registerMain(mainWindow)

  mainWindow.on('closed', () => {
    mainWindow = null
    // Map windows belong to this client window. Leaving them open would
    // keep sockets alive with no session renderer to receive their output.
    app.quit()
  })

  guardNavigation(mainWindow)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

/** A window a session was moved to. Same client; it starts out waiting for the session. */
function createSessionWindow(bounds: Electron.Rectangle): BrowserWindow {
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    title: 'Wayfarer',
    webPreferences: rendererPreferences()
  })
  guardNavigation(win)
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL + '?detached=1')
  else win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { detached: '1' } })
  return win
}

app.whenReady().then(async () => {
  await sessions.initialize()
  const restoringCopyover = await sessions.restore()
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
  let manualUpdateCheck: Promise<string> | null = null
  // The manual check is available even when scheduled updates are disabled.
  autoUpdater.on('error', () => {}) // Request errors are returned to the button below.
  ipcMain.handle('app:check-update', () => {
    if (updateReady) return `Version ${updateReady} is ready to install.`
    if (!app.isPackaged) return 'Update checks are available in installed builds.'
    if (manualUpdateCheck) return manualUpdateCheck
    manualUpdateCheck = (async () => {
      try {
        autoUpdater.autoDownload = true
        const result = await autoUpdater.checkForUpdates()
        if (!result) return 'Unable to check for updates right now.'
        if (result.downloadPromise) {
          await result.downloadPromise
          updateReady = result.updateInfo.version
          sessionWindows?.broadcast('app:update-ready', [updateReady])
          return `Version ${updateReady} is ready to install.`
        }
        return `You are up to date (v${app.getVersion()}).`
      } catch (error) {
        return `Update check failed: ${String(error)}`
      } finally {
        manualUpdateCheck = null
      }
    })()
    return manualUpdateCheck
  })
  let preparingUpdate = false
  let prepared: ((result: { snapshot?: unknown; error?: string }) => void) | null = null
  ipcMain.handle('copyover:prepared', (event, result) => {
    if (event.sender === mainWindow?.webContents) prepared?.(result)
  })
  // After an update every session comes back in the main window; a detached
  // window opening later must not take the saved bundle.
  ipcMain.handle('copyover:restore', (e) => (e.sender === mainWindow?.webContents ? sessions.restore() : null))
  ipcMain.handle('copyover:resume', () => sessions.resume())
  ipcMain.handle('app:install-update', async () => {
    if (!updateReady) return false
    if (preparingUpdate) return false
    preparingUpdate = true
    try {
      if (sessions.count > 0) {
        // Only the main window is restored after the update.
        await sessionWindows?.dockAll()
        await sessions.pause()
        const result = await new Promise<{ snapshot?: unknown; error?: string }>((resolve, reject) => {
          const timeout = setTimeout(() => { prepared = null; reject(new Error('The client did not finish saving its sessions.')) }, 30_000)
          prepared = (value) => { clearTimeout(timeout); prepared = null; resolve(value) }
          mainWindow?.webContents.send('copyover:prepare')
        })
        if (result.error) throw new Error(result.error)
        if (!result.snapshot || Buffer.byteLength(JSON.stringify(result.snapshot)) > COPYOVER_LIMIT) {
          throw new Error('The session snapshot is too large to preserve. Close sessions before installing this update.')
        }
        await sessions.checkpoint({ protocol: COPYOVER_PROTOCOL, snapshot: result.snapshot })
        sessions.preserve()
      }
    // isSilent=true, isForceRunAfter=true: reinstall and come straight back.
      autoUpdater.quitAndInstall(true, true)
      return true
    } catch (error) {
      mainWindow?.webContents.send('copyover:cancel')
      await sessions.resume().catch(() => {})
      dialog.showErrorBox('Update paused — sessions are still open', String(error))
      return false
    } finally { preparingUpdate = false }
  })
  ipcMain.handle('app:open-updater-log', async () => {
    if (!updaterLogPath || !fs.existsSync(updaterLogPath)) return false
    await shell.openPath(updaterLogPath)
    return true
  })

  ipcMain.handle('session:connect', (e, opts: ConnectOptions) =>
    sessionWindows!.connect(e.sender, opts, () => sessions.connect(opts))
  )
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

  // ---- Session windows: tabs can move to windows of their own --------------
  sessionWindows = new SessionWindows({
    createWindow: createSessionWindow,
    sessions: () => sessions.list(),
    disconnect: (id) => closeSession(id),
    onOwnerChange: (id, owner) => {
      if (agentOwners.has(id)) agentOwners.set(id, owner)
      refreshThrottling()
    },
    // An update in progress counts: its connections are being carried over.
    isQuitting: () => quitting || sessions.isPreserving
  })
  ipcMain.on('windows:ready', (e) => sessionWindows?.markReady(e.sender))
  ipcMain.on(
    'windows:reply',
    fenced('windows:reply', (requestId: number, result: WindowResult) => sessionWindows?.reply(requestId, result))
  )
  ipcMain.handle('windows:move', (_e, id: string, target: number | 'new') => sessionWindows!.move(id, target))
  ipcMain.handle('windows:tear-off', (_e, id: string) => sessionWindows!.tearOff(id))
  ipcMain.handle('windows:choices', (e) => sessionWindows!.choices(e.sender))

  // ---- Agent control (#agent on): a local program drives one session ------
  const agentOwners = new Map<string, Electron.WebContents>()
  const agentReplies = new Map<number, (result: AgentSendResult) => void>()
  let agentRequest = 0
  const agent = new AgentBridge(
    app.getPath('userData'),
    (sessionId, text) => {
      const owner = agentOwners.get(sessionId)
      if (!owner || owner.isDestroyed()) return Promise.resolve({ ok: false, error: 'That session is gone.' })
      const requestId = ++agentRequest
      return new Promise<AgentSendResult>((resolve) => {
        const timer = setTimeout(() => {
          agentReplies.delete(requestId)
          resolve({ ok: false, error: 'Wayfarer did not answer.' })
        }, 5000)
        agentReplies.set(requestId, (result) => {
          clearTimeout(timer)
          resolve(result)
        })
        owner.send('agent:send', requestId, sessionId, text)
      })
    },
    () => refreshThrottling()
  )
  /** Chromium slows timers in a hidden or covered window. An agent plays with
   *  Wayfarer in the background, so its window keeps the mapper and timers at speed. */
  const refreshThrottling = (): void => {
    const playing = new Set(agentOwners.values())
    for (const win of sessionWindows?.all() ?? []) win.webContents.setBackgroundThrottling(!playing.has(win.webContents))
  }
  const watchedOwners = new WeakSet<Electron.WebContents>()
  ipcMain.handle('agent:enable', async (e, sessionId: string, info: AgentSessionInfo) => {
    const owner = e.sender
    agentOwners.set(sessionId, owner)
    if (!watchedOwners.has(owner)) {
      watchedOwners.add(owner)
      // A reload or a crash takes that window's sessions with it: leave no
      // ghost sessions the agent could still name.
      const forget = (): void => {
        for (const [id, wc] of [...agentOwners]) {
          if (wc !== owner) continue
          agentOwners.delete(id)
          void agent.disable(id)
        }
        refreshThrottling()
      }
      owner.on('did-navigate', forget)
      owner.on('render-process-gone', forget)
      owner.once('destroyed', forget)
    }
    const result = await agent.enable(sessionId, info)
    refreshThrottling()
    return result
  })
  ipcMain.handle('agent:disable', async (_e, sessionId: string) => {
    agentOwners.delete(sessionId)
    await agent.disable(sessionId)
    refreshThrottling()
  })
  ipcMain.on('agent:line', fenced('agent:line', (sessionId: string, line: AgentLine) => agent.line(sessionId, line)))
  ipcMain.on('agent:prompt', fenced('agent:prompt', (sessionId: string, text: string) => agent.prompt(sessionId, text)))
  ipcMain.on(
    'agent:sent',
    fenced('agent:sent', (requestId: number, result: AgentSendResult) => {
      agentReplies.get(requestId)?.(result)
      agentReplies.delete(requestId)
    })
  )
  app.on('before-quit', () => void agent.disableAll())

  /** End a session for good: its connection, log, agent control and map windows. */
  const closeSession = async (id: string): Promise<void> => {
    await sessions.disconnect(id)
    logs.stop(id)
    agentOwners.delete(id)
    await agent.disable(id)
    refreshThrottling()
    for (const win of popouts.get(id) ?? []) {
      if (!win.isDestroyed()) win.close()
    }
    popouts.delete(id)
    sessionWindows?.release(id)
  }
  ipcMain.handle('session:disconnect', (_e, id: string) => closeSession(id))
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
  ipcMain.handle('settings:save', (e, profileId: string | null, set: SettingsSet) => {
    const saved = settings.save(profileId, set)
    // Every window caches settings, and a stale copy would be saved back
    // over this one the next time that window persisted a variable.
    sessionWindows?.broadcast('settings:changed', [profileId, saved], e.sender)
    return saved
  })

  const logs = new LogWriter(app.getPath('userData'))
  ipcMain.handle('log:start', (_e, sessionId: string, name: string) => logs.start(sessionId, name))
  ipcMain.handle('log:stop', (_e, sessionId: string) => logs.stop(sessionId))
  ipcMain.on('log:line', fenced('log:line', (sessionId: string, text: string, meta?: HistoryMeta) => logs.line(sessionId, text, meta)))
  const history = new HistoryStore(logs.logsDir)
  let searching = false
  ipcMain.handle('history:search', async (_e, query: HistoryQuery) => {
    if (searching) throw new Error('A history search is already running')
    searching = true
    try { return await history.search(query) } finally { searching = false }
  })
  ipcMain.handle('history:context', (_e, file: string, line: number) => history.context(file, line))
  ipcMain.handle('log:openFolder', () => shell.openPath(logs.logsDir))
  app.on('before-quit', () => logs.stopAll())
  // Closing a pop-out is the user forgetting it; closing because the app is
  // quitting must NOT be, or a map left open on a second monitor comes back
  // closed next launch.
  let quitting = false
  let connectionsClosed = false
  app.on('before-quit', (event) => {
    if (connectionsClosed || sessions.isPreserving) return
    event.preventDefault()
    connectionsClosed = true
    void sessions.shutdown().catch(() => {}).finally(() => app.quit())
  })
  app.on('before-quit', () => {
    quitting = true
  })

  // ---- Mapper: storage + pop-out windows with a state mirror --------------
  const maps = new MapStore(app.getPath('userData'), profileName)
  const worlds = new WorldLibrary(app.getPath('userData'), profiles, settings, maps, (id) => sessions.hasProfile(id))
  ipcMain.handle('worlds:export', async (_e, id: string) => {
    const bundle = worlds.bundle(id)
    const result = await dialog.showSaveDialog({ title: 'Export world', defaultPath: `${slugify(bundle.profile.name) || 'world'}.wayfarer.json`,
      filters: [{ name: 'Wayfarer world', extensions: ['json'] }] })
    if (result.canceled || !result.filePath) return false
    atomicWrite(result.filePath, JSON.stringify(bundle, null, 2))
    return true
  })
  ipcMain.handle('worlds:choose-import', async () => {
    const result = await dialog.showOpenDialog({ title: 'Import world', properties: ['openFile'], filters: [{ name: 'Wayfarer world', extensions: ['json'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    return worlds.preview(worlds.read(result.filePaths[0]), path.basename(result.filePaths[0]))
  })
  ipcMain.handle('worlds:backups', () => worlds.backups())
  ipcMain.handle('worlds:preview-backup', (_e, id: string) => worlds.previewBackup(id))
  ipcMain.handle('worlds:import', async (e, token: string, replaceId: string | null) => {
    const profile = await worlds.import(token, replaceId)
    // Other windows may still hold the old map and settings in memory.
    sessionWindows?.broadcast('worlds:replaced', [profile.id], e.sender)
    return profile
  })
  ipcMain.handle('worlds:snapshot', (_e, id: string) => worlds.snapshot(id))
  ipcMain.handle('map:load', (_e, key: string) => maps.load(key))
  ipcMain.handle('map:persist', (_e, key: string, map: unknown) => maps.save(key, map))
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

  /** The renderer showing a session: its pop-outs' hellos, actions and bounds go there. */
  const sessionContents = (sessionId: string): Electron.WebContents | null =>
    sessionWindows?.contentsFor(sessionId) ?? mainWindow?.webContents ?? null
  const reportBounds = (sessionId: string, bounds: PopoutBounds | null): void => {
    sessionContents(sessionId)?.send('map:popout-bounds', sessionId, bounds)
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
      sessionContents(sessionId)?.send('map:mirror-hello', sessionId)
    })
  )
  ipcMain.on(
    'map:mirror-action',
    fenced('map:mirror-action', (sessionId: string, action: unknown) => {
      sessionContents(sessionId)?.send('map:mirror-action', sessionId, action)
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
      sessionWindows?.broadcast('app:update-ready', [info.version])
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

    const installing = restoringCopyover ? false : await updateBeforeLaunch()
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
