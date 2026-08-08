/**
 * LogWriter — per-session plain-text log files with timestamps.
 * Files live in <userData>/logs, named after the session and start time.
 */
import fs from 'node:fs'
import path from 'node:path'

export class LogWriter {
  private dir: string
  private streams = new Map<string, { stream: fs.WriteStream; path: string }>()

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
    const safe = name.replace(/[^a-zA-Z0-9 _-]/g, '_').trim() || 'session'
    const stamp = new Date()
      .toISOString()
      .replace(/:/g, '-')
      .replace(/\..+$/, '')
    const file = path.join(this.dir, `${safe}_${stamp}.log`)
    const stream = fs.createWriteStream(file, { flags: 'a' })
    stream.write(`--- Wayfarer log for "${name}" started ${new Date().toLocaleString()} ---\n`)
    this.streams.set(sessionId, { stream, path: file })
    return file
  }

  line(sessionId: string, text: string): void {
    const entry = this.streams.get(sessionId)
    if (!entry) return
    const t = new Date()
    const hh = String(t.getHours()).padStart(2, '0')
    const mm = String(t.getMinutes()).padStart(2, '0')
    const ss = String(t.getSeconds()).padStart(2, '0')
    entry.stream.write(`[${hh}:${mm}:${ss}] ${text}\n`)
  }

  stop(sessionId: string): void {
    const entry = this.streams.get(sessionId)
    if (entry) {
      entry.stream.end(`--- log closed ${new Date().toLocaleString()} ---\n`)
      this.streams.delete(sessionId)
    }
  }

  stopAll(): void {
    for (const id of [...this.streams.keys()]) this.stop(id)
  }
}
