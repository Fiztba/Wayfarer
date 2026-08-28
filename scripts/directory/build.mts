/**
 * Build the directory snapshot: union the sources, probe every address, merge
 * duplicates, and emit one JSON file for the app.
 *
 * Order matters. Probing happens *before* merging because the only way to
 * settle two rival addresses for one MUD is to see which answers — neither
 * source is reliably fresher than the other.
 *
 * Run with `npm run directory:build`. Sources are refreshed by their own
 * scripts; this reads whatever is in data/ so a partial set still builds.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveMany } from './lib/codebases.mts'
import { probeAll } from './lib/probe.mts'
import { groupDuplicates, pickAddress, nameKey, type Candidate } from './lib/merge.mts'
import { parseSslValue } from './lib/mssp.mts'
import { livenessFor, type DirectoryMud, type DirectorySnapshot } from '../../src/shared/directory.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(here, 'data')
const OUT = path.join(here, '..', '..', 'public-data', 'directory.json')

/**
 * If a build sees far more failures than the last one did, assume the network
 * or DNS is broken here rather than that the MUD world died overnight, and
 * refuse to record it. Without this, one bad run buries the whole directory.
 */
const FAILURE_SPIKE_LIMIT = 0.15

function load<T>(name: string): T[] {
  const p = path.join(DATA, `${name}.json`)
  if (!fs.existsSync(p)) {
    process.stderr.write(`  (no ${name}.json — skipping that source)\n`)
    return []
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T[]
}

const NO_TLS_OFFER = { offered: false, port: null }

const asNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const asStr = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s.length ? s : null
}

