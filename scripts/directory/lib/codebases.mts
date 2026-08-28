/**
 * Codebase normalisation.
 *
 * Every source spells codebases differently and none of them agree. Observed in
 * the wild for one family alone: "tbaMud" (Top Mud Sites), "TBA" (The Mud
 * Connector), "tbaMUD" (MSSP), "TbaMUD" (Grapevine), and The Builder Academy
 * filed as plain "CircleMUD" by its own host. Free-text sources are worse —
 * "ROM", "rom 2.4", "ROM 2.4b6 completely retooled", "ROM2.4/Haven",
 * "Rom (EoT Custom)" are all one codebase.
 *
 * So a codebase filter cannot be string equality. This maps any raw string onto
 * a canonical name plus its ancestry, which is what makes "show me tbaMUDs"
 * work: The Builder Academy is labelled CircleMUD everywhere, and LuminariMUD
 * reports CODEBASE=LuminariMUD with FAMILY=tbaMUD, yet both belong in the
 * answer.
 *
 * Lineage is asserted only where it is well established. Codebases whose
 * ancestry is genuinely unclear get a canonical name and no parent rather than
 * a guess — a wrong edge here silently corrupts every filter above it.
 */

export interface CodebaseNode {
  /** Canonical display name. */
  name: string
  /** Immediate ancestor's canonical name, or null when unrooted. */
  parent: string | null
  /** Lowercase match strings; longest wins, so put specific ones in. */
  aliases: string[]
}

