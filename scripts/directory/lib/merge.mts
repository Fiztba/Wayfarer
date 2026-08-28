/**
 * Union and de-duplication across sources.
 *
 * host:port is the obvious key and it is not sufficient. Two cases found in the
 * data, pointing in opposite directions:
 *
 *   The Darkening Sun   TMS has darkeningsun.org:5678 (domain gone)
 *                       Vineyard has darkeningsun.com:5678 (up)
 *   CyberASSAULT        TMC has cyberassault.ddns.net:11111 (domain gone)
 *                       TMS has cyberassault.org:11111 (up)
 *
 * Same MUD, same port, different hostname — and neither source is reliably the
 * fresher one, so there is no "prefer source X" rule to fall back on. The only
 * thing that settles it is which address answers, which is why merging happens
 * *after* probing rather than before.
 *
 * The join is deliberately conservative: identical normalised name AND (same
 * port OR a shared distinctive host label). Name alone would collide unrelated
 * MUDs; requiring both has so far produced no false merges in the corpus.
 */
import type { ProbeResult } from './probe.mts'

/** Suffixes that carry no identity — TLDs and dynamic-DNS providers. */
const NOISE_LABELS = new Set([
  'com', 'org', 'net', 'us', 'uk', 'co', 'io', 'de', 'nl', 'se', 'ru', 'br',
  'ca', 'au', 'eu', 'info', 'biz', 'me', 'gg', 'haus', 'games', 'game',
  'dyndns', 'ddns', 'hopto', 'no-ip', 'noip', 'dhs', 'kicks-ass', 'dnsalias',
  'zapto', 'servegame', 'servegame', 'mine', 'is-a-geek', 'mudhosting',
  'www', 'mud', 'muds', 'play', 'server', 'game1'
])

/**
 * Collapse a MUD name to a comparison key.
 *
 * The trailing game-type word has to come off whether or not a space precedes
 * it. Sources write the same game both ways — Grapevine says "Luminari MUD"
 * where the snapshot has "LuminariMUD" — and stripping only the spaced form
 * left those as two different MUDs.
 *
 * The stem-length guard stops the strip from eating names that merely end in
 * those letters: "Talmud" keeps its tail, "LuminariMUD" loses it.
 */
export function nameKey(name: string): string {
  let s = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  s = s.replace(/^the\s+/, '')
  s = s.replace(/\s+/g, '')
  const stripped = s.replace(/(mud|mush|muck|moo|mux)$/, '')
  return stripped.length >= 4 ? stripped : s
}

/** Distinctive labels in a hostname, minus TLDs and dynamic-DNS providers. */
export function hostLabels(host: string): Set<string> {
  return new Set(
    (host ?? '')
      .toLowerCase()
      .split('.')
      .filter((l) => l.length > 2 && !NOISE_LABELS.has(l))
  )
}

export interface Candidate {
  name: string
  host: string
  port: number
  sources: string[]
  [k: string]: unknown
}

function sharesLabel(a: string, b: string): boolean {
  const la = hostLabels(a)
  for (const l of hostLabels(b)) if (la.has(l)) return true
  return false
}

/**
 * Group candidates that are the same MUD.
 *
 * Returns groups of indices into `items`. Union-find keeps this transitive, so
 * three addresses for one MUD collapse into a single group rather than a chain
 * of pairs.
 */
export function groupDuplicates(items: Candidate[]): number[][] {
  const parent = items.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] }
    return i
  }
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  // Exact address match is unambiguous.
  const byAddress = new Map<string, number>()
  items.forEach((it, i) => {
    const k = `${it.host}:${it.port}`
    const prev = byAddress.get(k)
    if (prev === undefined) byAddress.set(k, i)
    else union(prev, i)
  })

  // Then same name plus a corroborating signal.
  const byName = new Map<string, number[]>()
  items.forEach((it, i) => {
    const k = nameKey(it.name)
    if (!k) return
    const arr = byName.get(k)
    if (arr) arr.push(i)
    else byName.set(k, [i])
  })
  for (const idxs of byName.values()) {
    if (idxs.length < 2) continue
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const x = items[idxs[a]], y = items[idxs[b]]
        if (x.port === y.port || sharesLabel(x.host, y.host)) union(idxs[a], idxs[b])
      }
    }
  }

  const groups = new Map<number, number[]>()
  items.forEach((_, i) => {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(i)
    else groups.set(r, [i])
  })
  return [...groups.values()]
}

/**
 * Pick the address a group should present.
 *
 * Live beats everything. Failing that, a host that at least resolves beats one
 * that does not, and TMC's own "connected" flag breaks remaining ties since it
 * is the only source-side liveness signal worth anything.
 */
export function pickAddress(
  group: Candidate[],
  probes: Map<string, ProbeResult>
): { host: string; port: number; state: ProbeResult['state'] } {
  const score = (c: Candidate): number => {
    const p = probes.get(`${c.host}:${c.port}`)
    if (p?.state === 'up') return 3
    if (p?.state === 'closed') return 2
    if (c.connected === true) return 1
    return 0
  }
  const best = group.reduce((a, b) => (score(b) > score(a) ? b : a))
  return {
    host: best.host,
    port: best.port,
    state: probes.get(`${best.host}:${best.port}`)?.state ?? 'nodns'
  }
}
