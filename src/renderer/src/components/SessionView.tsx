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
import { updateState } from '../updateState'
import { MapPane } from './MapPane'
import { OutputLine, OutputSpan, formatTime, lineText, type LinkHandler } from './OutputLine'
import { GaugeBar } from './GaugeBar'
import { CapturePane } from './CapturePane'
import { ClampedMenu } from './ClampedMenu'

/** How many lines are in the DOM while pinned to the bottom. */
const BASE_WINDOW = 1500
/** How many more lines materialize per approach to the top of the scroll. */
const WINDOW_CHUNK = 1500
/** How many lines the live tail below the split keeps in the DOM. */
const LIVE_WINDOW = 300
/** Live tail height while scrolled back, in pixels, before the user drags it. */
const DEFAULT_LIVE_HEIGHT = 180
/** Smallest either half of the split may be dragged to, in pixels. */
const MIN_SPLIT_HEIGHT = 60

/** Tallest the command input grows to fit a pasted block, in pixels. */
const MAX_INPUT_HEIGHT = 260

type InputEl = HTMLTextAreaElement | HTMLInputElement

/** True when the caret sits on the first line — where ↑ means "history". */
function caretOnFirstLine(el: InputEl): boolean {
  return el.value.lastIndexOf('\n', (el.selectionStart ?? 0) - 1) === -1
}

