import React, { useCallback, useEffect, useState } from 'react'
import { SessionStore, sessionStores } from './SessionStore'
import { SessionView } from './components/SessionView'
import { ConnectScreen } from './components/ConnectScreen'
import { SettingsPanel } from './components/SettingsPanel'
import { HelpPanel } from './components/HelpPanel'
import { uiState } from './uiState'
import type { Encoding } from '../../shared/types'
import type { PopoutBounds } from './map/types.ts'

interface TabInfo {
  id: string
  name: string
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
  const [settingsFor, setSettingsFor] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [, forceRender] = useState(0)

  useEffect(() => {
    uiState.modalOpen = settingsFor !== null || helpOpen
  }, [settingsFor, helpOpen])

  useEffect(() => {
    uiState.openHelp = () => setHelpOpen(true)
    return () => {
      uiState.openHelp = undefined
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
    return () => {
      off()
      offHello()
      offAction()
      offBounds()
    }
  }, [])

  const connect = useCallback(async (opts: ConnectRequest) => {
    const id = await window.mud.connect(opts)
    const store = new SessionStore(id, opts.name, opts.host, opts.port, opts.profileId)
    // The tab label grows a character name once the MUD tells us one (GMCP).
    store.onCharName = () => forceRender((n) => n + 1)
    sessionStores.set(id, store)
    setTabs((t) => [...t, { id, name: opts.name }])
    setActiveId(id)
  }, [])

  const closeTab = useCallback(async (id: string) => {
    sessionStores.get(id)?.dispose()
    await window.mud.disconnect(id)
    sessionStores.delete(id)
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

  return (
    <div className="app">
      <div className="tab-bar">
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
              onClick={() => setActiveId(tab.id)}
              draggable
              onDragStart={(e) => {
                setDragId(tab.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragEnd={() => {
                setDragId(null)
                setDropAt(null)
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
              title="Drag to reorder · Ctrl+Shift+PgUp/PgDn"
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
              onOpenSettings={() => setSettingsFor(tab.id)}
              onOpenHelp={() => setHelpOpen(true)}
            />
          ) : null
        })}
        {activeId === null && (
          <ConnectScreen onConnect={connect} onOpenHelp={() => setHelpOpen(true)} />
        )}
      </div>
      {settingsStore && (
        <SettingsPanel store={settingsStore} onClose={() => setSettingsFor(null)} />
      )}
      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} />}
    </div>
  )
}
