/**
 * SessionWindows — which window shows which session, and moving sessions
 * between windows.
 *
 * Every window runs the full client. A session belongs to exactly one
 * window at a time: its events go there, and its pop-out maps talk to it.
 * Moving a session is a copyover in miniature: the source window snapshots
 * and lets go of the session, main holds its events, and the target window
 * restores it from the snapshot before the held events are delivered.
 *
 * A world's tabs share one map model and one settings cache per window, so
 * one world lives in one window: two windows saving the same map would
 * overwrite each other's rooms.
 */
import { BrowserWindow, screen, type Rectangle, type WebContents } from 'electron'
import type { ConnectOptions, SessionEvent } from '../shared/types'
import type { WindowChoice, WindowResult } from '../shared/windows'
export type { WindowChoice, WindowResult }

interface Deps {
  /** Opens a detached window at these bounds (it loads with ?detached=1). */
  createWindow(bounds: Rectangle): BrowserWindow
  /** Every live session and how it was opened. */
  sessions(): Array<[string, ConnectOptions]>
  disconnect(id: string): Promise<void>
  /** A session now lives in another window (agent control follows it). */
  onOwnerChange(id: string, owner: WebContents): void
  isQuitting(): boolean
}

const REPLY_MS = 15_000

/** Same key the renderer's SessionStore uses for the map it loads. */
export const mapKeyOf = (opts: ConnectOptions): string => opts.profileId ?? `adhoc_${opts.host}_${opts.port}`

export class SessionWindows {
  private main: BrowserWindow | null = null
  private windows = new Map<number, BrowserWindow>()
  private ready = new Set<number>()
  private readyWaiters = new Map<number, Array<() => void>>()
  private owners = new Map<string, BrowserWindow>()
  private moving = new Set<string>()
  /** Events held while a session is between windows, or before its window is known. */
  private held = new Map<string, SessionEvent[]>()
  private connecting = 0
  private replies = new Map<number, (result: WindowResult) => void>()
  private nextRequest = 0
  private readonly deps: Deps

  constructor(deps: Deps) {
    this.deps = deps
  }

  /** The main window; sessions that already exist (restored after an update) live there. */
  registerMain(win: BrowserWindow): void {
    this.main = win
    this.track(win)
    for (const [id] of this.deps.sessions()) if (!this.owners.has(id)) this.owners.set(id, win)
  }

  /** Session windows (not map pop-outs). */
  all(): BrowserWindow[] {
    return [...this.windows.values()].filter((w) => !w.isDestroyed())
  }

  // ---- routing ------------------------------------------------------------

  deliver(id: string, event: SessionEvent): void {
    const held = this.held.get(id)
    if (held) {
      held.push(event)
      return
    }
    if (!this.owners.has(id) && this.connecting > 0) {
      // A connect is still returning its id to the window that asked; its
      // first events must not land in the main window by default.
      this.held.set(id, [event])
      return
    }
    this.contentsFor(id)?.send('session:event', id, event)
  }

  /** The renderer that owns a session: where its events and pop-out traffic go. */
  contentsFor(id: string): WebContents | null {
    const win = this.owners.get(id) ?? this.main
    return win && !win.isDestroyed() ? win.webContents : null
  }

  /** Open a connection for a window, refusing a world that is open in another window. */
  async connect(from: WebContents, opts: ConnectOptions, open: () => Promise<string>): Promise<string> {
    const win = this.windowOf(from) ?? this.main
    const key = mapKeyOf(opts)
    for (const [id, other] of this.deps.sessions()) {
      const owner = this.owners.get(id)
      if (mapKeyOf(other) === key && owner && owner !== win && !owner.isDestroyed()) {
        throw new Error(
          `${other.name || opts.name || 'That world'} is already open in another window, and its tabs share one map there. ` +
            'Connect from that window, or give this character its own profile.'
        )
      }
    }
    this.connecting++
    try {
      const id = await open()
      if (win) this.owners.set(id, win)
      return id
    } finally {
      this.connecting--
      this.releaseEarly()
    }
  }

  /** The session ended (its tab closed). A detached window left empty closes. */
  release(id: string): void {
    const owner = this.owners.get(id)
    this.owners.delete(id)
    this.held.delete(id)
    if (owner) this.closeIfEmpty(owner)
  }

  // ---- windows ------------------------------------------------------------