/** True when the caret sits on the last line — where ↓ means "history". */
function caretOnLastLine(el: InputEl): boolean {
  return el.value.indexOf('\n', el.selectionEnd ?? 0) === -1
}

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
  onOpenHelp,
  focusTick = 0
}: {
  store: SessionStore
  active: boolean
  onOpenSettings(): void
  onOpenHelp(): void
  /** Bumped by App when a modal closes, so the command line takes focus back. */
  focusTick?: number
}) {
  useSyncExternalStore(store.subscribe, store.getVersion)
  const pendingUpdate = useSyncExternalStore(updateState.subscribe, updateState.get)

  // Re-render when app-wide options (timestamps, input behavior) change.
  const [, forceOptions] = useState(0)
  useEffect(() => settingsManager.subscribe(() => forceOptions((n) => n + 1)), [])
  const options = settingsManager.globalOptions

  const scrollRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const inputRef = useRef<InputEl | null>(null)
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
  // Mirrors mapWidth for the drag listeners, which are bound once per drag
  // and would otherwise see only the width from the render they closed over.
  const mapWidthRef = useRef(mapWidth)
  const mapDrag = useRef<{ startX: number; startW: number } | null>(null)
  // Split scrollback: while the reader is scrolled up, the live tail keeps
  // going in its own pane below a divider, so new output is never missed.
  const splitRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef<HTMLDivElement>(null)
  const [liveHeight, setLiveHeight] = useState(() =>
    Number(localStorage.getItem('wayfarer-live-height')) || DEFAULT_LIVE_HEIGHT
  )
  const liveHeightRef = useRef(liveHeight)
  const liveDrag = useRef<{ startY: number; startH: number } | null>(null)

  // ---- Ctrl+F search over the full scrollback ----
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<number[]>([]) // line ids, oldest→newest
  const [matchIdx, setMatchIdx] = useState(0)
  // The nonce lets a repeat jump to the same line (Enter on the only hit
  // after scrolling away) re-run the scroll; keyed on the id alone it would
  // be a no-op.
  const [jumpTarget, setJumpTarget] = useState<{ id: number; nonce: number } | null>(null)
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
      setJumpTarget((prev) => ({ id: lineId, nonce: (prev?.nonce ?? 0) + 1 }))
    },
    [store]
  )

  useLayoutEffect(() => {
    if (jumpTarget === null) return
    const el = scrollRef.current?.querySelector(`[data-lid="${jumpTarget.id}"]`)
    if (el) {
      el.scrollIntoView({ block: 'center' })
      setJumpTarget(null)
    }
  }, [jumpTarget, windowStartId])

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

  /**
   * MXP link clicked: send the command, stage it, or open the URL.
   * `href` may hold several `|`-separated commands (MXP menu convention):
   * the first is the left-click action; the rest are offered on right-click.
   * With the PROMPT flag the first entry is a "handle" (an exact target like
   * "3.hound") staged into the input line — cursor at the front, so the
   * player types the verb before it.
   */
  const handleMxpLink = useCallback<LinkHandler>(
    (link, menu) => {
      if (link.url) {
        const url = link.url.startsWith('http') ? link.url : `https://${link.url}`
        window.open(url) // main process routes this to the system browser
        return
      }
      const raw = link.command || link.textAcc?.trim()
      if (!raw) return
      const commands = raw.split('|').map((c) => c.trim()).filter(Boolean)
      if (menu) {
        // Right-click: offer the menu entries (skipping a handle entry).
        const entries = link.prompt ? commands.slice(1) : commands
        const hints = (link.hint ?? '').split('|')
        const labels = hints.length > 1 ? hints.slice(1) : entries
        if (entries.length === 0) return
        setLinkMenu({
          x: menu.x,
          y: menu.y,
          items: entries.map((c, i) => ({ label: labels[i] || c, command: c }))
        })
        return
      }
      const first = commands[0]
      if (link.prompt) {
        setInput(' ' + first)
        inputRef.current?.focus()
        // Cursor at the start: the verb goes in front of the handle.
        requestAnimationFrame(() => inputRef.current?.setSelectionRange(0, 0))
      } else {
        store.sendInput(first, false)
      }
    },
    [store]
  )
  const [linkMenu, setLinkMenu] = useState<{
    x: number
    y: number
    items: { label: string; command: string }[]
  } | null>(null)
  // Right-click on a line: build a trigger from it, or copy it. Only output
  // lines are offered; a trigger built from your own echoed input or a
  // system line would never fire.
  const [lineMenu, setLineMenu] = useState<{ x: number; y: number; text: string } | null>(null)
  const onLineMenu = useCallback((line: Line, at: { x: number; y: number }) => {
    if (line.kind !== 'output') return
    const text = lineText(line)
    if (!text.trim()) return
    setLineMenu({ ...at, text })
  }, [])
  useEffect(() => {
    if (!linkMenu && !lineMenu) return
    const close = (): void => {
      setLinkMenu(null)
      setLineMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', close)
    }
  }, [linkMenu, lineMenu])

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
      mapDrag.current = { startX: e.clientX, startW: mapWidthRef.current }
      const move = (ev: MouseEvent) => {
        if (!mapDrag.current) return
        const w = Math.min(
          800,
          Math.max(200, mapDrag.current.startW + (mapDrag.current.startX - ev.clientX))
        )
        mapWidthRef.current = w
        setMapWidth(w)
      }
      const up = () => {
        if (mapDrag.current) {
          localStorage.setItem('wayfarer-map-width', String(mapWidthRef.current))
        }
        mapDrag.current = null
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    []
  )

  // Drag the split divider: pulling it up gives the live tail more room.
  // Clamped so neither half can be squeezed away entirely.
  const onSplitDividerDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      liveDrag.current = { startY: e.clientY, startH: liveHeightRef.current }
      const move = (ev: MouseEvent) => {
        if (!liveDrag.current) return
        const total = splitRef.current?.clientHeight ?? 0
        const maxH = Math.max(MIN_SPLIT_HEIGHT, total - MIN_SPLIT_HEIGHT * 2)
        const h = Math.min(
          maxH,
          Math.max(MIN_SPLIT_HEIGHT, liveDrag.current.startH + (liveDrag.current.startY - ev.clientY))
        )
        liveHeightRef.current = h
        setLiveHeight(h)
      }
      const up = () => {
        if (liveDrag.current) {
          localStorage.setItem('wayfarer-live-height', String(liveHeightRef.current))
        }
        liveDrag.current = null
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    []
  )

  // Grow the input to fit a pasted block (up to MAX_INPUT_HEIGHT, then it
  // scrolls), and shrink back to one line when it empties. Declared above the
  // auto-scroll effect on purpose: growing the input shrinks the output pane,
  // and the pin-to-bottom below has to run after that to stay pinned.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!(el instanceof HTMLTextAreaElement)) return
    el.style.height = 'auto'
    // +2 for the 1px borders: scrollHeight is the content box, height is not.
    el.style.height = `${Math.min(el.scrollHeight + 2, MAX_INPUT_HEIGHT)}px`
  }, [input, store.serverEchoes])

  // Auto-scroll unless the user has scrolled up to read; after revealing
  // older history, keep the view anchored on what they were reading.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // (windowStale: the anchor delta belongs to a window that no longer
    // exists; the reset effect below discards it.)
    if (expandRef.current && !windowStale) {
      el.scrollTop += el.scrollHeight - expandRef.current.prevHeight
      expandRef.current = null
    } else if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight
    }
    // The live tail is never scrolled by hand (overflow hidden), so it is
    // simply re-pinned after every render.
    const live = liveRef.current
    if (live) live.scrollTop = live.scrollHeight
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
    // The button that was clicked unmounts with the split; give the keyboard
    // back to the command line rather than leaving focus on the page body.
    inputRef.current?.focus()
  }, [])

  const allLines = store.lines
  // A frozen window whose start line has since been trimmed from the buffer
  // can't be honoured: the search lands on index 0 and the "window" would be
  // the whole buffer. Fall back to the pinned window for this render and drop
  // the freeze below, so the DOM stays bounded however far the reader was.
  const windowStartIdx = windowStartId === null ? -1 : indexOfLineId(allLines, windowStartId)
  const windowStale = windowStartId !== null && allLines[windowStartIdx]?.id !== windowStartId
  let renderedLines = allLines
  if (windowStartId === null || windowStale) {
    if (allLines.length > BASE_WINDOW) renderedLines = allLines.slice(-BASE_WINDOW)
  } else if (windowStartIdx > 0) {
    renderedLines = allLines.slice(windowStartIdx)
  }
  const hiddenAbove = allLines.length - renderedLines.length

  useLayoutEffect(() => {
    if (!windowStale) return
    windowStartRef.current = null
    setWindowStartId(null)
    // A pending "keep the view anchored" height delta belongs to the window
    // that just vanished; applying it would scroll to nowhere.
    expandRef.current = null
  }, [windowStale])

  // Report terminal size (NAWS) on mount and resize. Measured on the split
  // container, not the scrollback pane: splitting off the live tail must not
  // shrink the rows the MUD pages by while the player is reading history.
  useEffect(() => {
    const el = splitRef.current
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

  // A password prompt always starts empty, whatever "clear the input line
  // after sending" says. With it off the name you just sent is still sitting
  // there selected, and the swap to a masked <input> is a fresh element, so
  // the selection is gone — the next keystroke would append to the name and
  // send name+password as the password, invisibly.
  const wasMasked = useRef(store.serverEchoes)
  useLayoutEffect(() => {
    if (store.serverEchoes && !wasMasked.current) {
      setInput('')
      historyPos.current = null
    }
    wasMasked.current = store.serverEchoes
  }, [store.serverEchoes])

  // Focus input when this tab becomes active — and again when a password
  // prompt swaps the textarea for a masked <input>, which is a remount, or
  // when a modal closes and gives the keyboard back.
  useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active, store.serverEchoes, focusTick])

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
      // "Keep it selected" exists so you can re-send one command by typing
      // over it; a pasted block is a one-shot, so it always clears (↑ brings
      // the whole block back if you need it again).
      if (settingsManager.globalOptions.clearInputOnSend || raw.includes('\n')) {
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
    (e: React.KeyboardEvent<InputEl>) => {
      // Mid-composition keystrokes (CJK IMEs, dead keys) arrive as Enter/arrows
      // too; acting on them would send or replace a half-composed word. Older
      // Chromium reports these only as keyCode 229.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      const el = e.currentTarget
      if (e.key === 'Enter') {
        // Shift+Enter / Ctrl+Enter break a line instead of sending, so a block
        // can be written or fixed up in place. Enter always sends the lot.
        if ((e.shiftKey || e.ctrlKey) && el instanceof HTMLTextAreaElement) return
        e.preventDefault()
        // A held Enter auto-repeats, and with the command left selected after
        // sending, each repeat would resend it. Only a real press sends; two
        // deliberate taps still send twice.
        if (e.repeat) return
        sendCommand()
      } else if (e.key === 'ArrowUp') {
        // Inside a multi-line block the arrows walk the caret; history only
        // takes over at the top (↑) and bottom (↓) of the text.
        if (!caretOnFirstLine(el)) return
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
        if (!caretOnLastLine(el)) return
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
    if (store.msdp) bits.push('MSDP')
    if (store.mxp) bits.push('MXP')
    if (store.msp) bits.push('MSP')
    if (store.serverEchoes) bits.push('🔒 masked')
    if (store.logging) bits.push('📝 logging')
    // Who the session thinks is logged in: what character-scoped triggers
    // and aliases key on, so a wrong or missing name is visible (#char).
    if (store.charName) bits.push(`👤 ${store.charName}`)
    bits.push(`v${window.mud.version}`)
    return bits
  }, [store.status, store.host, store.port, store.mccp, store.gmcp, store.msdp, store.mxp, store.msp, store.serverEchoes, store.logging, store.charName, store.version])

  // The unterminated line (usually the prompt) belongs at the very end of
  // whichever pane is live: the scrollback while pinned, the tail while split.
  const openPrompt = store.openSpans.length > 0 && (
    <div className="line line-prompt">
      {options.showTimestamps && <span className="line-time">{formatTime(Date.now())}</span>}
      {store.openSpans.map((s, i) => (
        <OutputSpan key={i} span={s} onLink={handleMxpLink} />
      ))}
    </div>
  )

  return (
    <div className="session" style={{ display: active ? 'flex' : 'none' }}>
      <div className="session-main">
        <div className="session-terminal">
          <GaugeBar store={store} />
          <div className="output-split" ref={splitRef}>
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
                  onLineMenu={onLineMenu}
                />
              ))}
              {pinned && openPrompt}
            </div>
            {!pinned && (
              <>
                <div className="split-divider" onMouseDown={onSplitDividerDown}>
                  <span className="split-label">live output</span>
                  <button
                    className="jump-bottom"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={jumpToBottom}
                  >
                    ▼ Jump to bottom
                  </button>
                </div>
                <div className="output output-live" ref={liveRef} style={{ height: liveHeight }}>
                  {allLines.slice(-LIVE_WINDOW).map((line) => (
                    <OutputLine
                      key={line.id}
                      line={line}
                      showTime={options.showTimestamps}
                      searchQuery={searchOpen && query.length > 0 ? query : undefined}
                      onLink={handleMxpLink}
                      onLineMenu={onLineMenu}
                    />
                  ))}
                  {openPrompt}
                </div>
              </>
            )}
          </div>
          {linkMenu && (
            <ClampedMenu
              x={linkMenu.x}
              y={linkMenu.y}
              className="mxp-menu"
              onClick={(e) => e.stopPropagation()}
            >
              {linkMenu.items.map((item, i) => (
                <div
                  key={i}
                  className="mxp-menu-item"
                  onClick={() => {
                    setLinkMenu(null)
                    store.sendInput(item.command, false)
                  }}
                >
                  {item.label}
                </div>
              ))}
            </ClampedMenu>
          )}
          {lineMenu && (
            <ClampedMenu
              x={lineMenu.x}
              y={lineMenu.y}
              className="mxp-menu"
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className="mxp-menu-item"
                onClick={() => {
                  const text = lineMenu.text
                  setLineMenu(null)
                  uiState.openTriggerFromLine?.(store.id, text)
                }}
              >
                Make a trigger from this line…
              </div>
              <div
                className="mxp-menu-item"
                onClick={() => {
                  void navigator.clipboard.writeText(lineMenu.text)
                  setLineMenu(null)
                }}
              >
                Copy line
              </div>
            </ClampedMenu>
          )}
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
          {store.showCaptures && <CapturePane store={store} onLink={handleMxpLink} />}
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
        {store.serverEchoes ? (
          // Passwords need a real <input type="password"> — and a masked
          // prompt is never multi-line anyway.
          <input
            ref={(el) => {
              inputRef.current = el
            }}
            className="command-input"
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Password"
            autoComplete="off"
          />
        ) : (
          // A textarea so a pasted block keeps its newlines and indentation
          // instead of being flattened into one line by an <input>.
          <textarea
            ref={(el) => {
              inputRef.current = el
            }}
            className="command-input"
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={store.status === 'connected' ? 'Type a command…' : 'Not connected'}
            spellCheck={false}
            autoComplete="off"
          />
        )}
      </div>
      <div className="status-bar">
        <span className="status-text">{statusBits.join('  ·  ')}</span>
        <span className="status-actions">
          {pendingUpdate && (
            <button
              className="status-btn status-btn-update"
              title={`Version ${pendingUpdate} is downloaded. Click to restart and install it now — otherwise it installs the next time you quit.`}
              onClick={() => void window.mud.installUpdate()}
            >
              ⬆ Update to {pendingUpdate}
            </button>
          )}
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
