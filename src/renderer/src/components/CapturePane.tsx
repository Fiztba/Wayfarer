/**
 * CapturePane — tabbed windows fed by triggers ("Copy to window"), for tells,
 * channel chatter, or anything else worth reading separately from the scroll.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SessionStore } from '../SessionStore'
import { OutputLine, type LinkHandler } from './OutputLine'
import { settingsManager } from '../SettingsManager'

/**
 * `onLink` is the session's own MXP handler, so a link in a capture window
 * behaves exactly as it does in the main scroll (URL prefixing, prompt
 * staging into the command line, the right-click command menu) — and being
 * a stable reference it lets OutputLine's memo hold.
 */
export function CapturePane({ store, onLink }: { store: SessionStore; onLink: LinkHandler }) {
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
            onLink={onLink}
          />
        ))}
      </div>
    </div>
  )
}
