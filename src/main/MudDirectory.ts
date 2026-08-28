/**
 * MudDirectory — the browsable MUD list.
 *
 * Wayfarer no longer scrapes directory sites itself. A weekly CI job unions The
 * Mud Connector, the MSSP crawler, Vineyard, Grapevine and (when a key exists)
 * MUDVerse, probes every address, and publishes one snapshot; the app just
 * downloads that. One prober for everyone instead of one per install, and the
 * list improves without shipping an update.
 *
 * Degradation, in order: fresh snapshot → cached snapshot → stale cached
 * snapshot → a live TMC biglist scrape. That last step is what the app used to
 * do exclusively, kept so a machine that cannot reach GitHub still gets a
 * usable list of names and addresses, just without codebases or liveness.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DirectoryResult } from '../shared/types'
import type { DirectoryMud, DirectorySnapshot } from '../shared/directory'

const SNAPSHOT_URL =
  'https://raw.githubusercontent.com/Fiztba/Wayfarer/master/public-data/directory.json'
const BIGLIST_URL = 'https://www.mudconnect.com/cgi-bin/search.cgi?mode=tmc_biglist'

/** The snapshot is rebuilt weekly; checking daily is plenty. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

const USER_AGENT = 'Wayfarer-MUD-Client/0.4 (directory)'

interface CacheFile {
  fetchedAt: string
  snapshot: DirectorySnapshot
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
    const fresh = cached !== null && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS
    if (cached && fresh && !forceRefresh) {
      return {
        entries: cached.snapshot.muds,
        fetchedAt: cached.fetchedAt,
        builtAt: cached.snapshot.builtAt,
        counts: cached.snapshot.counts,
        source: 'cache'
      }
    }
    this.inflight ??= this.fetchAndCache(cached)
    try {
      return await this.inflight
    } finally {
      this.inflight = null
    }
  }

  private async fetchAndCache(fallback: CacheFile | null): Promise<DirectoryResult> {
    try {
      const res = await fetch(SNAPSHOT_URL, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const snapshot = (await res.json()) as DirectorySnapshot
      if (!Array.isArray(snapshot.muds) || snapshot.muds.length === 0) {
        throw new Error('snapshot contained no MUDs')
      }

      const cache: CacheFile = { fetchedAt: new Date().toISOString(), snapshot }
      const tmp = this.cacheFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(cache))
      fs.renameSync(tmp, this.cacheFile)
      this.memory = cache

      return {
        entries: snapshot.muds,
        fetchedAt: cache.fetchedAt,
        builtAt: snapshot.builtAt,
        counts: snapshot.counts,
        source: 'live'
      }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err)
      if (fallback) {
        return {
          entries: fallback.snapshot.muds,
          fetchedAt: fallback.fetchedAt,
          builtAt: fallback.snapshot.builtAt,
          counts: fallback.snapshot.counts,
          source: 'stale-cache',
          error: message
        }
      }
      // Nothing cached and the snapshot is unreachable — fall back to the
      // original behaviour so the list is thin rather than empty.
      return await this.fetchBiglistFallback(message)
    }
  }

  private async fetchBiglistFallback(snapshotError: string): Promise<DirectoryResult> {
    try {
      const res = await fetch(BIGLIST_URL, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const entries = parseBiglist(await res.text())
      if (entries.length === 0) throw new Error('no entries parsed')
      return {
        entries,
        fetchedAt: new Date().toISOString(),
        builtAt: null,
        counts: null,
        source: 'biglist-fallback',
        error: `snapshot unavailable (${snapshotError}); showing a direct TMC listing without codebase or liveness data`
      }
    } catch (err) {
      return {
        entries: [],
        fetchedAt: null,
        builtAt: null,
        counts: null,
        source: 'unavailable',
        error: `${snapshotError}; TMC fallback also failed (${
          err instanceof Error ? err.message : String(err)
        })`
      }
    }
  }

  private readCache(): CacheFile | null {
    if (this.memory) return this.memory
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) as CacheFile
      if (parsed?.snapshot?.muds && Array.isArray(parsed.snapshot.muds)) {
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

/**
 * Parse TMC biglist rows into bare directory entries.
 *
 * Only used by the offline fallback now, so it fills the metadata fields with
 * empty values rather than pretending to know a codebase.
 */
export function parseBiglist(html: string): DirectoryMud[] {
  const entries: DirectoryMud[] = []
  const seen = new Set<string>()
  for (const row of html.split('<tr>')) {
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
      id: key,
      name: decodeEntities(name[1].trim()),
      host,
      port,
      tlsPort: null,
      tlsOffered: false,
      alternates: [],
      sources: ['tmc'],
      codebase: null,
      family: null,
      ancestry: [],
      codebaseRaw: [],
      codebaseConflict: false,
      categories: [],
      genre: null,
      gameplay: null,
      language: null,
      location: null,
      created: null,
      rooms: null,
      areas: null,
      players: null,
      activePlayers: null,
      website: website ? decodeEntities(website[1]) : null,
      discord: null,
      tagline: null,
      rank: rank ? Number(rank[1]) : null,
      protocols: [],
      hiringBuilders: false,
      hiringCoders: false,
      payToPlay: false,
      // TMC's connected flag is a good prior but unverified here.
      state: connected ? 'up' : 'closed',
      liveness: connected ? 'live' : 'ailing',
      lastSeenUp: null,
      strikes: 0
    })
  }
  entries.sort((a, b) => (a.rank ?? 99999) - (b.rank ?? 99999))
  return entries
}
