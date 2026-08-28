/**
 * Top Mud Sites — the deepest metadata of any source, and the only one that is
 * finished changing.
 *
 * TMS stopped accepting votes and went read-only; its listing survives at
 * muds.php (faceted search) and mudlist.html (A–Z), both over the same 1,963
 * rows. Because the data is frozen, this crawl is a one-time cost: run it once,
 * commit the result, never run it again unless the parse changes.
 *
 * Two things to know before editing:
 *   - Filters take numeric option ids, not labels. `codebase=41` is tbaMud;
 *     `codebase=tbaMud` is silently ignored and returns all 1,963 rows.
 *   - The telnet address exists ONLY on the per-MUD detail page. List pages
 *     carry name + mudid, so there is no way to match TMS against another
 *     source without fetching every detail page.
 *
 * The listing is also very stale — a sampled probe found ~20% of it alive, and
 * its "Online Status" field was right 23% of the time. We keep the metadata and
 * deliberately drop that field; liveness comes from probing, never from here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { politeText, flatten, labelled } from '../lib/http.mts'

const BASE = 'https://www.topmudsites.com/forums'
const LIST = `${BASE}/muds.php?do=main&codebase=0&worldsize=0&votecategory=0&pkoptions=0&status=0&roleplaying=0&yearcreated=0&category=0&pbase=0&originality=0`
const PAGES = 40

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(here, '..', 'data', 'tms.json')

export interface TmsRecord {
  mudid: string
  name: string
  host: string
  port: number
  telnetRaw: string
  website: string
  codebase: string
  codebaseNote: string
  category: string
  theme: string
  yearCreated: number | null
  worldSize: string
  originality: string
  playerKilling: string
  roleplaying: string
  avgPlayers: string
  language: string
  location: string
  features: string[]
}

/** Collect every mudid from the paginated listing. */
export async function collectIds(): Promise<string[]> {
  const ids = new Set<string>()
  for (let page = 1; page <= PAGES; page++) {
    const html = await politeText(`${LIST}&page=${page}`)
    const before = ids.size
    for (const m of html.matchAll(/mudid=([a-zA-Z0-9_.-]+)/g)) ids.add(m[1])
    process.stderr.write(`  list page ${page}/${PAGES}: +${ids.size - before} (${ids.size} total)\n`)
    // A page that adds nothing usually means we ran past the end.
    if (ids.size === before && page > 3) break
  }
  return [...ids].sort()
}

const FEATURE_LABELS = [
  'Supports ANSI Color', 'Supports MCCP', 'Supports MSP', 'Has a Java Client',
  'Is Graphical', 'Has Quests', 'Classless System', 'Class Based System',
  'Levelless System', 'Level Based System', 'Multiclassing', 'Has Clans/Cabals',
  'Equip saves on exit', 'Private Messaging System', 'Accepts Reviews',
  'Free to Play', 'Pay to Play', 'Hiring Builders', 'Hiring Coders'
]

export function parseDetail(mudid: string, html: string): TmsRecord | null {
  const flat = flatten(html)
  const name = labelled(flat, 'MUD Name', 120)
  if (!name) return null

  const telnetRaw = labelled(flat, 'Telnet Address', 120)
  const m = /^\s*([A-Za-z0-9._-]+)\s*:\s*(\d{1,5})\s*$/.exec(telnetRaw)
  const year = labelled(flat, 'Year Created', 20)

  // Codebase renders as the value then an optional free-text note on its own
  // line, e.g. "tbaMud" then "- Extensively modified codebase...".
  const cbBlock = new RegExp('\\|Codebase\\|\\s*([^|]{1,80})\\|?\\s*(-[^|]{0,300})?').exec(flat)

  return {
    mudid,
    name,
    host: m ? m[1].toLowerCase() : '',
    port: m ? Number(m[2]) : 0,
    telnetRaw,
    website: labelled(flat, 'HomePage', 200),
    codebase: (cbBlock?.[1] ?? '').trim(),
    codebaseNote: (cbBlock?.[2] ?? '').replace(/^-\s*/, '').trim(),
    category: labelled(flat, 'Category', 120),
    theme: labelled(flat, 'Theme', 200),
    yearCreated: /^\d{4}$/.test(year) ? Number(year) : null,
    worldSize: labelled(flat, 'World Size', 60),
    originality: labelled(flat, 'World Originality', 60),
    playerKilling: labelled(flat, 'Player Killing', 60),
    roleplaying: labelled(flat, 'Roleplaying', 40),
    avgPlayers: labelled(flat, 'Avg Players Online', 30),
    language: labelled(flat, 'Language', 40),
    location: labelled(flat, 'Location', 60),
    features: FEATURE_LABELS.filter((f) => flat.includes(`|${f}|`))
  }
}

async function main(): Promise<void> {
  // Resume: a half-finished crawl keeps what it already has.
  const existing: Record<string, TmsRecord> = fs.existsSync(OUT)
    ? Object.fromEntries(
        (JSON.parse(fs.readFileSync(OUT, 'utf8')) as TmsRecord[]).map((r) => [r.mudid, r])
      )
    : {}

  process.stderr.write(`TMS: collecting mudids (resuming with ${Object.keys(existing).length})\n`)
  const ids = await collectIds()
  process.stderr.write(`TMS: ${ids.length} mudids; fetching detail pages\n`)

  let done = 0
  let failed = 0
  for (const id of ids) {
    done++
    if (existing[id]) continue
    try {
      const html = await politeText(`${BASE}/muddisplay.php?mudid=${encodeURIComponent(id)}`)
      const rec = parseDetail(id, html)
      if (rec) existing[id] = rec
      else failed++
    } catch (err) {
      failed++
      process.stderr.write(`  ! ${id}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
    if (done % 25 === 0) {
      fs.writeFileSync(OUT, JSON.stringify(Object.values(existing), null, 0))
      process.stderr.write(`  ${done}/${ids.length} (${Object.keys(existing).length} parsed, ${failed} failed)\n`)
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(Object.values(existing), null, 0))
  const recs = Object.values(existing)
  process.stderr.write(
    `TMS: done — ${recs.length} records, ${recs.filter((r) => r.host).length} with a usable address, ${failed} failed\n`
  )
}

// Windows path/URL round-tripping makes the usual import.meta.url comparison
// unreliable here, so match on the entry filename instead.
if (process.argv[1]?.endsWith('tms.mts')) {
  await main()
}