async function main(): Promise<void> {
  process.stderr.write('Loading sources\n')
  const tmc = load<Record<string, unknown>>('tmc')
  const tms = load<Record<string, unknown>>('tms')
  const mssp = load<Record<string, unknown>>('mssp')
  const vineyard = load<Record<string, unknown>>('vineyard')
  const grapevine = load<Record<string, unknown>>('grapevine')
  const mudverse = load<Record<string, unknown>>('mudverse')

  // ---- candidates -------------------------------------------------------
  // Everything with a real address becomes a candidate. Grapevine has no
  // host/port at all, so it is held back and only ever enriches by name.
  const candidates: Candidate[] = []
  const push = (source: string, r: Record<string, unknown>): void => {
    const host = String(r.host ?? '').toLowerCase().trim()
    const port = Number(r.port ?? 0)
    if (!host || !(port > 0 && port <= 65535)) return
    candidates.push({ ...r, name: String(r.name ?? host), host, port, sources: [source] })
  }
  for (const r of tmc) push('tmc', r)
  for (const r of tms) push('tms', r)
  for (const r of mssp) push('mssp', r)
  for (const r of vineyard) push('vineyard', r)
  for (const r of mudverse) push('mudverse', r)
  // Grapevine used to enrich by name only, because its listing pages carry no
  // address. Now that each game's own page supplies one, it can create entries
  // too — without which 56 online games were missing from the directory
  // outright, NukeFire and its 62 players among them.
  for (const r of grapevine) push('grapevine', r)

  process.stderr.write(
    `  tmc=${tmc.length} tms=${tms.length} mssp=${mssp.length} vineyard=${vineyard.length} ` +
      `grapevine=${grapevine.length} mudverse=${mudverse.length} → ${candidates.length} addressed candidates\n`
  )

  // ---- probe ------------------------------------------------------------
  const targets = [...new Map(candidates.map((c) => [`${c.host}:${c.port}`, c])).values()].map(
    (c) => ({ host: c.host, port: c.port })
  )
  process.stderr.write(`Probing ${targets.length} distinct addresses\n`)
  const probes = await probeAll(targets, {
    concurrency: 40,
    onProgress: (d, t) => process.stderr.write(`  ${d}/${t}\r`)
  })
  process.stderr.write('\n')

  const failureRate =
    targets.length === 0 ? 0 : [...probes.values()].filter((p) => p.state !== 'up').length / targets.length
  process.stderr.write(`  failure rate ${(failureRate * 100).toFixed(1)}%\n`)

  // ---- carry previous liveness state forward ----------------------------
  const previous: DirectorySnapshot | null = fs.existsSync(OUT)
    ? (JSON.parse(fs.readFileSync(OUT, 'utf8')) as DirectorySnapshot)
    : null
  const prevById = new Map((previous?.muds ?? []).map((m) => [m.id, m]))

  if (previous) {
    const prevFail =
      previous.counts.total === 0 ? 0 : 1 - previous.counts.live / previous.counts.total
    if (failureRate > prevFail + FAILURE_SPIKE_LIMIT) {
      process.stderr.write(
        `ABORT: failure rate ${(failureRate * 100).toFixed(1)}% is more than ` +
          `${FAILURE_SPIKE_LIMIT * 100} points above the previous build's ` +
          `${(prevFail * 100).toFixed(1)}%. That looks like a broken network here, ` +
          `not a dead MUD world. Snapshot left unchanged.\n`
      )
      process.exitCode = 2
      return
    }
  }

  // ---- merge ------------------------------------------------------------
  const groups = groupDuplicates(candidates)
  process.stderr.write(`Merging ${candidates.length} candidates → ${groups.length} MUDs\n`)

  // Grapevine joins by name only.
  const gvByName = new Map(grapevine.map((g) => [nameKey(String(g.name ?? '')), g]))

  const today = new Date().toISOString().slice(0, 10)
  const muds: DirectoryMud[] = []

  for (const idxs of groups) {
    const group = idxs.map((i) => candidates[i])
    const chosen = pickAddress(group, probes)
    const sources = [...new Set(group.flatMap((g) => g.sources))].sort()

    // Longest name wins: sources abbreviate differently and the fuller form is
    // almost always the real title.
    const name = group.map((g) => String(g.name)).sort((a, b) => b.length - a.length)[0]
    const gv = gvByName.get(nameKey(name))
    if (gv) sources.push('grapevine')

    // MSSP the MUD told us itself during the probe. First-party and current,
    // where the directories are second-hand and often years stale.
    const liveMssp: Record<string, string>[] = group
      .map((g) => probes.get(`${g.host}:${g.port}`)?.mssp)
      .filter((m): m is Record<string, string> => Boolean(m && Object.keys(m).length))

    const codebase = resolveMany([
      ...group.map((g) => asStr(g.codebase) ?? undefined),
      // MSSP reports CODEBASE and FAMILY as an ancestry pair; both count.
      ...group.map((g) => asStr(g.family) ?? undefined),
      ...liveMssp.map((m) => m.CODEBASE),
      ...liveMssp.map((m) => m.FAMILY),
      gv ? (asStr(gv.codebase) ?? undefined) : undefined
    ])

    /** Prefer what the MUD said about itself over what a directory recorded. */
    const fromMssp = (key: string): string | null => {
      for (const m of liveMssp) {
        const v = (m[key] ?? '').trim()
        if (v && v !== '-1') return v
      }
      return null
    }
    const msspNum = (key: string): number | null => {
      const v = fromMssp(key)
      const n = v === null ? NaN : Number(v)
      return Number.isFinite(n) && n >= 0 ? n : null
    }

    const first = <T,>(pick: (c: Candidate) => T | null | undefined): T | null => {
      for (const g of group) {
        const v = pick(g)
        if (v !== null && v !== undefined && v !== '') return v
      }
      return null
    }

    // Two independent sources of protocol support: what a directory recorded,
    // and what the MUD itself announced during the probe. The probe is the
    // better one — it covers every live MUD rather than the ~60 the MSSP
    // crawler knows, and it is the only place GMCP and MSDP show up at all.
    const protocols = new Set<string>()
    for (const g of group) {
      const p = g.protocols as Record<string, string> | undefined
      if (p) for (const [k, v] of Object.entries(p)) if (v === '1') protocols.add(k)
      for (const found of probes.get(`${g.host}:${g.port}`)?.protocols ?? []) protocols.add(found)
    }

    // TLS is not a flag. MSSP defines SSL as the port number of the encrypted
    // listener, and for all but one MUD in the corpus that port differs from
    // the telnet one — Beutelland is 5678 plain and 5679 secure. Reading it as
    // a boolean lost both most of the TLS-capable MUDs and every port.
    const tls = [
      // Whatever a source recorded directly (MUDVerse gives tls_port).
      ...group.map((g) => parseSslValue(asNum(g.tlsPort))),
      // The crawler's SSL field, now carried through as a port.
      ...group.map((g) => (g.tlsOffered === true ? parseSslValue(asNum(g.tlsPort) ?? 1) : NO_TLS_OFFER)),
      // And what the MUD told us itself during the handshake.
      ...liveMssp.map((m) => parseSslValue(m.SSL))
    ]
    const tlsPort = tls.find((t) => t.port !== null)?.port ?? null
    const tlsOffered = tls.some((t) => t.offered)
    if (tlsOffered) protocols.add('SSL')

    const id = `${nameKey(name) || chosen.host}-${chosen.port}`
    const prev = prevById.get(id)
    const up = chosen.state === 'up'
    const strikes = up ? 0 : (prev?.strikes ?? 0) + 1

    muds.push({
      id,
      name,
      host: chosen.host,
      port: chosen.port,
      tlsPort,
      tlsOffered,
      alternates: group
        .filter((g) => g.host !== chosen.host || g.port !== chosen.port)
        .map((g) => ({
          host: g.host,
          port: g.port,
          state: probes.get(`${g.host}:${g.port}`)?.state ?? 'nodns'
        })),
      sources: [...new Set(sources)].sort(),
      codebase: codebase.codebase,
      family: codebase.family,
      ancestry: codebase.ancestry,
      codebaseRaw: codebase.raw,
      codebaseConflict: codebase.conflict,
      categories: [...new Set(group.flatMap((g) => (g.categories as string[]) ?? []))].sort(),
      genre: fromMssp('GENRE') ?? first((g) => asStr(g.genre)),
      gameplay: fromMssp('GAMEPLAY') ?? first((g) => asStr(g.gameplay)),
      language: fromMssp('LANGUAGE') ?? first((g) => asStr(g.language)),
      location: fromMssp('LOCATION') ?? first((g) => asStr(g.location)),
      created: msspNum('CREATED') ?? first((g) => asNum(g.yearCreated) ?? (asStr(g.created) ? Number(g.created) : null)),
      rooms: msspNum('ROOMS') ?? first((g) => asNum(g.rooms)),
      areas: msspNum('AREAS') ?? first((g) => asNum(g.areas)),
      players: msspNum('PLAYERS') ?? first((g) => asNum(g.players)),
      activePlayers: first((g) => asNum(g.activePlayers)),
      website: fromMssp('WEBSITE') ?? first((g) => asStr(g.website)),
      discord: fromMssp('DISCORD') ?? first((g) => asStr(g.discord)),
      tagline: gv ? asStr(gv.tagline) : first((g) => asStr(g.intro)),
      rank: first((g) => asNum(g.rank)),
      protocols: [...protocols].sort(),
      hiringBuilders: group.some((g) => g.hiringBuilders === true) || fromMssp('HIRING BUILDERS') === '1',
      hiringCoders: group.some((g) => g.hiringCoders === true) || fromMssp('HIRING CODERS') === '1',
      payToPlay: group.some((g) => g.payToPlay === true) || fromMssp('PAY TO PLAY') === '1',
      state: chosen.state,
      liveness: livenessFor(chosen.state, strikes),
      lastSeenUp: up ? today : (prev?.lastSeenUp ?? null),
      strikes
    })
  }

  muds.sort((a, b) => a.name.localeCompare(b.name))

  const bySource: Record<string, number> = {}
  for (const m of muds) for (const s of m.sources) bySource[s] = (bySource[s] ?? 0) + 1

  const snapshot: DirectorySnapshot = {
    version: 1,
    builtAt: new Date().toISOString(),
    counts: {
      total: muds.length,
      live: muds.filter((m) => m.state === 'up').length,
      withCodebase: muds.filter((m) => m.codebase).length,
      bySource
    },
    muds
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(snapshot))
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0)

  process.stderr.write(
    `\nDone — ${snapshot.counts.total} MUDs, ${snapshot.counts.live} live, ` +
      `${snapshot.counts.withCodebase} with a codebase (${kb} KB)\n` +
      `  sources: ${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join(' ')}\n` +
      `  conflicts: ${muds.filter((m) => m.codebaseConflict).length}\n`
  )
}

await main()
