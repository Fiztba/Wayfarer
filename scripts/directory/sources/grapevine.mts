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
 * Caveat carried through to the merge: Grapevine publishes a codebase string
 * and an online flag, but not a host and port. Games are reachable through its
 * own web client rather than by address. Entries therefore join on name and
 * only ever *enrich* a MUD another source located — they never create one.
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
}

const clean = (s: string): string =>
  decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

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
      online: /class="[^"]*\bonline\b[^"]*"/.test(block)
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
  process.stderr.write(`Grapevine: ${all.length} records\n`)
  return all
}

if (process.argv[1]?.endsWith('grapevine.mts')) {
  fs.writeFileSync(OUT, JSON.stringify(await build(), null, 0))
}
