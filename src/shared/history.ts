export interface HistoryMeta { world?: string; profileId?: string | null; character?: string | null; channel?: string }
export interface HistoryRecord extends HistoryMeta { text: string; at: number }
export interface HistoryQuery { text: string; world?: string; character?: string; channel?: string; from?: string; to?: string; source?: 'all' | 'logs' | 'captures' }
export interface HistoryHit extends HistoryRecord { file: string; line: number }
export interface HistoryResults { hits: HistoryHit[]; truncated: boolean; skipped: number }
export function matchesHistory(line: HistoryRecord, q: HistoryQuery): boolean {
  const includes = (value: string | null | undefined, needle: string | undefined) => !needle || (value ?? '').toLowerCase().includes(needle.toLowerCase())
  const day = new Date(line.at)
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  return includes(line.text, q.text) && includes(line.world, q.world) && includes(line.character, q.character) &&
    includes(line.channel, q.channel) && (!q.from || date >= q.from) && (!q.to || date <= q.to) &&
    (q.source !== 'captures' || !!line.channel) && (q.source !== 'logs' || !line.channel)
}
