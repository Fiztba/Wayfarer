/**
 * Grapevine (grapevine.haus) — the inter-MUD chat network's game list.
 *
 * Worth including despite its size because the population is genuinely
 * different: games register themselves by connecting a socket, so the list runs
 * heavily to modern engines (Evennia, ExVenture, Ranvier, LambdaMOO) that the
 * older directories never picked up.
 *
 * There is no JSON — /games.json and /api/games both 404, and the documented
 * API is the game-side socket protocol, not a directory read. So this scrapes
 * the paginated HTML.
 *
 * The listing pages carry no address, which originally made this an
 * enrichment-only source: entries joined on name and could never create a MUD.
 * That silently dropped 56 online games — NukeFire among them, with 62 players,
 * listed on no other directory and therefore invisible entirely.
 *
 * Each game's own page does state the address ("Host: … / Port: …"), so we walk
 * them. One extra request per game, which for ~150 games is a minute of polite
 * fetching, and it turns Grapevine into a source that can stand on its own.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { politeText, decodeEntities } from '../lib/http.mts'

const BASE = 'https://grapevine.haus/games'
const MAX_PAGES = 12

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(here, '..', 'data', 'grapevine.json')

export interface GrapevineRecord {
  name: string
  slug: string
  codebase: string
  tagline: string
  online: boolean
  /** From the game's own page; empty when it lists no telnet address. */
  host: string
  port: number
}

const clean = (s: string): string =>
  decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

/**
 * Pull the telnet address out of a single game's page, which renders it as
 * `<div>Host: name</div><div>Port: 4000</div>` under "Ways to Connect".
 *
 * Some games list only a web client and have no telnet block at all; those come
 * back empty and stay enrichment-only.
 */
export function parseGamePage(html: string): { host: string; port: number } {
  const host = /Host:\s*([A-Za-z0-9._-]+)/.exec(html)
  const port = /Port:\s*(\d{1,5})/.exec(html)
  const p = port ? Number(port[1]) : 0
  return {
    host: host ? host[1].toLowerCase() : '',
    port: p > 0 && p <= 65535 ? p : 0
  }
}

export function parse(html: string): GrapevineRecord[] {
  const out: GrapevineRecord[] = []
  // One <li class="game"> per entry: a title anchor carrying name and slug, an
  // optional "user-agent" span holding the codebase string the game reported
  // over the socket, and a status icon that reads "online" when Grapevine has
  // seen it recently.
  for (const block of html.split(/<li class="game">/).slice(1)) {
    const link = /<a href="\/games\/([^"/]+)"[^>]*>([\s\S]{0,200}?)<\/a>/.exec(block)
    if (!link) continue
    const name = clean(link[2])
    if (!name) continue
    const cb = /<span class="user-agent[^"]*"[^>]*>([\s\S]{0,120}?)<\/span>/.exec(block)
    const tag = /<div class="tagline">\s*<span>([\s\S]{0,400}?)<\/span>/.exec(block)
    out.push({
      name,
      slug: link[1],
      codebase: cb ? clean(cb[1]) : '',
      tagline: tag ? clean(tag[1]) : '',
      online: /class="[^"]*\bonline\b[^"]*"/.test(block),
      host: '',
      port: 0
    })
  }
  const seen = new Set<string>()
  return out.filter((r) => (seen.has(r.slug) ? false : (seen.add(r.slug), true)))
}

export async function build(): Promise<GrapevineRecord[]> {
  const all: GrapevineRecord[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= MAX_PAGES; page++) {
    const recs = parse(await politeText(`${BASE}?page=${page}`))
    const fresh = recs.filter((r) => !seen.has(r.slug))
    for (const r of fresh) seen.add(r.slug)
    all.push(...fresh)
    process.stderr.write(`  page ${page}: +${fresh.length} (${all.length})\n`)
    if (fresh.length === 0) break
  }
  process.stderr.write(`Grapevine: ${all.length} games; fetching addresses\n`)
  let addressed = 0
  for (const g of all) {
    try {
      const detail = parseGamePage(await politeText(`${BASE}/${encodeURIComponent(g.slug)}`))
      g.host = detail.host
      g.port = detail.port
      if (g.host && g.port) addressed++
    } catch (err) {
      // One unreachable game page costs that game its address, not the run.
      process.stderr.write(`  ! ${g.slug}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  process.stderr.write(`Grapevine: ${all.length} records, ${addressed} with an address\n`)
  return all
}

if (process.argv[1]?.endsWith('grapevine.mts')) {
  fs.writeFileSync(OUT, JSON.stringify(await build(), null, 0))
}
