/**
 * The MUD directory snapshot: shape shared by the offline builder
 * (scripts/directory) and the app that consumes it.
 *
 * The app never talks to the directory sites. A CI job unions the sources,
 * probes every address, and publishes one JSON file; Wayfarer downloads that
 * and caches it. One prober instead of one per install, and a MUD list that
 * improves without shipping an app update.
 */

/** How a MUD responded the last time its address was probed. */
export type ProbeState = 'up' | 'closed' | 'nodns'

/**
 * Liveness tier, driven by consecutive failed probes.
 *
 * A single failure never buries a MUD: probes produce false negatives (a MUD
 * mid-reboot, a v6-only host, a bad network moment), and one of the two live
 * tbaMUDs in the corpus read as dead on its first probe. Entries decay through
 * tiers instead, and `buried` is never permanent — a vanished domain costs only
 * a DNS lookup to re-check, so it keeps getting one.
 */
export type Liveness = 'live' | 'ailing' | 'dormant' | 'buried'

export interface DirectoryAddress {
  host: string
  port: number
  state: ProbeState
}

export interface DirectoryMud {
  /** Stable across rebuilds: normalised name + port. */
  id: string
  name: string
  host: string
  port: number
  /** Present when a source reports a distinct TLS port. */
  tlsPort: number | null

  /** Other addresses sources gave for this MUD, kept for diagnosis. */
  alternates: DirectoryAddress[]

  /** Short source keys: tmc, tms, mssp, vineyard, grapevine, mudverse. */
  sources: string[]

  /** Canonical codebase, most specific label on a shared lineage. */
  codebase: string | null
  /** Root of that lineage. */
  family: string | null
  /** Every level of the lineage, so a filter at any level matches. */
  ancestry: string[]
  /** Raw strings the sources actually used. */
  codebaseRaw: string[]
  /** Sources named codebases on different lineages — treat with suspicion. */
  codebaseConflict: boolean

  categories: string[]
  genre: string | null
  gameplay: string | null
  language: string | null
  location: string | null
  created: number | null
  rooms: number | null
  areas: number | null
  players: number | null
  /** MSSP's rolling average — separates "busy now" from "busy generally". */
  activePlayers: number | null
  website: string | null
  discord: string | null
  tagline: string | null
  /** The Mud Connector's rank, where it has one. */
  rank: number | null

  /** Advertised protocol support, e.g. ANSI, MXP, MSP, MCCP, SSL, GMCP, MSDP. */
  protocols: string[]
  hiringBuilders: boolean
  hiringCoders: boolean
  payToPlay: boolean

  state: ProbeState
  liveness: Liveness
  /** ISO date of the last successful probe, or null if never seen up. */
  lastSeenUp: string | null
  /** Consecutive failed probes. */
  strikes: number
}

export interface DirectorySnapshot {
  version: 1
  builtAt: string
  counts: {
    total: number
    live: number
    withCodebase: number
    bySource: Record<string, number>
  }
  muds: DirectoryMud[]
}

/** Failed probes before a MUD drops out of the default view / slows its recheck. */
export const STRIKE_TIERS = { ailing: 1, dormant: 4, buried: 12 } as const

export function livenessFor(state: ProbeState, strikes: number): Liveness {
  if (state === 'up') return 'live'
  if (strikes >= STRIKE_TIERS.buried) return 'buried'
  if (strikes >= STRIKE_TIERS.dormant) return 'dormant'
  return 'ailing'
}
