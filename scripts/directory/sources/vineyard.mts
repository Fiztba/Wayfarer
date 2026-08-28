/**
 * Vineyard (vineyard.haus) — Jason Babo's free MUD hosting.
 *
 * Small (about 30 games) but unusually high quality: hand-curated, every entry
 * is live by construction because he hosts them, and the "Server" column is
 * already normalised (CircleMUD, ROM, LPMUD, ...) rather than the free text
 * every other source carries.
 *
 * It skews hard toward Circle/Diku — roughly half the list — which makes it
 * disproportionately useful for the codebase filters even at this size. It is
 * also the only source that has the current address for some MUDs: The
 * Darkening Sun is listed here on .com and up, while TMS has it on .org and
 * dead.
 *
 * Historical note, because the URL is surprising: mudmagic.com now 301s to
 * vineyard.haus. Kyndig wound the old MUD Magic site down, his ex-wife ran only
 * the hosting side afterwards, and Jason bought the domain to catch people
 * still looking for that hosting. mudmagic is not a directory any more.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { politeText, decodeEntities } from '../lib/http.mts'

const URL_MUDS = 'https://vineyard.haus/muds'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(here, '..', 'data', 'vineyard.json')

export interface VineyardRecord {
  name: string
  host: string
  port: number
  codebase: string
}

export function parse(html: string): VineyardRecord[] {
  const out: VineyardRecord[] = []
  for (const row of html.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      decodeEntities(m[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
    )
    if (cells.length < 3 || !cells[0]) continue
    // Connection cell reads "host 1234" (space-separated, not a colon).
    const conn = /^([A-Za-z0-9._-]+)\s+(\d{1,5})$/.exec(cells[2])
    if (!conn) continue
    out.push({
      name: cells[0],
      host: conn[1].toLowerCase(),
      port: Number(conn[2]),
      codebase: cells[1]
    })
  }
  return out
}

export async function build(): Promise<VineyardRecord[]> {
  const recs = parse(await politeText(URL_MUDS))
  process.stderr.write(`Vineyard: ${recs.length} records\n`)
  return recs
}

if (process.argv[1]?.endsWith('vineyard.mts')) {
  fs.writeFileSync(OUT, JSON.stringify(await build(), null, 0))
}