export const CODEBASES: CodebaseNode[] = [
  // ---- DikuMUD line -------------------------------------------------------
  { name: 'DikuMUD', parent: null, aliases: ['dikumud', 'diku', 'diku ii', 'diku 2'] },
  { name: 'Merc', parent: 'DikuMUD', aliases: ['merc'] },
  { name: 'ROM', parent: 'Merc', aliases: ['rom', 'rom 2.4', 'rom2.4', 'rom 2.3'] },
  { name: 'RoT', parent: 'ROM', aliases: ['rot', 'realms of torment'] },
  { name: 'Anatolia', parent: 'Merc', aliases: ['anatolia'] },
  { name: 'EmberMUD', parent: 'Merc', aliases: ['embermud', 'ember'] },
  { name: 'Envy', parent: 'Merc', aliases: ['envy'] },
  { name: 'GodWars', parent: 'Merc', aliases: ['godwars', 'god wars', 'gw: deluxe', 'godwars: deluxe'] },
  { name: 'SMAUG', parent: 'Merc', aliases: ['smaug'] },
  { name: 'SmaugFUSS', parent: 'SMAUG', aliases: ['smaugfuss', 'smaug fuss'] },
  { name: 'AFKMud', parent: 'SMAUG', aliases: ['afkmud', 'afk mud'] },
  { name: 'Star Wars Reality', parent: 'SMAUG', aliases: ['swr', 'star wars reality', 'swfote'] },
  { name: 'ResortMUD', parent: 'SMAUG', aliases: ['resortmud'] },
  { name: 'CircleMUD', parent: 'DikuMUD', aliases: ['circlemud', 'circle', 'circle/nukefire', 'nukefire'] },
  { name: 'tbaMUD', parent: 'CircleMUD', aliases: ['tbamud', 'tba', 'tba mud'] },
  { name: 'LuminariMUD', parent: 'tbaMUD', aliases: ['luminarimud', 'luminari'] },
  { name: 'Dawn of Time', parent: 'DikuMUD', aliases: ['dawn of time', 'dawn'] },
  { name: 'Silly', parent: 'DikuMUD', aliases: ['sillymud', 'silly'] },
  { name: 'DalekMUD', parent: 'DikuMUD', aliases: ['dalemud', 'dalekmud'] },
  { name: 'NiMUD', parent: 'Merc', aliases: ['nimud'] },
  { name: 'EmlenMUD', parent: 'Merc', aliases: ['emlenmud', 'emlen'] },

  // ---- LPMud line ---------------------------------------------------------
  { name: 'LPMud', parent: null, aliases: ['lpmud', 'lp mud', 'lp', 'lpc'] },
  { name: 'MudOS', parent: 'LPMud', aliases: ['mudos'] },
  { name: 'FluffOS', parent: 'MudOS', aliases: ['fluffos'] },
  { name: 'LDMud', parent: 'LPMud', aliases: ['ldmud'] },
  { name: 'DGD', parent: 'LPMud', aliases: ['dgd'] },
  { name: 'Discworld lib', parent: 'LPMud', aliases: ['discworld lib', 'discworld'] },
  { name: 'TMI-2', parent: 'LPMud', aliases: ['tmi-2', 'tmi2', 'tmi'] },
  { name: 'Nightmare', parent: 'LPMud', aliases: ['nightmare', 'nightmare iii'] },

  // ---- MOO line -----------------------------------------------------------
  { name: 'MOO', parent: null, aliases: ['moo'] },
  { name: 'LambdaMOO', parent: 'MOO', aliases: ['lambdamoo'] },
  { name: 'ToastStunt', parent: 'LambdaMOO', aliases: ['toaststunt', 'lambdamoo-toaststunt', 'stunt'] },

  // ---- TinyMUD line (MUSH / MUCK / MUX) -----------------------------------
  { name: 'TinyMUD', parent: null, aliases: ['tinymud'] },
  { name: 'MUSH', parent: 'TinyMUD', aliases: ['mush'] },
  { name: 'TinyMUSH', parent: 'MUSH', aliases: ['tinymush'] },
  { name: 'PennMUSH', parent: 'MUSH', aliases: ['pennmush'] },
  { name: 'MUX', parent: 'MUSH', aliases: ['mux', 'tinymux'] },
  { name: 'RhostMUSH', parent: 'MUSH', aliases: ['rhostmush', 'rhost'] },
  { name: 'MUCK', parent: 'TinyMUD', aliases: ['muck', 'tinymuck'] },
  { name: 'GlowMUCK', parent: 'MUCK', aliases: ['glowmuck'] },
  { name: 'ProtoMUCK', parent: 'MUCK', aliases: ['protomuck'] },
  { name: 'MUSE', parent: 'TinyMUD', aliases: ['muse'] },

  // ---- Independent engines ------------------------------------------------
  // Deliberately unrooted: these are their own lineages, not Diku descendants,
  // even where they were Diku-inspired.
  { name: 'CoffeeMud', parent: null, aliases: ['coffeemud', 'coffee mud'] },
  { name: 'Evennia', parent: null, aliases: ['evennia'] },
  { name: 'Ranvier', parent: null, aliases: ['ranvier'] },
  { name: 'ExVenture', parent: null, aliases: ['exventure'] },
  { name: 'Mordor', parent: null, aliases: ['mordor'] },
  { name: 'AberMUD', parent: null, aliases: ['abermud', 'aber'] },
  { name: 'SocketMUD', parent: null, aliases: ['socketmud', 'nakedmud', 'nekkidmud'] },
  { name: 'ColdMud', parent: null, aliases: ['coldmud', 'cold'] },
  { name: 'DUM', parent: null, aliases: ['dum'] },
  { name: 'Valhalla MUD Engine', parent: null, aliases: ['vme', 'valhalla mud engine', 'valhalla'] },
  { name: 'Eye of the Storm', parent: null, aliases: ['eos', 'eosii', 'eye of the storm'] },
  { name: 'AckMUD', parent: null, aliases: ['ackmud', 'ack!mud', 'ack mud'] },
  { name: 'AweMUD', parent: null, aliases: ['awemud'] },
  { name: 'Aime', parent: null, aliases: ['aime'] },
  { name: 'WURM', parent: null, aliases: ['wurm'] },
  { name: 'Rapture', parent: null, aliases: ['rapture'] },
  { name: 'Crimson', parent: null, aliases: ['crimson'] },
  { name: 'Oblivion', parent: null, aliases: ['oblivion'] },
  { name: 'Chronicles', parent: null, aliases: ['chronicles'] },
  { name: 'Mythran', parent: null, aliases: ['mythran'] },
  { name: 'HeavyMUD', parent: null, aliases: ['heavymud'] },
  { name: 'DeltaMUD', parent: null, aliases: ['deltamud'] },
  { name: 'PAiN MUD', parent: null, aliases: ['pain mud', 'painmud'] },
  { name: 'The Forests Edge', parent: null, aliases: ['tfe', 'the forests edge', "the forest's edge"] },
  { name: 'UberMUD', parent: null, aliases: ['ubermud', 'uber'] },
  { name: 'Sunder', parent: null, aliases: ['sunder'] },
  { name: 'Copper', parent: null, aliases: ['copper'] },
  { name: 'Dragonball', parent: null, aliases: ['dragonball'] },
  { name: 'Custom', parent: null, aliases: ['custom', 'custom (written from scratch)', 'original'] }
]

const BY_NAME = new Map(CODEBASES.map((c) => [c.name, c]))

/** Aliases longest-first, so "smaugfuss" beats "smaug" and "tbamud" beats "tba". */
const ALIAS_INDEX: { alias: string; name: string }[] = CODEBASES
  .flatMap((c) => c.aliases.map((alias) => ({ alias, name: c.name })))
  .sort((a, b) => b.alias.length - a.alias.length)

/**
 * Reduce a raw label to something matchable: lowercase, drop version numbers,
 * bracketed asides and punctuation noise.
 */