  /** Other windows a session could move to, for the tab menu. */
  choices(from: WebContents): WindowChoice[] {
    const here = this.windowOf(from)
    const names = new Map<BrowserWindow, string[]>()
    for (const [id, opts] of this.deps.sessions()) {
      const owner = this.owners.get(id)
      if (owner) names.set(owner, [...(names.get(owner) ?? []), opts.name || opts.host])
    }
    return this.all()
      .filter((w) => w !== here)
      .map((w) => {
        const tabs = names.get(w) ?? []
        const label = w === this.main ? `Main window${tabs.length ? ` (${tabs.join(', ')})` : ''}` : tabs.join(', ') || 'Window'
        return { id: w.id, label, main: w === this.main }
      })
  }

  /** A tab was dragged and let go outside any tab strip. */
  async tearOff(id: string): Promise<WindowResult> {
    const source = this.owners.get(id)
    if (!source || source.isDestroyed()) return { ok: false, error: 'That session is gone.' }
    const point = screen.getCursorScreenPoint()
    const inside = (w: BrowserWindow): boolean => {
      const b = w.getBounds()
      return point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height
    }
    if (inside(source)) return { ok: true, value: 'stayed' }
    const over = this.all().find((w) => w !== source && !w.isMinimized() && inside(w))
    return this.move(id, over ? over.id : 'new', point)
  }

  /** Move a session to another window, or to a new one ('new'). */
  async move(id: string, target: number | 'new', at?: { x: number; y: number }): Promise<WindowResult> {
    const source = this.owners.get(id)
    if (!source || source.isDestroyed()) return { ok: false, error: 'That session is gone.' }
    if (this.moving.has(id)) return { ok: false, error: 'That session is already moving.' }
    const sessions = this.deps.sessions()
    const opts = sessions.find(([sid]) => sid === id)?.[1]
    if (!opts) return { ok: false, error: 'That session is gone.' }
    const key = mapKeyOf(opts)
    const sibling = sessions.find(([sid, other]) => sid !== id && mapKeyOf(other) === key && this.owners.get(sid) === source)
    if (sibling) {
      return {
        ok: false,
        error:
          `This tab shares its map with ${sibling[1].name || 'another tab'} here, and a world's tabs stay in one window. ` +
          'Give this character its own profile to move it on its own.'
      }
    }
    let dest: BrowserWindow | undefined
    if (target === 'new') dest = this.track(this.deps.createWindow(this.boundsNear(source, at)))
    else {
      dest = this.windows.get(target)
      if (!dest || dest.isDestroyed()) return { ok: false, error: 'That window is gone.' }
      if (dest === source) return { ok: true, value: 'stayed' }
    }
    const created = target === 'new'

    this.moving.add(id)
    this.held.set(id, this.held.get(id) ?? [])
    try {
      const exported = await this.request(source, 'session:export', id)
      if (!exported.ok) {
        this.handOver(id, source)
        if (created && !dest.isDestroyed()) dest.destroy()
        return exported
      }
      const adopted: WindowResult = (await this.whenReady(dest))
        ? await this.request(dest, 'session:adopt', exported.value)
        : { ok: false, error: 'The new window did not open.' }
      if (!adopted.ok) {
        // Put it back where it was rather than lose the connection.
        const back = await this.request(source, 'session:adopt', exported.value)
        if (back.ok) this.handOver(id, source)
        else {
          this.held.delete(id)
          this.owners.delete(id)
          await this.deps.disconnect(id).catch(() => {})
        }
        if (created && !dest.isDestroyed()) dest.destroy()
        return adopted
      }
      this.handOver(id, dest)
      this.closeIfEmpty(source)
      if (!dest.isDestroyed()) dest.focus()
      return { ok: true }
    } finally {
      this.moving.delete(id)
    }
  }

  /** Before an update: every session back in the main window, the only one restored. */
  async dockAll(): Promise<void> {
    const main = this.main
    if (!main || main.isDestroyed()) return
    for (const [id] of this.deps.sessions()) {
      const owner = this.owners.get(id)
      if (!owner || owner === main) continue
      const result = await this.move(id, main.id)
      if (!result.ok) throw new Error(`Could not bring a session back to the main window: ${result.error}`)
    }
  }

  broadcast(channel: string, args: unknown[], except?: WebContents): void {
    for (const w of this.all()) if (w.webContents !== except) w.webContents.send(channel, ...args)
  }

  // ---- renderer replies ---------------------------------------------------

  markReady(contents: WebContents): void {
    const win = this.windowOf(contents)
    if (!win) return
    this.ready.add(win.id)
    for (const wake of this.readyWaiters.get(win.id) ?? []) wake()
    this.readyWaiters.delete(win.id)
  }

