/**
 * MUDVerse — the only source with a real API, and the only one that already
 * does the liveness crawling we otherwise do ourselves.
 *
 * Read-only JSON v1, OpenAPI 3.1 at /api/openapi.json. Auth is an HTTP bearer
 * token generated from the API tab on a MUDVerse account.
 *
 * The key is deliberately NOT shipped in the app. An asar is not encrypted, so
 * anything bundled is published, and MUDVerse issues keys per account for
 * server-to-server use. It therefore lives as a CI secret and is read from the
 * environment here; without it this source is simply skipped and the snapshot
 * builds from the free sources alone.
 *
 * What it adds over the others:
 *   - Connection carries host, port, tls_port and mssp_port as separate fields,
 *     so TLS support is a fact rather than a guess.
 *   - GameStatus carries last_successful_connect / confirmed_online /
 *     latest_players, plus archived + archive_reason="non_connectivity", which
 *     is their own version of the dead-MUD pruning.
 *
 * Rate limits are per-minute and per-day; 429 comes back with Retry-After and
 * X-RateLimit-* headers, which this honours rather than guessing a fixed pace.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { USER_AGENT } from '../lib/http.mts'

const API = 'https://www.mudverse.com/api/v1'
const PER_PAGE = 100

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(here, '..', 'data', 'mudverse.json')

export interface MudverseRecord {
  id: string
  name: string
  intro: string
  host: string
  port: number
  tlsPort: number | null
  msspPort: number | null
  website: string
  discord: string
  rank: number | null
  tags: Record<string, string[]>
  confirmedOnline: boolean
  lastSuccessfulConnect: string | null
  latestPlayers: number | null
  archived: boolean
  archiveReason: string | null
}

/** `mv_live_...` — shape-check early so a truncated paste fails loudly. */
export function looksLikeKey(key: string): boolean {
  return /^mv_(live|test)_[A-Za-z0-9_-]{16,}$/.test(key) && !key.includes('...')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function api(key: string, urlPath: string): Promise<unknown> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API}${urlPath}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT
      },
      signal: AbortSignal.timeout(45_000)
    })
    if (res.status === 429) {
      // Their own Retry-After is better than any interval we'd invent.
      const wait = Number(res.headers.get('Retry-After') ?? '30')
      process.stderr.write(`  rate limited, waiting ${wait}s\n`)
      await sleep((Number.isFinite(wait) ? wait : 30) * 1000)
      continue
    }
    if (res.status === 401) {
      throw new Error('MUDVerse rejected the API key (401) — it may be invalid or revoked')
    }
    if (!res.ok) throw new Error(`MUDVerse HTTP ${res.status} on ${urlPath}`)
    return await res.json()
  }
  throw new Error('MUDVerse: still rate limited after 5 attempts')
}

type Game = {
  id?: string | number
  name?: string
  intro?: string
  connection?: { host?: string; port?: number; tls_port?: number; mssp_port?: number }
  urls?: { website?: string; discord?: string }
  ranking?: { rank?: number }
  tags?: { categories?: Record<string, { name?: string }[]> }
  status?: {
    confirmed_online?: boolean
    last_successful_connect?: string
    latest_players?: number
    archived?: boolean
    archive_reason?: string
  }
}

export async function build(key: string): Promise<MudverseRecord[]> {
  if (!looksLikeKey(key)) {
    throw new Error(
      'MUDVERSE_API_KEY does not look like a MUDVerse key (expected mv_live_… with no elision)'
    )
  }
  const out: MudverseRecord[] = []
  for (let page = 1; page <= 100; page++) {
    const body = (await api(key, `/games?page=${page}&per_page=${PER_PAGE}`)) as {
      data?: Game[]
      meta?: { total?: number }
    }
    const games = body.data ?? []
    for (const g of games) {
      const c = g.connection ?? {}
      const s = g.status ?? {}
      const cats = g.tags?.categories ?? {}
      out.push({
        id: String(g.id ?? ''),
        name: g.name ?? '',
        intro: g.intro ?? '',
        host: (c.host ?? '').toLowerCase(),
        port: c.port ?? 0,
        tlsPort: c.tls_port ?? null,
        msspPort: c.mssp_port ?? null,
        website: g.urls?.website ?? '',
        discord: g.urls?.discord ?? '',
        rank: g.ranking?.rank ?? null,
        tags: Object.fromEntries(
          Object.entries(cats).map(([k, v]) => [
            k,
            (Array.isArray(v) ? v : []).map((t) => t?.name ?? '').filter(Boolean)
          ])
        ),
        confirmedOnline: Boolean(s.confirmed_online),
        lastSuccessfulConnect: s.last_successful_connect ?? null,
        latestPlayers: s.latest_players ?? null,
        archived: Boolean(s.archived),
        archiveReason: s.archive_reason ?? null
      })
    }
    process.stderr.write(`  page ${page}: +${games.length} (${out.length})\n`)
    if (games.length < PER_PAGE) break
  }
  process.stderr.write(`MUDVerse: ${out.length} records\n`)
  return out
}

if (process.argv[1]?.endsWith('mudverse.mts')) {
  const key = process.env.MUDVERSE_API_KEY ?? ''
  if (!key) {
    process.stderr.write('MUDVerse: MUDVERSE_API_KEY not set — skipping\n')
  } else {
    fs.writeFileSync(OUT, JSON.stringify(await build(key), null, 0))
  }
}
