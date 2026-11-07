import React, { useCallback, useEffect, useRef, useState } from 'react'
import { SessionStore, sessionStores, forgetWorldMap } from './SessionStore'
import { SessionView } from './components/SessionView'
import { ClampedMenu } from './components/ClampedMenu'
import { ConnectScreen } from './components/ConnectScreen'
import { SettingsPanel } from './components/SettingsPanel'
import { HelpPanel } from './components/HelpPanel'
import { WorldTools } from './components/WorldTools'
import { HistorySearch } from './components/HistorySearch'
import { uiState } from './uiState'
import { settingsManager } from './SettingsManager'
import type { Encoding } from '../../shared/types'
import type { PopoutBounds } from './map/types.ts'
import { COPYOVER_PROTOCOL } from '../../shared/copyover'
import type { WindowChoice } from '../../shared/windows'

interface TabInfo {
  id: string
  name: string
}

/** A window a session was moved to: it opens waiting for that session. */
const detachedWindow = new URLSearchParams(window.location.search).has('detached')

/** What travels with a session moving to another window. */
interface MovedSession {
  id: string
  name: string
  snapshot: Awaited<ReturnType<SessionStore['snapshot']>>
  logPath: string | null
  agent: boolean
}

/** The last tab on a world left this window: another window may own its map from now on. */
function forgetMapIfUnused(key: string): void {
  if (![...sessionStores.values()].some((s) => s.mapKey === key)) forgetWorldMap(key)
}

export interface ConnectRequest {
  host: string
  port: number
  tls: boolean
  encoding: Encoding
  name: string
  profileId?: string
}