  reply(requestId: number, result: WindowResult): void {
    this.replies.get(requestId)?.(result)
  }

  // ---- internals ----------------------------------------------------------

  private windowOf(contents: WebContents): BrowserWindow | undefined {
    return this.all().find((w) => w.webContents === contents)
  }

  /** Once no connect is in flight, events held for want of an owner go out. */
  private releaseEarly(): void {
    if (this.connecting > 0) return
    for (const [id, events] of [...this.held.entries()]) {
      if (this.moving.has(id)) continue
      this.held.delete(id)
      for (const event of events) this.contentsFor(id)?.send('session:event', id, event)
    }
  }

  /** Make `win` the owner and deliver whatever was held meanwhile, in order. */
  private handOver(id: string, win: BrowserWindow): void {
    const before = this.owners.get(id)
    this.owners.set(id, win)
    const held = this.held.get(id) ?? []
    this.held.delete(id)
    if (!win.isDestroyed()) for (const event of held) win.webContents.send('session:event', id, event)
    if (before !== win && !win.isDestroyed()) this.deps.onOwnerChange(id, win.webContents)
  }

  private request(win: BrowserWindow, channel: string, arg: unknown): Promise<WindowResult> {
    if (win.isDestroyed()) return Promise.resolve({ ok: false, error: 'That window is gone.' })
    const requestId = ++this.nextRequest
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.replies.delete(requestId)
        resolve({ ok: false, error: 'The window did not answer.' })
      }, REPLY_MS)
      this.replies.set(requestId, (result) => {
        clearTimeout(timer)
        this.replies.delete(requestId)
        resolve(result)
      })
      win.webContents.send(channel, requestId, arg)
    })
  }

  private whenReady(win: BrowserWindow): Promise<boolean> {
    if (this.ready.has(win.id)) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), REPLY_MS)
      const wake = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      this.readyWaiters.set(win.id, [...(this.readyWaiters.get(win.id) ?? []), wake])
    })
  }

  private track(win: BrowserWindow): BrowserWindow {
    const winId = win.id
    this.windows.set(winId, win)
    // A reloaded page has lost its sessions and must say ready again.
    win.webContents.on('did-navigate', () => this.ready.delete(winId))
    if (win !== this.main) {
      win.on('close', (event) => {
        if (this.deps.isQuitting() || !this.main || this.main.isDestroyed()) return
        const mine = this.ownedBy(win)
        if (mine.length === 0) return
        // Closing a window brings its sessions back to the main window
        // instead of dropping the connections.
        event.preventDefault()
        void (async () => {
          for (const id of mine) await this.move(id, this.main!.id)
          // Anything that could not move stays put, still connected.
          if (!win.isDestroyed() && this.ownedBy(win).length === 0) win.destroy()
        })()
      })
    }
    win.on('closed', () => {
      this.windows.delete(winId)
      this.ready.delete(winId)
      this.readyWaiters.delete(winId)
      // The main window closing means Wayfarer is quitting or updating, and
      // the connections are shut down or carried across by those paths.
      if (win === this.main) return
      // A detached window that vanished with sessions still in it can't show
      // them: close them rather than leave connections open with no screen.
      for (const id of this.ownedBy(win)) {
        this.owners.delete(id)
        if (!this.deps.isQuitting()) void this.deps.disconnect(id).catch(() => {})
      }
    })
    return win
  }

  private ownedBy(win: BrowserWindow): string[] {
    return [...this.owners.entries()].filter(([, w]) => w === win).map(([id]) => id)
  }

  private closeIfEmpty(win: BrowserWindow): void {
    if (win === this.main || win.isDestroyed() || this.ownedBy(win).length > 0) return
    win.destroy()
  }

  private boundsNear(source: BrowserWindow, at?: { x: number; y: number }): Rectangle {
    const size = source.isMaximized() || source.isFullScreen() ? source.getNormalBounds() : source.getBounds()
    const anchor = at ?? { x: size.x + 48, y: size.y + 48 }
    const area = screen.getDisplayNearestPoint(anchor).workArea
    const width = Math.min(Math.max(640, size.width), area.width)
    const height = Math.min(Math.max(400, size.height), area.height)
    // A dropped tab lands under the cursor, as if the window hung from it.
    const left = at ? anchor.x - 120 : anchor.x
    const top = at ? anchor.y - 16 : anchor.y
    return {
      x: Math.round(Math.max(area.x, Math.min(left, area.x + area.width - width))),
      y: Math.round(Math.max(area.y, Math.min(top, area.y + area.height - height))),
      width,
      height
    }
  }
}
