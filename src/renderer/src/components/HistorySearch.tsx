import React, { useRef, useState } from 'react'
import { useToolDialog } from './useToolDialog'
import { sessionStores } from '../SessionStore'
import { matchesHistory, type HistoryQuery, type HistoryHit } from '../../../shared/history'

interface Hit extends HistoryHit { context?: HistoryHit[] }
export function HistorySearch({ onClose }: { onClose(): void }) {
  const dialogRef = useToolDialog(onClose)
  const [query, setQuery] = useState<HistoryQuery>({ text: '', source: 'all' })
  const [hits, setHits] = useState<Hit[]>([])
  const [context, setContext] = useState<HistoryHit[]>([])
  const [selected, setSelected] = useState<Hit | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const generation = useRef(0)
  const contextGeneration = useRef(0)
  const search = async () => {
    const seq = ++generation.current
    contextGeneration.current++
    setBusy(true); setMessage(''); setSelected(null); setContext([])
    try {
      if (query.from && query.to && query.from > query.to) throw new Error('The start date must be before the end date.')
      const live: Hit[] = []
      if (query.source !== 'logs') for (const store of sessionStores.values()) {
        for (const [channel, lines] of store.captureWindows) {
          const records: HistoryHit[] = lines.map((line, i) => ({ text: line.spans.map((s) => s.text).join(''), at: line.at,
            world: store.name, character: line.character, channel, file: `Open capture: ${store.name} / ${channel}`, line: i + 1 }))
          records.forEach((record, i) => { if (matchesHistory(record, query) && live.length < 300) live.push({ ...record, context: records.slice(Math.max(0, i - 8), i + 9) }) })
        }
      }
      const saved = await window.mud.history.search(query)
      if (seq !== generation.current) return
      setHits([...live, ...saved.hits].sort((a, b) => b.at - a.at))
      setMessage(`${live.length} open-capture matches, ${saved.hits.length} saved matches.${saved.truncated || live.length >= 300 ? ' Result limit reached; narrow the filters.' : ''}${saved.skipped ? ` ${saved.skipped} files were unreadable or over 128 MB.` : ''}`)
    } catch (err) { if (seq === generation.current) { setHits([]); setMessage(String(err)) } }
    finally { if (seq === generation.current) setBusy(false) }
  }
  const locate = async (hit: Hit) => {
    const seq = ++contextGeneration.current
    setSelected(hit); setContext([])
    try { const items = hit.context ?? await window.mud.history.context(hit.file, hit.line); if (seq === contextGeneration.current) setContext(items) }
    catch (err) { if (seq === contextGeneration.current) setMessage(String(err)) }
  }
  return <div className="tools-overlay"><section ref={dialogRef} className="tools-panel" role="dialog" aria-modal="true" aria-label="Search history">
    <div className="tool-heading"><h2>Search history</h2><button onClick={onClose} aria-label="Close history search">✕</button></div>
    <form onSubmit={(e) => { e.preventDefault(); void search() }}>
      <input autoFocus aria-label="Search text" placeholder="Find text in captures and saved logs" maxLength={500} value={query.text} onChange={(e) => setQuery({ ...query, text: e.target.value })} />
      <div className="history-filters">{(['world','character','channel'] as const).map((key) => <label key={key}>{key}<input value={query[key] ?? ''} onChange={(e) => setQuery({ ...query, [key]: e.target.value })} /></label>)}
        <label>From<input type="date" value={query.from ?? ''} onChange={(e) => setQuery({ ...query, from: e.target.value })} /></label>
        <label>Through<input type="date" value={query.to ?? ''} onChange={(e) => setQuery({ ...query, to: e.target.value })} /></label>
        <label>Source<select value={query.source} onChange={(e) => setQuery({ ...query, source: e.target.value as HistoryQuery['source'] })}><option value="all">All</option><option value="logs">Logs</option><option value="captures">Captures</option></select></label>
      </div><button disabled={busy || !query.text.trim()}>{busy ? 'Searching…' : 'Search'}</button>
    </form>
    <p className="field-hint">Captures are saved while logging is on. Older plain-text logs have world/date information, but no character or channel metadata. Open captures and their saved copies are listed separately.</p>
    <p role="status">{message}</p>
    <div className="history-results">{hits.map((hit, i) => <button disabled={busy} key={i} onClick={() => void locate(hit)}>
      <small>{hit.context ? 'Open capture' : 'Saved'} · {hit.world} · {hit.character || 'unknown character'} · {hit.channel || 'log'} · {new Date(hit.at).toLocaleString()}</small><span>{hit.text}</span>
    </button>)}</div>
    {selected && <section className="history-context"><strong>{selected.world} · {selected.channel || 'Log'} · surrounding context</strong>
      <pre>{context.map((line) => <div key={line.line} className={line.line === selected.line ? 'history-match' : ''}>{line.line}: {line.text}</div>)}</pre>
    </section>}
  </section></div>
}
