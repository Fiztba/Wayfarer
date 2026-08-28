/**
 * Scandum's MSSP Mud Crawler (tintin.mudhalla.net).
 *
 * One ~2 MB page holding a full MSSP variable dump for every MSSP-speaking MUD
 * it knows — roughly 70 games, but with far more depth than any HTML directory:
 * codebase, family, genre, world counts, protocol support, hiring flags, and
 * live player counts plus a rolling ACTIVE PLAYERS average.
 *
 * The page renders as a fixed-width box-drawing table, two `LABEL  value` pairs
 * per line inside `│ ... │`, one block per MUD starting at PLAYERS.
 *
 * Parsing note that matters for the codebase filters: MSSP's CODEBASE and
 * FAMILY are an ancestry pair, and the spec says to report the most distant
 * ancestor last. LuminariMUD reports CODEBASE=LuminariMUD with FAMILY=tbaMUD,
 * so reading CODEBASE alone loses the tbaMUD relationship entirely. Both fields
 * feed the normaliser.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { politeText, decodeEntities } from '../lib/http.mts'
import { parseSslValue } from '../lib/mssp.mts'

const URL_LIST = 'https://tintin.mudhalla.net/protocols/mssp/mudlist.html'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(here, '..', 'data', 'mssp.json')

export interface MsspRecord {
  name: string
  host: string
  port: number
  codebase: string
  family: string
  genre: string
  subgenre: string
  gameplay: string
  status: string
  created: string
  language: string
  location: string
  players: number | null
  activePlayers: number | null
  rooms: number | null
  areas: number | null
  website: string
  discord: string
  /** Protocol flags as reported: ANSI, MCCP, MXP, MSP, UTF-8, ... */
  protocols: Record<string, string>
  /** MSSP's SSL field is a PORT, not a flag. Null when none is offered. */
  tlsPort: number | null
  /** True when TLS is offered even if the MUD never stated which port. */
  tlsOffered: boolean
  hiringBuilders: boolean
  hiringCoders: boolean
  payToPlay: boolean
}

const PROTOCOL_KEYS = [
  'ANSI', 'UTF-8', 'VT100', 'XTERM 256 COLORS', 'XTERM TRUE COLORS',
  'MCCP', 'MCP', 'MSP', 'MXP', 'GMCP', 'MSDP'
]

const num = (s: string): number | null => {
  const v = Number(String(s).trim())
  return Number.isFinite(v) ? v : null
}
const bool = (s: string): boolean => String(s).trim() === '1'

export function parse(html: string): MsspRecord[] {
  const text = decodeEntities(html.replace(/<[^>]*>/g, ''))
  const rows = [...text.matchAll(/^│(.{120})│$/gm)].map((m) => m[1])

  const muds: Record<string, string>[] = []
  let cur: Record<string, string> = {}
  for (const row of rows) {
    for (const half of [row.slice(0, 60), row.slice(60)]) {
      const m = /^\s*([A-Z0-9 \-]+?)\s{2,}(.*)$/.exec(half)
      if (!m) continue
      const key = m[1].trim()
      const val = m[2].trim()
      if (!key) continue
      // Each MUD's block starts at PLAYERS; that's the record separator.
      if (key === 'PLAYERS' && Object.keys(cur).length) {
        muds.push(cur)
        cur = {}
      }
      cur[key] = val
    }
  }
  if (Object.keys(cur).length) muds.push(cur)

  return muds
    .filter((m) => m.HOSTNAME && m.PORT)
    .map((m) => ({
      name: m.NAME || m.HOSTNAME,
      host: m.HOSTNAME.toLowerCase(),
      port: Number(m.PORT) || 0,
      codebase: m.CODEBASE ?? '',
      family: m.FAMILY ?? '',
      genre: m.GENRE ?? '',
      subgenre: m.SUBGENRE ?? '',
      gameplay: m.GAMEPLAY ?? '',
      status: m.STATUS ?? '',
      created: m.CREATED ?? '',
      language: m.LANGUAGE ?? '',
      location: m.LOCATION ?? '',
      players: num(m.PLAYERS ?? ''),
      activePlayers: num(m['ACTIVE PLAYERS'] ?? ''),
      rooms: num(m.ROOMS ?? ''),
      areas: num(m.AREAS ?? ''),
      website: m.WEBSITE ?? '',
      discord: m.DISCORD ?? '',
      protocols: Object.fromEntries(
        PROTOCOL_KEYS.filter((k) => m[k] !== undefined && m[k] !== '').map((k) => [k, m[k]])
      ),
      tlsPort: parseSslValue(m.SSL).port,
      tlsOffered: parseSslValue(m.SSL).offered,
      hiringBuilders: bool(m['HIRING BUILDERS'] ?? ''),
      hiringCoders: bool(m['HIRING CODERS'] ?? ''),
      payToPlay: bool(m['PAY TO PLAY'] ?? '')
    }))
    .filter((r) => r.port > 0 && r.port <= 65535)
}

export async function build(): Promise<MsspRecord[]> {
  const recs = parse(await politeText(URL_LIST, { timeoutMs: 90_000 }))
  process.stderr.write(
    `MSSP: ${recs.length} records (${recs.filter((r) => r.codebase).length} with a codebase)\n`
  )
  return recs
}

if (process.argv[1]?.endsWith('mssp.mts')) {
  fs.writeFileSync(OUT, JSON.stringify(await build(), null, 0))
}
