import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import type { SessionStore, Line } from '../SessionStore'
import { keyEventSignature } from '../automation/AutomationEngine'
import { settingsManager } from '../SettingsManager'
import { uiState } from '../uiState'
import { MapPane } from './MapPane'
import { OutputLine, OutputSpan, formatTime, type LinkHandler } from './OutputLine'
import { GaugeBar } from './GaugeBar'
import { CapturePane } from './CapturePane'

/** How many lines are in the DOM while pinned to the bottom. */
const BASE_WINDOW = 1500
/** How many more lines materialize per approach to the top of the scroll. */
const WINDOW_CHUNK = 1500

/** Binary search: index of the line with id >= target (ids are ascending). */
function indexOfLineId(lines: Line[], target: number): number {
  let lo = 0
  let hi = lines.length - 1
  let ans = lines.length
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].id >= target) {
      ans = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return ans
}

export function SessionView({
  store,
  active,
  onOpenSettings,
  onOpenHelp
}: {
  store: SessionStore
  active: boolean
  onOpenSettings(): void
  onOpenHelp(): void
}) {
  useSyncExternalStore(store.subscribe, store.getVersion)

  // Re-render when app-wide options (timestamps, input behavior) change.
  const [, forceOptions] = useState(0)
  useEffect(() => settingsManager.subscribe(() => forceOptions((n) => n + 1)), [])
  const options = settingsManager.globalOptions

  const scrollRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [pinned, setPinned] = useState(true)
  const pinnedRef = useRef(true)
  // Windowed scrollback: null = pinned window (last BASE_WINDOW lines);
  // a line id = frozen window start while the user reads history.
  const [windowStartId, setWindowStartId] = useState<number | null>(null)
  const windowStartRef = useRef<number | null>(null)
  const expandRef = useRef<{ prevHeight: number } | null>(null)
  const [input, setInput] = useState('')
  const historyPos = useRef<number | null>(null)
  const draft = useRef('')
  const [mapWidth, setMapWidth] = useState(() =>
    Number(localStorage.getItem('wayfarer-map-width')) || 340
  )
  const mapDrag = useRef<{ startX: number; startW: number } | null>(null)

  // ---- Ctrl+F search over the full scrollback ----
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<number[]>([]) // line ids, oldest→newest
  const [matchIdx, setMatchIdx] = useState(0)
  const [jumpTargetId, setJumpTargetId] = useState<number | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const runSearch = useCallback(
    (q: string): number[] => {
      const needle = q.toLowerCase()
      if (needle.length === 0) return []
      const ids: number[] = []
      for (const line of store.lines) {
        const text = line.spans.map((s) => s.text).join('').toLowerCase()
        if (text.includes(needle)) ids.push(line.id)
      }
      return ids
    },
    [store]
  )

  // Debounced re-search as the query changes.
  useEffect(() => {
    if (!searchOpen) return
    const t = setTimeout(() => {
      const ids = runSearch(query)
      setMatches(ids)
      setMatchIdx(Math.max(0, ids.length - 1)) // start at the most recent hit
    }, 200)
    return () => clearTimeout(t)
  }, [query, searchOpen, runSearch])

  /** Reveal a line even if it's deep in unrendered history, then scroll to it. */
  const jumpToLine = useCallback(
    (lineId: number) => {
      const lines = store.lines
      const idx = indexOfLineId(lines, lineId)
      if (lines[idx]?.id !== lineId) return // trimmed away
      pinnedRef.current = false
      setPinned(false)
      const startIdx = Math.max(0, idx - 100)
      const currentStart =
        windowStartRef.current === null
          ? Math.max(0, lines.length - BASE_WINDOW)
          : indexOfLineId(lines, windowStartRef.current)
      if (startIdx < currentStart) {
        windowStartRef.current = lines[startIdx].id
        setWindowStartId(lines[startIdx].id)
      }
      setJumpTargetId(lineId)
    },
    [store]
  )

  useLayoutEffect(() => {
    if (jumpTargetId === null) return
    const el = scrollRef.current?.querySelector(`[data-lid="${jumpTargetId}"]`)
    if (el) {
      el.scrollIntoView({ block: 'center' })
      setJumpTargetId(null)
    }
  }, [jumpTargetId, windowStartId])

  /** delta -1 = older match, +1 = newer match (wraps). */
  const navigateSearch = useCallback(
    (delta: number) => {
      let ids = matches
      if (ids.length === 0) {
        ids = runSearch(query)
        setMatches(ids)
        if (ids.length === 0) return
        const start = Math.max(0, ids.length - 1)
        setMatchIdx(start)
        jumpToLine(ids[start])
        return
      }
      const next = (matchIdx + delta + ids.length) % ids.length
      setMatchIdx(next)
      jumpToLine(ids[next])
    },
    [matches, matchIdx, query, runSearch, jumpToLine]
  )

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    inputRef.current?.focus()
  }, [])

  /** MXP link clicked: send the command, stage it, or open the URL. */
  const handleMxpLink = useCallback<LinkHandler>(
    (link) => {
      if (link.url) {
        const url = link.url.startsWith('http') ? link.url : `https://${link.url}`
        window.open(url) // main process routes this to the system browser
        return
      }
      const command = link.command || link.textAcc?.trim()
      if (!command) return
      if (link.prompt) {
        setInput(command)
        inputRef.current?.focus()
      } else {
        store.sendInput(command, false)
      }
    },
    [store]
  )

  // Ctrl+F opens search (seeded from any selected text).
  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent) => {
      if (uiState.modalOpen) return
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        const sel = window.getSelection()?.toString().trim()
        setSearchOpen(true)
        if (sel && sel.length > 0 && sel.length < 60 && !sel.includes('\n')) setQuery(sel)
        requestAnimationFrame(() => searchInputRef.current?.select())
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active])

  const onDividerDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      mapDrag.current = { startX: e.clientX, startW: mapWidth }
      const move = (ev: MouseEvent) => {
        if (!mapDrag.current) return
        const w = Math.min(
          800,
          Math.max(200, mapDrag.current.startW + (mapDrag.current.startX - ev.clientX))
        )
        setMapWidth(w)
      }
      const up = () => {
        if (mapDrag.current) localStorage.setItem('wayfarer-map-width', String(mapWidth))
        mapDrag.current = null
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [mapWidth]
  )

  // Auto-scroll unless the user has scrolled up to read; after revealing
  // older history, keep the view anchored on what they were reading.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (expandRef.current) {
      el.scrollTop += el.scrollHeight - expandRef.current.prevHeight
      expandRef.current = null
    } else if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight
    }
  })

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8
    pinnedRef.current = atBottom
    setPinned(atBottom)
    const lines = store.lines
    if (atBottom) {
      if (windowStartRef.current !== null) {
        windowStartRef.current = null
        setWindowStartId(null)
      }
      return
    }
    // Leaving the bottom: freeze the window so appends don't shift the view.
    if (windowStartRef.current === null && lines.length > 0) {
      const first = lines[Math.max(0, lines.length - BASE_WINDOW)]
      windowStartRef.current = first.id
      setWindowStartId(first.id)
    }
    // Nearing the top: materialize an older chunk, preserving position.
    if (el.scrollTop < 600 && windowStartRef.current !== null) {
      const currentIdx = indexOfLineId(lines, windowStartRef.current)
      if (currentIdx > 0) {
        const nextIdx = Math.max(0, currentIdx - WINDOW_CHUNK)
        expandRef.current = { prevHeight: el.scrollHeight }
        windowStartRef.current = lines[nextIdx].id
        setWindowStartId(lines[nextIdx].id)
      }
    }
  }, [store])

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) {
      pinnedRef.current = true
      setPinned(true)
      windowStartRef.current = null
      setWindowStartId(null)
      el.scrollTop = el.scrollHeight
    }
  }, [])

  const allLines = store.lines
  let renderedLines = allLines
  if (windowStartId === null) {
    if (allLines.length > BASE_WINDOW) renderedLines = allLines.slice(-BASE_WINDOW)
  } else {
    const idx = indexOfLineId(allLines, windowStartId)
    if (idx > 0) renderedLines = allLines.slice(idx)
  }
  const hiddenAbove = allLines.length - renderedLines.length

  // Report terminal size (NAWS) on mount and resize.
  useEffect(() => {
    const el = scrollRef.current
    const measure = measureRef.current
    if (!el || !measure) return
    const report = () => {
      const rect = measure.getBoundingClientRect()
      const charW = rect.width / 10 // measure span holds 10 chars
      const charH = rect.height
      if (charW > 0 && charH > 0) {
        const cols = Math.max(20, Math.floor(el.clientWidth / charW))
        const rows = Math.max(5, Math.floor(el.clientHeight / charH))
        window.mud.resize(store.id, cols, rows)
      }
    }
    report()
    const obs = new ResizeObserver(report)
    obs.observe(el)
    return () => obs.disconnect()
  }, [store.id])

  // Focus input when this tab becomes active.
  useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active])

  // Keyboard macros fire regardless of focus while this session is active.
  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent) => {
      if (uiState.modalOpen) return
      const sig = keyEventSignature(e)
      if (sig && store.engine.runMacro(sig)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [active, store])

  const sendCommand = useCallback(() => {
    const raw = input
    const masked = store.serverEchoes
    store.sendInput(raw, masked)
    if (!masked) {
      store.pushHistory(raw)
      if (settingsManager.globalOptions.clearInputOnSend) {
        setInput('')
      } else {
        // MUD convention: keep the command selected so typing replaces it.
        inputRef.current?.select()
      }
    } else {
      setInput('')
    }
    historyPos.current = null
  }, [input, store])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        sendCommand()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const h = store.history
        if (h.length === 0) return
        if (historyPos.current === null) {
          draft.current = input
          historyPos.current = h.length - 1
        } else if (historyPos.current > 0) {
          historyPos.current--
        }
        setInput(h[historyPos.current])
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (historyPos.current === null) return
        if (historyPos.current < store.history.length - 1) {
          historyPos.current++
          setInput(store.history[historyPos.current])
        } else {
          historyPos.current = null
          setInput(draft.current)
        }
      } else if (e.key === 'Escape') {
        setInput('')
        historyPos.current = null
      }
    },
    [input, sendCommand, store]
  )

  const statusBits = useMemo(() => {
    const bits: string[] = []
    bits.push(store.status === 'connected' ? '● Connected' : store.status === 'connecting' ? '◌ Connecting…' : '○ Disconnected')
    bits.push(`${store.host}:${store.port}`)
    if (store.mccp) bits.push('MCCP2')
    if (store.gmcp) bits.push('GMCP')
    if (store.mxp) bits.push('MXP')
    if (store.msp) bits.push('MSP')
    if (store.serverEchoes) bits.push('🔒 masked')
    if (store.logging) bits.push('📝 logging')
    return bits
  }, [store.status, store.host, store.port, store.mccp, store.gmcp, store.mxp, store.msp, store.serverEchoes, store.logging, store.version])

  return (
    <div className="session" style={{ display: active ? 'flex' : 'none' }}>
      <div className="session-main">
        <div className="session-terminal">
          <GaugeBar store={store} />
          <div className="output" ref={scrollRef} onScroll={onScroll}>
            <span ref={measureRef} className="measure" aria-hidden>
              MMMMMMMMMM
            </span>
            {hiddenAbove > 0 && (
              <div className="scrollback-note">
                — {hiddenAbove.toLocaleString()} older lines — keep scrolling up to load —
              </div>
            )}
            {renderedLines.map((line) => (
              <OutputLine
                key={line.id}
                line={line}
                showTime={options.showTimestamps}
                searchQuery={searchOpen && query.length > 0 ? query : undefined}
                searchCurrent={searchOpen && matches[matchIdx] === line.id}
                onLink={handleMxpLink}
              />
            ))}
            {store.openSpans.length > 0 && (
              <div className="line line-prompt">
                {options.showTimestamps && <span className="line-time">{formatTime(Date.now())}</span>}
                {store.openSpans.map((s, i) => (
                  <OutputSpan key={i} span={s} onLink={handleMxpLink} />
                ))}
              </div>
            )}
          </div>
          {searchOpen && (
            <div className="search-bar">
              <input
                ref={searchInputRef}
                className="search-input"
                placeholder="Search scrollback…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    closeSearch()
                  } else if (e.key === 'Enter') {
                    e.preventDefault()
                    navigateSearch(e.shiftKey ? 1 : -1)
                  }
                }}
              />
              <span className="search-count">
                {matches.length > 0 ? `${matchIdx + 1}/${matches.length}` : query ? '0' : ''}
              </span>
              <button className="map-btn" title="Older match (Enter)" onClick={() => navigateSearch(-1)}>
                ↑
              </button>
              <button className="map-btn" title="Newer match (Shift+Enter)" onClick={() => navigateSearch(1)}>
                ↓
              </button>
              <button className="map-btn" title="Close (Esc)" onClick={closeSearch}>
                ✕
              </button>
            </div>
          )}
          {!pinned && (
            <button className="jump-bottom" onClick={jumpToBottom}>
              ▼ Jump to bottom
            </button>
          )}
          {store.showCaptures && <CapturePane store={store} />}
        </div>
        {store.showMap && (
          <>
            <div className="map-divider" onMouseDown={onDividerDown} />
            <div style={{ width: mapWidth, flex: 'none', display: 'flex' }}>
              {store.mapModel && store.tracker ? (
                <MapPane
                  model={store.mapModel}
                  tracker={store.tracker}
                  walkTo={(id, fast) => store.walkTo(id, fast)}
                  onPopout={() => window.mud.map.popout(store.id, store.name)}
                  onClose={() => store.toggleMap()}
                />
              ) : (
                <div className="map-pane">
                  <div className="map-toolbar">Loading map…</div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <div className="input-row">
        <input
          ref={inputRef}
          className="command-input"
          type={store.serverEchoes ? 'password' : 'text'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={store.status === 'connected' ? 'Type a command…' : 'Not connected'}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="status-bar">
        <span className="status-text">{statusBits.join('  ·  ')}</span>
        <span className="status-actions">
          {store.status === 'disconnected' && (
            <button
              className="status-btn status-btn-reconnect"
              title="Reconnect to this world (#reconnect, or Enter on an empty line)"
              onClick={() => store.reconnect()}
            >
              🔌 Reconnect
            </button>
          )}
          {store.captureWindows.size > 0 && (
            <button
              className="status-btn"
              title="Show/hide capture windows"
              onClick={() => store.toggleCaptures()}
            >
              💬 Captures
            </button>
          )}
          <button
            className="status-btn"
            title="Toggle map pane (#map)"
            onClick={() => store.toggleMap()}
          >
            🗺 Map
          </button>
          <button
            className="status-btn"
            title={store.logging ? 'Stop logging' : 'Start logging'}
            onClick={() => store.toggleLogging()}
          >
            {store.logging ? '📝 Stop log' : '📝 Log'}
          </button>
          <button className="status-btn" title="Triggers, aliases, macros, timers…" onClick={onOpenSettings}>
            ⚙ Settings
          </button>
          <button className="status-btn" title="Feature guide (or type #help)" onClick={onOpenHelp}>
            ? Help
          </button>
        </span>
      </div>
    </div>
  )
}
