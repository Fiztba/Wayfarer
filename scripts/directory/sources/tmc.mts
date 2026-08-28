/**
 * The Mud Connector — the largest actively maintained list, and the only source
 * that tracks liveness well enough to be worth believing.
 *
 * Two endpoints, both on search.cgi:
 *
 *   biglist    one page, ~662 rows: name, host, port, rank, website, and a
 *              "Connected" flag TMC maintains itself.
 *   mud_search the faceted search. Its codebase field is confusingly named
 *              `pbase` (42 values, `TBA` = tbaMUD) and its category field is
 *              `cat` (29 values).
 *
 * The important trick here is that we enrich by *facet*, not by MUD. Fetching a
 * per-MUD listing page for all 662 rows would be 662 requests; sweeping the 42
 * codebases and 29 categories is 71 and yields the same mapping, because every
 * search result carries the telnet address we key on. That keeps a full refresh
 * cheap enough to run weekly without being a nuisance.
 *
 * On the "Connected" flag: sampling 25 flagged rows found 19 actually up (76%),
 * and all 15 sampled unflagged rows were dead (0/15). So the negative is worth
 * trusting outright and the positive is a good prior that still wants probing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { politeText, decodeEntities } from '../lib/http.mts'

const SEARCH = 'https://www.mudconnect.com/cgi-bin/search.cgi'
const BIGLIST = `${SEARCH}?mode=tmc_biglist`

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(here, '..', 'data', 'tmc.json')

export interface TmcRecord {
  name: string
  host: string
  port: number
  rank: number | null
  website: string | null
  /** TMC's own liveness flag. Trustworthy when false, a prior when true. */
  connected: boolean
  codebase: string
  categories: string[]
}

/** The `pbase` (codebase) option values, as of the 2026 search redesign. */
export const CODEBASE_VALUES = [
  'AFKMud', 'Aber', 'Ack!mud', 'Chronicles', 'Circlemud', 'CoffeeMud', 'ColdMud',
  'Copper', 'Custom', 'DUM', 'DaleMud', 'Dawn', 'Dikumud', 'EOS', 'Embermud',
  'Emlenmud', 'Envy', 'GodWars', 'Heavymud', 'LP', 'MOO', 'MUCK', 'MUSE', 'MUSH',
  'MUX', 'Merc', 'Mordor', 'Mythran', 'NiMUD', 'Oblivion', 'ResortMUD', 'Rom',
  'Rot', 'SWR', 'Silly', 'Smaug', 'TBA', 'TFE', 'Uber', 'Unknown', 'VME'
]

export const CATEGORY_VALUES = [
  'Adult', 'Amber', 'Anime', 'Babylon 5', 'Comic Books', 'Cyberpunk',
  'Dark Fantasy', 'DragonLance', 'Dragonball', 'Dungeons and Dragons', 'Eddings',
  'Fantasy', 'Final Fantasy', 'Forgotten Realms', 'Futuristic', 'Gothic',
  'Harry Potter', 'Historical', 'Horror', 'Magic: The Gathering',
  'Medieval Fantasy', 'Modern Day', 'Star Trek', 'Star Wars', 'Superheroes',
  'Warhammer', 'Wheel of Time', 'World of Darkness'
]

/** Extract `host:port` keys plus names from any TMC result page. */
export function parseResults(html: string): { name: string; host: string; port: number }[] {
  const out: { name: string; host: string; port: number }[] = []
  const seen = new Set<string>()
  for (const row of html.split('<tr>')) {
    const telnet = /url=telnet:\/\/([^:'"]+):(\d+)/.exec(row)
    if (!telnet) continue
    const name = /mode=mud_listing&mud=[^']*'[^>]*>([^<]+)<\/a>/.exec(row)
    const host = telnet[1].trim().toLowerCase()
    const port = Number(telnet[2])
    const key = `${host}:${port}`
    if (seen.has(key) || port <= 0 || port > 65535) continue
    seen.add(key)
    out.push({ name: name ? decodeEntities(name[1].trim()) : host, host, port })
  }
  return out
}

/** Parse the biglist, which carries rank / website / connected as well. */
export function parseBiglistRows(html: string): TmcRecord[] {
  const out: TmcRecord[] = []
  const seen = new Set<string>()
  for (const row of html.split('<tr>')) {
    const telnet = /url=telnet:\/\/([^:'"]+):(\d+)/.exec(row)
    if (!telnet) continue
    const name = /mode=mud_listing&mud=[^']*'[^>]*>([^<]+)<\/a>/.exec(row)
    if (!name) continue
    const rank = /^\s*<td>(\d+)<\/td>/.exec(row)
    const website = /redirect\.cgi\?mud=[^&]*&url=([^']+)'/.exec(row)
    const host = telnet[1].trim().toLowerCase()
    const port = Number(telnet[2])
    const key = `${host}:${port}`
    if (seen.has(key) || port <= 0 || port > 65535) continue
    seen.add(key)
    out.push({
      name: decodeEntities(name[1].trim()),
      host,
      port,
      rank: rank ? Number(rank[1]) : null,
      website: website ? decodeEntities(website[1]) : null,
      connected: /<td>Connected<\/td>/.test(row),
      codebase: '',
      categories: []
    })
  }
  return out
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams({
    mode: 'mud_search', keyword: '', keytype: '', cat: '', pbase: '',
    nplayers: '', theme: '', ...fields
  }).toString()
}

export async function build(): Promise<TmcRecord[]> {
  process.stderr.write('TMC: biglist\n')
  const rows = parseBiglistRows(await politeText(BIGLIST))
  const byKey = new Map(rows.map((r) => [`${r.host}:${r.port}`, r]))
  process.stderr.write(`  ${rows.length} rows (${rows.filter((r) => r.connected).length} flagged connected)\n`)

  process.stderr.write(`TMC: sweeping ${CODEBASE_VALUES.length} codebases\n`)
  for (const cb of CODEBASE_VALUES) {
    try {
      const hits = parseResults(await politeText(SEARCH, { body: form({ pbase: cb }) }))
      let tagged = 0
      for (const h of hits) {
        const rec = byKey.get(`${h.host}:${h.port}`)
        // A codebase sweep can surface MUDs the biglist omits; keep them.
        if (rec) { rec.codebase = cb; tagged++ }
        else {
          byKey.set(`${h.host}:${h.port}`, {
            name: h.name, host: h.host, port: h.port, rank: null, website: null,
            connected: false, codebase: cb, categories: []
          })
          tagged++
        }
      }
      process.stderr.write(`  ${cb}: ${tagged}\n`)
    } catch (err) {
      process.stderr.write(`  ! ${cb}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  process.stderr.write(`TMC: sweeping ${CATEGORY_VALUES.length} categories\n`)
  for (const cat of CATEGORY_VALUES) {
    try {
      const hits = parseResults(await politeText(SEARCH, { body: form({ cat }) }))
      for (const h of hits) byKey.get(`${h.host}:${h.port}`)?.categories.push(cat)
      process.stderr.write(`  ${cat}: ${hits.length}\n`)
    } catch (err) {
      process.stderr.write(`  ! ${cat}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  return [...byKey.values()]
}

if (process.argv[1]?.endsWith('tmc.mts')) {
  const recs = await build()
  fs.writeFileSync(OUT, JSON.stringify(recs, null, 0))
  process.stderr.write(
    `TMC: done — ${recs.length} records, ${recs.filter((r) => r.codebase).length} with a codebase\n`
  )
}
