/**
 * LogWriter — per-session plain-text log files with timestamps.
 * Files live in <userData>/logs, named after the session and start time.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HistoryMeta } from '../shared/history'

export class LogWriter {
  private dir: string
  private streams = new Map<string, { stream: fs.WriteStream; history: fs.WriteStream; path: string; name: string }>()

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, 'logs')
    fs.mkdirSync(this.dir, { recursive: true })
  }

  get logsDir(): string {
    return this.dir
  }

  /** Begin logging a session; returns the log file path. */
  start(sessionId: string, name: string): string {
    this.stop(sessionId)
    const safe = name.replace(/[^a-zA-Z0-9 _-]/g, '_').trim().slice(0, 80) || 'session'
    const stamp = new Date()
      .toISOString()
      .replace(/:/g, '-')
      .replace(/\..+$/, '')
    // Tabs on the same world often connect in the same second. Each start
    // needs its own file or their output (and restart headers) gets interleaved.
    const file = path.join(this.dir, `${safe}_${stamp}_${randomUUID()}.log`)
    const stream = fs.createWriteStream(file, { flags: 'a' })
    // A stream with no error listener turns a full disk into a crash. Only
    // drop this entry if it is still the session's current one — a restart
    // may already have replaced it.
    stream.on('error', (err) => {
      console.error(`[log] ${file}: ${err.message}`)
      history.end()
      if (this.streams.get(sessionId)?.stream === stream) this.streams.delete(sessionId)
    })
    stream.write(`--- Wayfarer log for "${name}" started ${new Date().toLocaleString()} ---\n`)
    const history = fs.createWriteStream(file + '.history.jsonl', { flags: 'a' })
    history.on('error', (err) => console.error(`[history] ${err.message}`))
    this.streams.set(sessionId, { stream, history, path: file, name })
    return file
  }

  line(sessionId: string, text: string, meta: HistoryMeta = {}): void {
    const entry = this.streams.get(sessionId)
    if (!entry) return
    const t = new Date()
    const hh = String(t.getHours()).padStart(2, '0')
    const mm = String(t.getMinutes()).padStart(2, '0')
    const ss = String(t.getSeconds()).padStart(2, '0')
    if (!meta.channel) entry.stream.write(`[${hh}:${mm}:${ss}] ${text}\n`)
    entry.history.write(JSON.stringify({ ...meta, world: meta.world ?? entry.name, text, at: t.getTime() }) + '\n')
  }

  stop(sessionId: string): void {
    const entry = this.streams.get(sessionId)
    if (entry) {
      entry.stream.end(`--- log closed ${new Date().toLocaleString()} ---\n`)
      entry.history.end()
      this.streams.delete(sessionId)
    }
  }

  stopAll(): void {
    for (const id of [...this.streams.keys()]) this.stop(id)
  }
}
