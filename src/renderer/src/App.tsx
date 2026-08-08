import React, { useCallback, useEffect, useState } from 'react'
import { SessionStore, sessionStores } from './SessionStore'
import { SessionView } from './components/SessionView'
import { ConnectScreen } from './components/ConnectScreen'
import { SettingsPanel } from './components/SettingsPanel'
import { HelpPanel } from './components/HelpPanel'
import { uiState } from './uiState'
import type { Encoding } from '../../shared/types'

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
    return () => {
      off()
      offHello()
      offAction()
    }
  }, [])

  const connect = useCallback(async (opts: ConnectRequest) => {
    const id = await window.mud.connect(opts)
    const store = new SessionStore(id, opts.name, opts.host, opts.port, opts.profileId)
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

  return (
    <div className="app">
      <div className="tab-bar">
        {tabs.map((tab) => {
          const store = sessionStores.get(tab.id)
          const dot =
            store?.status === 'connected' ? '●' : store?.status === 'connecting' ? '◌' : '○'
          return (
            <div
              key={tab.id}
              className={`tab ${tab.id === activeId ? 'tab-active' : ''}`}
              onClick={() => setActiveId(tab.id)}
            >
              <span className={`tab-dot dot-${store?.status ?? 'disconnected'}`}>{dot}</span>
              <span className="tab-name">{tab.name}</span>
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
