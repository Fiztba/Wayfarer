/**
 * CapturePane — tabbed windows fed by triggers ("Copy to window"), for tells,
 * channel chatter, or anything else worth reading separately from the scroll.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SessionStore } from '../SessionStore'
import { OutputLine } from './OutputLine'
import { settingsManager } from '../SettingsManager'

export function CapturePane({ store }: { store: SessionStore }) {
  const names = [...store.captureWindows.keys()]
  const [active, setActive] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  const current = active !== null && names.includes(active) ? active : names[0]
  const lines = current ? (store.captureWindows.get(current) ?? []) : []

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  })

  useEffect(() => {
    pinnedRef.current = true
  }, [current])

  if (names.length === 0) return null

  return (
    <div className="capture-pane">
      <div className="capture-tabs">
        {names.map((name) => (
          <button
            key={name}
            className={`capture-tab ${name === current ? 'capture-tab-active' : ''}`}
            onClick={() => setActive(name)}
          >
            {name}
            <span className="capture-count">{store.captureWindows.get(name)?.length ?? 0}</span>
          </button>
        ))}
        <span className="capture-actions">
          <button
            className="map-btn"
            title="Clear this window"
            onClick={() => current && store.clearCaptureWindow(current)}
          >
            🗑
          </button>
          <button className="map-btn" title="Hide capture pane" onClick={() => store.toggleCaptures()}>
            ✕
          </button>
        </span>
      </div>
      <div
        className="capture-lines"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current
          if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
        }}
      >
        {lines.slice(-500).map((line) => (
          <OutputLine
            key={line.id}
            line={line}
            showTime={settingsManager.globalOptions.showTimestamps}
            onLink={(link) => {
              if (link.url) window.open(link.url)
              else if (link.command) store.sendInput(link.command, false)
            }}
          />
        ))}
      </div>
    </div>
  )
}