export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null) // null → connect screen
  const [copying, setCopying] = useState(true)
  const [restoreError, setRestoreError] = useState('')
  const restoring = useRef(false)
  const [settingsFor, setSettingsFor] = useState<string | null>(null)
  /** A line of output to build a trigger from, when Settings was opened for that. */
  const [settingsSeedLine, setSettingsSeedLine] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [tool, setTool] = useState<'worlds' | 'history' | null>(null)
  const [worldRevision, setWorldRevision] = useState(0)
  const closeTool = () => { setTool(null); setWorldRevision((n) => n + 1); setFocusTick((n) => n + 1) }
  const [, forceRender] = useState(0)
  // Bumped whenever a modal closes; the active SessionView refocuses its
  // command line on the change so the keyboard goes back where it was.
  const [focusTick, setFocusTick] = useState(0)
  const closeSettings = useCallback(() => {
    setSettingsFor(null)
    setSettingsSeedLine(null)
    setFocusTick((n) => n + 1)
  }, [])
  const closeHelp = useCallback(() => {
    setHelpOpen(false)
    setFocusTick((n) => n + 1)
  }, [])

  useEffect(() => {
    uiState.modalOpen = settingsFor !== null || helpOpen || tool !== null
  }, [settingsFor, helpOpen, tool])

  useEffect(() => {
    uiState.openHelp = () => setHelpOpen(true)
    uiState.openTriggerFromLine = (sessionId, line) => {
      setSettingsSeedLine(line)
      setSettingsFor(sessionId)
    }
    return () => {
      uiState.openHelp = undefined
      uiState.openTriggerFromLine = undefined
    }
  }, [])

  // Route all session events from the main process into their stores.
  useEffect(() => {
    const off = window.mud.onSessionEvent((id, event) => {
      const store = sessionStores.get(id)
      if (store) {
        store.handleEvent(event)
        // Status changes affect tab dots; cheap re-render.
        if (event.type === 'connected' || event.type === 'disconnected') {
          forceRender((n) => n + 1)
        }
      }
    })
    // Map pop-out windows: answer their hellos and apply their actions.
    const offHello = window.mud.map.onHello((id) => sessionStores.get(id)?.mirrorHello())
    const offAction = window.mud.map.onAction((id, action) =>
      sessionStores.get(id)?.applyMapAction(action)
    )
    const offBounds = window.mud.map.onPopoutBounds((id, bounds) =>
      sessionStores.get(id)?.notePopoutBounds(bounds as PopoutBounds | null)
    )
    // Agent control: run a local program's command in its session, as typed.
    const offAgent = window.mud.agent.onSend((requestId, id, text) => {
      const store = sessionStores.get(id)
      window.mud.agent.sent(requestId, store ? store.agentSend(text) : { ok: false, error: 'That session is gone.' })
    })
    return () => {
      off()
      offHello()
      offAction()
      offBounds()
      offAgent()
    }
  }, [])

  const connect = useCallback(async (opts: ConnectRequest) => {
    // Have triggers, timers and startup scripts ready before any server text.
    await settingsManager.ensure(opts.profileId)
    const id = await window.mud.connect(opts)
    const store = new SessionStore(id, opts.name, opts.host, opts.port, opts.profileId)
    // The tab label grows a character name once the MUD tells us one (GMCP).
    store.onCharName = () => forceRender((n) => n + 1)
    sessionStores.set(id, store)
    setTabs((t) => [...t, { id, name: opts.name }])
    setActiveId(id)
    await store.ready
    await window.mud.copyover.resume()
  }, [])

  useEffect(() => {
    const off = window.mud.copyover.onPrepare(() => {
      setCopying(true)
      void (async () => {
        try {
          const stores = tabs.map((tab) => sessionStores.get(tab.id)).filter((s): s is SessionStore => !!s)
          for (const store of stores) store.scripts.snapshot()
          const saved = []
          for (const store of stores) saved.push(await store.snapshot())
          await window.mud.copyover.prepared({ snapshot: { tabs, activeId, stores: saved } })
        } catch (error) { await window.mud.copyover.prepared({ error: String(error) }) }
      })()
    })
    const cancel = window.mud.copyover.onCancel(() => {
      for (const store of sessionStores.values()) store.resumeCopyover()
      setCopying(false)
    })
    return () => { off(); cancel() }
  }, [tabs, activeId])

  useEffect(() => {
    if (restoring.current) return // StrictMode must not restore or replay twice.
    restoring.current = true
    if (detachedWindow) {
      // Updates restore into the main window only.
      setCopying(false)
      return
    }
    void (async () => {
      const bundle = await window.mud.copyover.restore()
      if (!bundle) { setCopying(false); return }
      setCopying(true)
      if (bundle.protocol !== COPYOVER_PROTOCOL) throw new Error('This build cannot restore the saved session format.')
      const saved = bundle.snapshot as { tabs: TabInfo[]; activeId: string | null;
        stores: Awaited<ReturnType<SessionStore['snapshot']>>[] }
      for (const snapshot of saved.stores) {
        const data = snapshot.state
        await settingsManager.ensure(data.profileId as string | null)
        const store = new SessionStore(snapshot.id, data.name as string, data.host as string,
          data.port as number, (data.profileId as string) ?? undefined)
        store.onCharName = () => forceRender((n) => n + 1)
        await store.restore(snapshot)
        sessionStores.set(store.id, store)
      }
      setTabs(saved.tabs); setActiveId(saved.activeId)
      for (const store of sessionStores.values()) store.resumeCopyover()
      await window.mud.copyover.resume()
      setCopying(false)
    })().catch((error) => { setCopying(false); setRestoreError(String(error)) })
  }, [])

  const removeTab = useCallback((id: string) => {
    setSettingsFor((cur) => (cur === id ? null : cur))
    setTabs((t) => {
      const next = t.filter((tab) => tab.id !== id)
      setActiveId((cur) => {
        if (cur !== id) return cur
        return next.length > 0 ? next[next.length - 1].id : null
      })
      return next
    })
  }, [])

  const closeTab = useCallback(async (id: string) => {
    const store = sessionStores.get(id)
    store?.dispose()
    await window.mud.disconnect(id)
    sessionStores.delete(id)
    if (store) forgetMapIfUnused(store.mapKey)
    removeTab(id)
  }, [removeTab])

  // ---- Sessions moving between windows. Main asks the window that has a
  // session to let go of it (export), then the one it is moving to to take
  // it (adopt); the session's events wait in main meanwhile.
  useEffect(() => {
    const offExport = window.mud.windows.onExport((requestId, id) => {
      const store = sessionStores.get(id)
      if (!store) {
        window.mud.windows.reply(requestId, { ok: false, error: 'That session is not in this window.' })
        return
      }
      void (async () => {
        let snapshot: MovedSession['snapshot']
        try {
          snapshot = await store.snapshot()
        } catch (err) {
          store.resumeCopyover()
          window.mud.windows.reply(requestId, { ok: false, error: err instanceof Error ? err.message : String(err) })
          return
        }
        const moved: MovedSession = { id, name: store.name, snapshot, logPath: store.logPath, agent: store.agent }
        sessionStores.delete(id)
        store.dispose({ moved: true })
        forgetMapIfUnused(store.mapKey)
        removeTab(id)
        window.mud.windows.reply(requestId, { ok: true, value: moved })
      })()
    })
    const offAdopt = window.mud.windows.onAdopt((requestId, value) => {
      void (async () => {
        try {
          const moved = value as MovedSession
          const data = moved.snapshot.state
          await settingsManager.ensure((data.profileId as string | null) ?? null)
          const store = new SessionStore(moved.id, data.name as string, data.host as string,
            data.port as number, (data.profileId as string) ?? undefined)
          store.onCharName = () => forceRender((n) => n + 1)
          await store.restore(moved.snapshot, { moved: { logPath: moved.logPath } })
          sessionStores.set(store.id, store)
          setTabs((t) => (t.some((tab) => tab.id === store.id) ? t : [...t, { id: store.id, name: moved.name }]))
          setActiveId(store.id)
          store.resumeCopyover()
          if (moved.agent) store.resumeAgent()
          store.mirrorHello()
          window.mud.windows.reply(requestId, { ok: true })
        } catch (err) {
          window.mud.windows.reply(requestId, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })()
    })
    const offReplaced = window.mud.worlds.onReplaced((profileId) => {
      forgetWorldMap(profileId)
      if (settingsManager.isLoaded(profileId)) void settingsManager.reload(profileId)
    })
    window.mud.windows.ready()
    return () => {
      offExport()
      offAdopt()
      offReplaced()
    }
  }, [removeTab])

  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number; choices: WindowChoice[] } | null>(null)
  useEffect(() => {
    if (!tabMenu) return
    const close = (): void => setTabMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', close)
    }
  }, [tabMenu])

  const reportMoveFailure = (id: string, result: { ok: boolean; error?: string }): void => {
    if (!result.ok) sessionStores.get(id)?.addSystemLine(`Could not move this session: ${result.error}`, 'error')
  }
  const moveSession = useCallback((id: string, target: number | 'new') => {
    setTabMenu(null)
    void window.mud.windows.move(id, target).then((result) => reportMoveFailure(id, result))
  }, [])

  // The taskbar tells windows apart by title.
  useEffect(() => {
    const tab = tabs.find((t) => t.id === activeId)
    document.title = tab ? `${tab.name} — Wayfarer` : 'Wayfarer'
  }, [tabs, activeId])

  const settingsStore = settingsFor ? sessionStores.get(settingsFor) : undefined

  // ---- Tab reordering: drag a tab onto another to move it there; the drop
  // indicator shows which side it will land on. Ctrl+Shift+PgUp/PgDn moves
  // the active tab by keyboard.
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null)

  const moveTab = useCallback((id: string, toIndex: number) => {
    setTabs((t) => {
      const from = t.findIndex((tab) => tab.id === id)
      if (from < 0) return t
      const next = [...t]
      const [moved] = next.splice(from, 1)
      const clamped = Math.max(0, Math.min(toIndex, next.length))
      next.splice(clamped, 0, moved)
      return next
    })
  }, [])

  const dropTab = useCallback(
    (targetId: string, after: boolean) => {
      if (!dragId || dragId === targetId) return
      const targetIdx = tabs.findIndex((tab) => tab.id === targetId)
      const fromIdx = tabs.findIndex((tab) => tab.id === dragId)
      if (targetIdx < 0 || fromIdx < 0) return
      // Index in the array AFTER removing the dragged tab.
      let to = after ? targetIdx + 1 : targetIdx
      if (fromIdx < to) to -= 1
      moveTab(dragId, to)
    },
    [dragId, tabs, moveTab]
  )

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || !activeId) return
      if (e.key !== 'PageUp' && e.key !== 'PageDown') return
      if (uiState.modalOpen) return
      e.preventDefault()
      const idx = tabs.findIndex((tab) => tab.id === activeId)
      if (idx < 0) return
      moveTab(activeId, e.key === 'PageUp' ? idx - 1 : idx + 1)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeId, tabs, moveTab])

  if (restoreError) return <div className="app" role="alert">
    <p>Session restoration failed: {restoreError}. Connections are held for up to 30 minutes.</p>
    <button onClick={() => window.location.reload()}>Retry restoration</button>
  </div>

  return (
    <div className="app">
      {copying && <div role="status" style={{ position: 'fixed', inset: 0, zIndex: 10000, background: '#0d1117ee', display: 'grid', placeItems: 'center' }}>Preparing sessions — keeping existing connections open…</div>}
      <div className="tab-bar">
        <button className="tab" onClick={() => setTool('worlds')}>Worlds</button>
        <button className="tab" onClick={() => setTool('history')}>History</button>
        {tabs.map((tab) => {
          const store = sessionStores.get(tab.id)
          const dot =
            store?.status === 'connected' ? '●' : store?.status === 'connecting' ? '◌' : '○'
          const dropClass =
            dropAt?.id === tab.id ? (dropAt.after ? ' tab-drop-after' : ' tab-drop-before') : ''
          return (
            <div
              key={tab.id}
              className={`tab ${tab.id === activeId ? 'tab-active' : ''}${dragId === tab.id ? ' tab-dragging' : ''}${dropClass}`}
              data-session={tab.id}
              onClick={() => setActiveId(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                const at = { id: tab.id, x: e.clientX, y: e.clientY }
                void window.mud.windows.choices().then((choices) => setTabMenu({ ...at, choices }))
              }}
              draggable
              onDragStart={(e) => {
                setDragId(tab.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragEnd={(e) => {
                const id = tab.id
                // Let go anywhere that isn't a tab strip: main looks at where
                // the cursor is and moves the session to that window, or a new one.
                const outside = e.dataTransfer.dropEffect === 'none'
                setDragId(null)
                setDropAt(null)
                if (outside) void window.mud.windows.tearOff(id).then((result) => reportMoveFailure(id, result))
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === tab.id) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const rect = e.currentTarget.getBoundingClientRect()
                const after = e.clientX > rect.left + rect.width / 2
                if (dropAt?.id !== tab.id || dropAt.after !== after) setDropAt({ id: tab.id, after })
              }}
              onDragLeave={() => {
                if (dropAt?.id === tab.id) setDropAt(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
                dropTab(tab.id, e.clientX > rect.left + rect.width / 2)
                setDragId(null)
                setDropAt(null)
              }}
              title="Drag to reorder (Ctrl+Shift+PgUp/PgDn), or out of the window to give it a window of its own. Right-click for more."
            >
              <span className={`tab-dot dot-${store?.status ?? 'disconnected'}`}>{dot}</span>
              <span className="tab-name">
                {tab.name}
                {store?.charName && <span className="tab-char"> {store.charName}</span>}
              </span>
              <button
                className="tab-close"
                title="Close session"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                ✕
              </button>
            </div>
          )
        })}
        <button
          className={`tab tab-new ${activeId === null ? 'tab-active' : ''}`}
          title="New session"
          onClick={() => setActiveId(null)}
        >
          +
        </button>
      </div>
      <div className="content">
        {tabs.map((tab) => {
          const store = sessionStores.get(tab.id)
          return store ? (
            <SessionView
              key={tab.id}
              store={store}
              active={tab.id === activeId}
              focusTick={focusTick}
              onOpenSettings={() => setSettingsFor(tab.id)}
              onOpenHelp={() => setHelpOpen(true)}
            />
          ) : null
        })}
        {activeId === null && detachedWindow && tabs.length === 0 && (
          <div className="moving-placeholder" role="status">Bringing the session over…</div>
        )}
        {activeId === null && !(detachedWindow && tabs.length === 0) && (
          <ConnectScreen key={worldRevision} onConnect={connect} onOpenHelp={() => setHelpOpen(true)} />
        )}
      </div>
      {tabMenu && (
        <ClampedMenu x={tabMenu.x} y={tabMenu.y} className="mxp-menu" onClick={(e) => e.stopPropagation()}>
          <div className="mxp-menu-item" onClick={() => moveSession(tabMenu.id, 'new')}>
            Move to new window
          </div>
          {tabMenu.choices.map((choice) => (
            <div key={choice.id} className="mxp-menu-item" onClick={() => moveSession(tabMenu.id, choice.id)}>
              Move to {choice.label}
            </div>
          ))}
          <div
            className="mxp-menu-item"
            onClick={() => {
              const id = tabMenu.id
              setTabMenu(null)
              void closeTab(id)
            }}
          >
            Close session
          </div>
        </ClampedMenu>
      )}
      {settingsStore && (
        <SettingsPanel store={settingsStore} onClose={closeSettings} seedLine={settingsSeedLine} />
      )}
      {helpOpen && <HelpPanel onClose={closeHelp} />}
      {tool === 'worlds' && <WorldTools onClose={closeTool} />}
      {tool === 'history' && <HistorySearch onClose={closeTool} />}
    </div>
  )
}
