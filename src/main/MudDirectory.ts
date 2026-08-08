/**
 * MudDirectory — browsable list of connectable MUDs, sourced from
 * The Mud Connector's public "biglist" (mudconnect.com).
 *
 * Fetched at most once per TTL and cached on disk, so we stay polite to TMC
 * and the browser works offline once populated.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DirectoryEntry, DirectoryResult } from '../shared/types'

const BIGLIST_URL = 'https://www.mudconnect.com/cgi-bin/search.cgi?mode=tmc_biglist'
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // one week

interface CacheFile {
  fetchedAt: string
  entries: DirectoryEntry[]
}

export class MudDirectory {
  private cacheFile: string
  private memory: CacheFile | null = null
  private inflight: Promise<DirectoryResult> | null = null

  constructor(baseDir: string) {
    this.cacheFile = path.join(baseDir, 'mud-directory-cache.json')
  }

  async list(forceRefresh = false): Promise<DirectoryResult> {
    const cached = this.readCache()
    const fresh =
      cached !== null && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS
    if (cached && fresh && !forceRefresh) {
      return { entries: cached.entries, fetchedAt: cached.fetchedAt, source: 'cache' }
    }
    // Single flight: concurrent callers share one fetch.
    this.inflight ??= this.fetchAndCache(cached)
    try {
      return await this.inflight
    } finally {
      this.inflight = null
    }
  }

  private async fetchAndCache(fallback: CacheFile | null): Promise<DirectoryResult> {
    try {
      const res = await fetch(BIGLIST_URL, {
        headers: { 'User-Agent': 'Wayfarer-MUD-Client/0.1 (directory browser)' },
        signal: AbortSignal.timeout(30_000)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const html = await res.text()
      const entries = parseBiglist(html)
      if (entries.length === 0) throw new Error('no entries parsed — page layout may have changed')
      const cache: CacheFile = { fetchedAt: new Date().toISOString(), entries }
      const tmp = this.cacheFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(cache))
      fs.renameSync(tmp, this.cacheFile)
      this.memory = cache
      return { entries, fetchedAt: cache.fetchedAt, source: 'live' }
    } catch (err) {
      if (fallback) {
        return {
          entries: fallback.entries,
          fetchedAt: fallback.fetchedAt,
          source: 'stale-cache',
          error: String(err instanceof Error ? err.message : err)
        }
      }
      return {
        entries: [],
        fetchedAt: null,
        source: 'unavailable',
        error: String(err instanceof Error ? err.message : err)
      }
    }
  }

  private readCache(): CacheFile | null {
    if (this.memory) return this.memory
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) as CacheFile
      if (Array.isArray(parsed.entries) && typeof parsed.fetchedAt === 'string') {
        this.memory = parsed
        return parsed
      }
    } catch {
      // Missing or unreadable cache is fine; we'll fetch.
    }
    return null
  }
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'"
}

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m] ?? m)
}

/** Parse TMC biglist rows into directory entries. */
export function parseBiglist(html: string): DirectoryEntry[] {
  const entries: DirectoryEntry[] = []
  const seen = new Set<string>()
  const rows = html.split('<tr>')
  for (const row of rows) {
    const telnet = /url=telnet:\/\/([^:'"]+):(\d+)/.exec(row)
    if (!telnet) continue
    const name = /mode=mud_listing&mud=[^']*'[^>]*>([^<]+)<\/a>/.exec(row)
    if (!name) continue
    const rank = /^\s*<td>(\d+)<\/td>/.exec(row)
    const website = /redirect\.cgi\?mud=[^&]*&url=([^']+)'/.exec(row)
    const connected = /<td>Connected<\/td>/.test(row)
    const host = telnet[1].trim().toLowerCase()
    const port = Number(telnet[2])
    const key = `${host}:${port}`
    if (seen.has(key) || port <= 0 || port > 65535) continue
    seen.add(key)
    entries.push({
      name: decodeEntities(name[1].trim()),
      host,
      port,
      rank: rank ? Number(rank[1]) : null,
      website: website ? decodeEntities(website[1]) : null,
      connected
    })
  }
  entries.sort((a, b) => (a.rank ?? 99999) - (b.rank ?? 99999))
  return entries
}