export function simplify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    // "ROM2.4/Haven" runs the name straight into the version with no
    // separator, which leaves no word boundary for the version strip or the
    // alias match to land on. Split letter-digit joins first.
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/\bv?\d+(\.\d+)*[a-z]?\d*\b/g, ' ')
    .replace(/[_/,+]/g, ' ')
    .replace(/[^a-z0-9!.\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface Resolved {
  /** Canonical codebase, or null when nothing matched. */
  codebase: string | null
  /** Root of the lineage — the broad family bucket. */
  family: string | null
  /** Specific → general, e.g. ['tbaMUD','CircleMUD','DikuMUD']. */
  ancestry: string[]
}

function ancestryOf(name: string): string[] {
  const chain: string[] = []
  let cur: string | null = name
  const guard = new Set<string>()
  while (cur && !guard.has(cur)) {
    guard.add(cur)
    chain.push(cur)
    cur = BY_NAME.get(cur)?.parent ?? null
  }
  return chain
}

/** Map any raw codebase string onto canonical name + ancestry. */
export function resolveCodebase(raw: string): Resolved {
  const s = simplify(raw ?? '')
  if (!s) return { codebase: null, family: null, ancestry: [] }

  // Whole-word alias match, longest alias first, so version noise and trailing
  // commentary ("ROM 2.4b6 completely retooled") do not defeat the match.
  for (const { alias, name } of ALIAS_INDEX) {
    const pattern = new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\!]/g, '\\$&')}([^a-z0-9]|$)`)
    if (pattern.test(s)) {
      const ancestry = ancestryOf(name)
      return { codebase: name, family: ancestry[ancestry.length - 1], ancestry }
    }
  }
  return { codebase: null, family: null, ancestry: [] }
}

export interface Verdict extends Resolved {
  /** Every raw label any source supplied. */
  raw: string[]
  /** Distinct canonical codebases the sources named. */
  candidates: string[]
  /** True only when sources named codebases on *different* lineages. */
  conflict: boolean
}

/**
 * Combine several raw labels for one MUD — different sources, or MSSP's
 * CODEBASE + FAMILY pair — into a single verdict.
 *
 * The rule is precision wins along a shared lineage. tbaMUD is a subset of
 * CircleMUD, so a MUD that TMC calls tbaMUD and Vineyard calls CircleMUD is a
 * tbaMUD; SMAUG is a subset of Merc, so SMAUG beats Merc the same way. Formally
 * we look for the one candidate whose own ancestry contains every other
 * candidate, which is exactly "most specific point on a single chain".
 *
 * When no candidate covers the others the sources genuinely disagree — SMAUG
 * versus LPMud is not a precision difference, and picking the deeper of two
 * unrelated labels would be arbitrary. Those keep the most-corroborated label
 * and set `conflict`, so a wrong answer is visible instead of silent.
 *
 * `ancestry` is the union across candidates, so a filter at any level of the
 * tree still matches the MUD.
 */
export function resolveMany(raws: (string | null | undefined)[]): Verdict {
  // Several sources often supply the same string; the raw list is surfaced in
  // the UI as "what the sources actually said", so repeats are just noise.
  const raw = [...new Set(raws.filter((r): r is string => Boolean(r && r.trim())).map((r) => r.trim()))]
  const hits = raw.map(resolveCodebase).filter((r) => r.codebase)
  if (hits.length === 0) {
    return { codebase: null, family: null, ancestry: [], raw, candidates: [], conflict: false }
  }

  // "Custom" is a source declining to name a codebase, not a claim that
  // competes with one. If anything else was named, it does not get a vote and
  // does not count as a conflict.
  const named = [...new Set(hits.map((h) => h.codebase as string))]
  const candidates = named.length > 1 ? named.filter((c) => c !== 'Custom') : named
  const union = new Set<string>()
  for (const h of hits) {
    if (h.codebase === 'Custom' && candidates.length && !candidates.includes('Custom')) continue
    for (const a of h.ancestry) union.add(a)
  }

  // The most specific label on a shared chain: its ancestry covers the rest.
  const covering = candidates.filter((c) => {
    const anc = new Set(ancestryOf(c))
    return candidates.every((other) => anc.has(other))
  })

  if (covering.length === 1) {
    const ancestry = ancestryOf(covering[0])
    return {
      codebase: covering[0],
      family: ancestry[ancestry.length - 1],
      ancestry: [...union],
      raw,
      candidates,
      conflict: false
    }
  }

  // Genuine disagreement: go with whichever label the most sources named,
  // breaking ties toward the more specific one, and flag it.
  const votes = new Map<string, number>()
  for (const h of hits) votes.set(h.codebase as string, (votes.get(h.codebase as string) ?? 0) + 1)
  const winner = candidates.reduce((a, b) => {
    const va = votes.get(a) ?? 0
    const vb = votes.get(b) ?? 0
    if (vb !== va) return vb > va ? b : a
    return ancestryOf(b).length > ancestryOf(a).length ? b : a
  })
  const ancestry = ancestryOf(winner)
  return {
    codebase: winner,
    family: ancestry[ancestry.length - 1],
    ancestry: [...union],
    raw,
    candidates,
    conflict: true
  }
}
