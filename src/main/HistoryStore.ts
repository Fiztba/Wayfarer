import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { matchesHistory, type HistoryRecord, type HistoryQuery, type HistoryResults, type HistoryHit } from '../shared/history'

/** Stream files so searching a long play history does not load it all into memory. */
export class HistoryStore {
  constructor(private dir: string) {}
  private files(): string[] {
    if (!fs.existsSync(this.dir)) return []
    // JSONL is a searchable companion to new plain logs, never an extra duplicate result.
    const names = fs.readdirSync(this.dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
    return names.filter((f) => f.endsWith('.history.jsonl') || (f.endsWith('.log') && !names.includes(f + '.history.jsonl')))
      .sort((a, b) => fs.statSync(path.join(this.dir, b)).mtimeMs - fs.statSync(path.join(this.dir, a)).mtimeMs)
  }
  private async *lines(file: string): AsyncGenerator<HistoryHit> {
    const stream = fs.createReadStream(path.join(this.dir, file), { encoding: 'utf8', highWaterMark: 64 * 1024 })
    const input = readline.createInterface({ input: stream, crlfDelay: Infinity })
    const stamp = file.match(/_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/)
    let at = stamp ? new Date(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}Z`).getTime() : fs.statSync(path.join(this.dir, file)).mtimeMs
    let lastSeconds: number | null = null
    const world = file.split(/_\d{4}-\d{2}-\d{2}T/)[0]
    let n = 0
    try {
      for await (const text of input) {
        n++
        if (text.length > 100000) continue
        let record: HistoryRecord
        if (file.endsWith('.jsonl')) {
          try { record = JSON.parse(text) } catch { continue }
          if (typeof record?.text !== 'string' || !Number.isFinite(record.at)) continue
        } else {
          const time = text.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/)
          if (time) {
            const seconds = +time[1] * 3600 + +time[2] * 60 + +time[3]
            const d = new Date(at)
            // A large backwards clock jump is midnight, not a log from yesterday.
            if (lastSeconds !== null && lastSeconds - seconds > 12 * 3600) d.setDate(d.getDate() + 1)
            d.setHours(+time[1], +time[2], +time[3]); at = d.getTime(); lastSeconds = seconds
          }
          record = { text, at, world }
        }
        yield { ...record, file, line: n }
      }
    } finally { input.close(); stream.destroy() }
  }
  async search(query: HistoryQuery): Promise<HistoryResults> {
    if (typeof query?.text !== 'string' || !query.text.trim() || query.text.length > 500) throw new Error('Enter 1–500 characters to search')
    for (const key of ['world','character','channel','from','to'] as const) if (query[key] !== undefined && typeof query[key] !== 'string') throw new Error('Invalid search filter')
    const result: HistoryResults = { hits: [], truncated: false, skipped: 0 }
    let bytes = 0
    const files = this.files()
    for (const file of files) {
      const size = fs.statSync(path.join(this.dir, file)).size
      if (size > 128 * 1024 * 1024) { result.skipped++; continue }
      bytes += size
      if (bytes > 512 * 1024 * 1024) { result.truncated = true; break }
      try {
        for await (const line of this.lines(file)) {
          if (!matchesHistory(line, query)) continue
          result.hits.push(line)
          if (result.hits.length >= 300) { result.truncated = true; return result }
        }
      } catch { result.skipped++ }
    }
    return result
  }
  async context(file: string, line: number): Promise<HistoryHit[]> {
    if (!Number.isInteger(line) || line < 1 || !this.files().includes(file)) throw new Error('Invalid history location')
    if (fs.statSync(path.join(this.dir, file)).size > 128 * 1024 * 1024) throw new Error('Log exceeds the 128 MB search limit')
    const result: HistoryHit[] = []
    for await (const item of this.lines(file)) {
      if (item.line >= line - 8 && item.line <= line + 8) result.push(item)
      if (item.line > line + 8) break
    }
    return result
  }
}
