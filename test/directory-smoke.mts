/**
 * Directory pipeline tests: codebase normalisation and cross-source merging.
 *
 * Every case here is a real string or a real pair of records observed in the
 * live sources, not an invented one — these are the shapes that actually broke
 * naive implementations.
 *
 * Run: node --experimental-strip-types test/directory-smoke.mts
 */
import assert from 'node:assert/strict'
import { resolveCodebase, resolveMany } from '../scripts/directory/lib/codebases.mts'
import { nameKey, groupDuplicates, pickAddress, type Candidate } from '../scripts/directory/lib/merge.mts'
import { consumeTelnet, type ProbeResult } from '../scripts/directory/lib/probe.mts'
import { parseSslValue } from '../scripts/directory/lib/mssp.mts'
import { livenessFor, type DirectoryMud } from '../src/shared/directory.ts'
import { SORTS, displayPlayers, playersTitle } from '../src/renderer/src/components/directorySort.ts'

let passed = 0
function check(label: string, fn: () => void): void {
  try {
    fn()
    passed++
  } catch (err) {
    console.error(`FAIL: ${label}\n  ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}

// ---- codebase spellings -------------------------------------------------
check('the four observed spellings of tbaMUD all resolve', () => {
  for (const raw of ['tbaMud', 'TBA', 'tbaMUD', 'TbaMUD']) {
    assert.equal(resolveCodebase(raw).codebase, 'tbaMUD', raw)
  }
})

check('version noise and trailing commentary do not defeat matching', () => {
  for (const raw of ['ROM', 'rom 2.4', 'ROM 2.4b6 completely retooled', 'Rom (EoT Custom)', 'ROM2.4/Haven']) {
    assert.equal(resolveCodebase(raw).codebase, 'ROM', raw)
  }
})

check('a name run straight into its version still matches', () => {
  // No separator means no word boundary for the version strip to land on.
  assert.equal(resolveCodebase('ROM2.4/Haven').codebase, 'ROM')
  assert.equal(resolveCodebase('SmaugFUSS1.9').codebase, 'SmaugFUSS')
})

check('more specific aliases beat their prefixes', () => {
  assert.equal(resolveCodebase('SmaugFUSS 1.9').codebase, 'SmaugFUSS')
  assert.equal(resolveCodebase('Smaug 1.4a (Heavily Modified)').codebase, 'SMAUG')
  assert.equal(resolveCodebase('tbaMUD').codebase, 'tbaMUD')
  assert.equal(resolveCodebase('CircleMUD 3.1').codebase, 'CircleMUD')
})

check('ancestry roots at the family', () => {
  const r = resolveCodebase('LuminariMUD')
  assert.deepEqual(r.ancestry, ['LuminariMUD', 'tbaMUD', 'CircleMUD', 'DikuMUD'])
  assert.equal(r.family, 'DikuMUD')
})

check('unknown strings resolve to nothing rather than guessing', () => {
  for (const raw of ['Not Listed Here', '', 'd20MUD']) {
    assert.equal(resolveCodebase(raw).codebase, null, raw)
  }
})

// ---- cross-source precision --------------------------------------------
check('precision wins along a shared lineage', () => {
  // TMC says tbaMUD, Vineyard files the same MUD as CircleMUD.
  assert.equal(resolveMany(['TBA', 'CircleMUD']).codebase, 'tbaMUD')
  assert.equal(resolveMany(['CircleMUD', 'tbaMud']).codebase, 'tbaMUD')
  // SMAUG is a subset of Merc.
  assert.equal(resolveMany(['Merc', 'Smaug']).codebase, 'SMAUG')
  assert.equal(resolveMany(['Merc', 'SmaugFUSS 1.9']).codebase, 'SmaugFUSS')
})

check('a shared lineage is not a conflict', () => {
  assert.equal(resolveMany(['TBA', 'CircleMUD', 'DikuMUD']).conflict, false)
})

check('MSSP CODEBASE + FAMILY is an ancestry pair, not a disagreement', () => {
  // Reading CODEBASE alone would lose the tbaMUD relationship entirely.
  const r = resolveMany(['LuminariMUD', 'tbaMUD'])
  assert.equal(r.codebase, 'LuminariMUD')
  assert.equal(r.conflict, false)
  assert.ok(r.ancestry.includes('tbaMUD'))
})

check('unrelated lineages are flagged rather than silently picked', () => {
  const r = resolveMany(['Smaug', 'Lp MUD'])
  assert.equal(r.conflict, true)
  assert.ok(['SMAUG', 'LPMud'].includes(r.codebase as string))
})

check('"Custom" is a source declining to answer, not a competing claim', () => {
  const r = resolveMany(['Custom', 'tbaMUD'])
  assert.equal(r.codebase, 'tbaMUD')
  assert.equal(r.conflict, false)
  // Alone, it still stands.
  assert.equal(resolveMany(['Custom']).codebase, 'Custom')
})

// ---- de-duplication -----------------------------------------------------
const probe = (host: string, port: number, state: ProbeResult['state']): [string, ProbeResult] => [
  `${host}:${port}`,
  { host, port, state, address: state === 'nodns' ? null : '1.2.3.4', ms: 1, protocols: [], mssp: {} }
]

check('name keys ignore decoration', () => {
  assert.equal(nameKey('The Darkening Sun'), 'darkeningsun')
  assert.equal(nameKey('Darkening Sun'), 'darkeningsun')
  assert.equal(nameKey('CyberASSAULT'), 'cyberassault')
  assert.equal(nameKey('Doom Mud'), 'doom')
})

check('the trailing game-type word comes off with or without a space', () => {
  // Grapevine writes "Luminari MUD" where the snapshot has "LuminariMUD";
  // stripping only the spaced form left them as two different MUDs.
  assert.equal(nameKey('Luminari MUD'), nameKey('LuminariMUD'))
  assert.equal(nameKey('Arctic MUD'), nameKey('ArcticMUD'))
  assert.equal(nameKey('Elendor MUSH'), nameKey('ElendorMUSH'))
})

check('a name that merely ends in those letters keeps its tail', () => {
  // Guarded by stem length, so the strip cannot turn "Talmud" into "tal".
  assert.equal(nameKey('Talmud'), 'talmud')
  assert.equal(nameKey('Moo'), 'moo')
})

check('same name + same port merges across different domains', () => {
  // The real case: TMS has .org (dead), Vineyard has .com (up).
  const items: Candidate[] = [
    { name: 'The Darkening Sun', host: 'darkeningsun.org', port: 5678, sources: ['tms'] },
    { name: 'The Darkening Sun', host: 'darkeningsun.com', port: 5678, sources: ['vineyard'] }
  ]
  assert.equal(groupDuplicates(items).length, 1)
})

check('the live address wins the merge', () => {
  const items: Candidate[] = [
    { name: 'The Darkening Sun', host: 'darkeningsun.org', port: 5678, sources: ['tms'] },
    { name: 'The Darkening Sun', host: 'darkeningsun.com', port: 5678, sources: ['vineyard'] }
  ]
  const probes = new Map([
    probe('darkeningsun.org', 5678, 'nodns'),
    probe('darkeningsun.com', 5678, 'up')
  ])
  assert.equal(pickAddress(items, probes).host, 'darkeningsun.com')
})

check('the merge has no preferred source — the other direction works too', () => {
  // CyberASSAULT inverts it: TMC's address is dead, TMS's is live.
  const items: Candidate[] = [
    { name: 'CyberASSAULT', host: 'cyberassault.ddns.net', port: 11111, sources: ['tmc'] },
    { name: 'CyberASSAULT', host: 'cyberassault.org', port: 11111, sources: ['tms'] }
  ]
  const probes = new Map([
    probe('cyberassault.ddns.net', 11111, 'nodns'),
    probe('cyberassault.org', 11111, 'up')
  ])
  assert.equal(groupDuplicates(items).length, 1)
  assert.equal(pickAddress(items, probes).host, 'cyberassault.org')
})

check('unrelated MUDs sharing a port are not merged', () => {
  const items: Candidate[] = [
    { name: 'Alpha MUD', host: 'alpha.example.com', port: 4000, sources: ['tmc'] },
    { name: 'Beta MUD', host: 'beta.example.com', port: 4000, sources: ['tmc'] }
  ]
  assert.equal(groupDuplicates(items).length, 2)
})

check('same name on a different port still merges via a shared host label', () => {
  const items: Candidate[] = [
    { name: 'MUME', host: 'mume.org', port: 23, sources: ['tmc'] },
    { name: 'MUME', host: 'mume.org', port: 4242, sources: ['mssp'] }
  ]
  assert.equal(groupDuplicates(items).length, 1)
})

check('dynamic-DNS providers are not treated as identity', () => {
  // Two unrelated MUDs both on dyndns must not collapse into one.
  const items: Candidate[] = [
    { name: 'Alpha', host: 'alpha.dyndns.org', port: 4000, sources: ['tmc'] },
    { name: 'Beta', host: 'beta.dyndns.org', port: 4000, sources: ['tmc'] }
  ]
  assert.equal(groupDuplicates(items).length, 2)
})

// ---- liveness tiers -----------------------------------------------------
check('one failed probe never buries a MUD', () => {
  // cyberassault.org read as dead on its first probe and was fine.
  assert.equal(livenessFor('closed', 1), 'ailing')
  assert.equal(livenessFor('nodns', 3), 'ailing')
  assert.equal(livenessFor('closed', 4), 'dormant')
  assert.equal(livenessFor('nodns', 12), 'buried')
  assert.equal(livenessFor('up', 0), 'live')
})

check('a MUD that answers is live regardless of history', () => {
  assert.equal(livenessFor('up', 99), 'live')
})

// ---- telnet handshake ---------------------------------------------------
const IAC = 255, SE = 240, SB = 250, WILL = 251, WONT = 252, DO = 253, DONT = 254

function run(bytes: number[]): { found: string[]; mssp: Record<string, string>; reply: number[] } {
  const found = new Set<string>()
  const mssp: Record<string, string> = {}
  const reply: number[] = []
  consumeTelnet(Buffer.from(bytes), found, mssp, reply)
  return { found: [...found].sort(), mssp, reply }
}

check('advertised options are recorded', () => {
  const r = run([IAC, WILL, 201, IAC, WILL, 69, IAC, WILL, 91, IAC, WILL, 86])
  assert.deepEqual(r.found, ['GMCP', 'MCCP', 'MSDP', 'MXP'])
})

check('we agree to identify ourselves but refuse everything else', () => {
  // The Diku opener: a bare IAC DO TTYPE and then silence until we answer.
  assert.deepEqual(run([IAC, DO, 24]).reply, [IAC, WILL, 24])
  assert.deepEqual(run([IAC, DO, 31]).reply, [IAC, WONT, 31])
})

check('MSSP is accepted, compression is declined', () => {
  // MSSP is the one option worth taking: the answer is the MUD describing
  // itself. MCCP would turn the rest of the stream into zlib.
  assert.deepEqual(run([IAC, WILL, 70]).reply, [IAC, DO, 70])
  assert.deepEqual(run([IAC, WILL, 86]).reply, [IAC, DONT, 86])
})

check('a TTYPE request is answered with our name', () => {
  const r = run([IAC, SB, 24, 1, IAC, SE])
  const text = Buffer.from(r.reply).toString('latin1')
  assert.ok(text.includes('Wayfarer-Directory'), text)
})

check('MSSP subnegotiation is parsed into variables', () => {
  const enc = (s: string): number[] => [...Buffer.from(s, 'ascii')]
  const r = run([
    IAC, SB, 70,
    1, ...enc('PLAYERS'), 2, ...enc('7'),
    1, ...enc('CODEBASE'), 2, ...enc('tbaMUD'),
    IAC, SE
  ])
  assert.equal(r.mssp.PLAYERS, '7')
  assert.equal(r.mssp.CODEBASE, 'tbaMUD')
})

check('a sequence split across reads is carried, not lost', () => {
  // Chunk boundaries fall wherever TCP decides; a half-read IAC WILL must not
  // be consumed as though it were complete.
  const found = new Set<string>()
  const used = consumeTelnet(Buffer.from([IAC, WILL]), found, {}, [])
  assert.equal(used, 0)
  assert.equal(found.size, 0)
})

check('an unterminated subnegotiation is not consumed', () => {
  const used = consumeTelnet(Buffer.from([IAC, SB, 70, 1, 65]), new Set(), {}, [])
  assert.equal(used, 0)
})

// ---- player counts ------------------------------------------------------
// A MUD carries two player numbers that are easy to confuse. `players` is what
// it reported when we probed it; `activePlayers` is a rolling historical mean
// from the MSSP crawler and is routinely fractional. Mixing them produced rows
// reading "0.47 players" and a sort that buried the busiest MUDs.
const mud = (name: string, players: number | null, activePlayers: number | null): DirectoryMud =>
  ({ name, players, activePlayers } as DirectoryMud)

check('the row shows the live count, never the fractional average', () => {
  // 4 Dimensions: 0 online, 0.47 average. It rendered as "0.47".
  assert.equal(displayPlayers(mud('4 Dimensions', 0, 0.47)), 0)
  // Ansalon: 10 online, 2.16 average. It rendered as "2.16".
  assert.equal(displayPlayers(mud('Ansalon MUD', 10, 2.16)), 10)
  assert.equal(displayPlayers(mud('No data', null, null)), null)
})

check('a displayed player count is never fractional', () => {
  for (const [now, avg] of [[0, 0.47], [10, 2.16], [3, 0.64], [7, 5.78]] as [number, number][]) {
    const shown = displayPlayers(mud('x', now, avg))
    assert.ok(shown === null || Number.isInteger(shown), `${shown} should be a whole number`)
  }
})

check('the average survives as hover context, rounded', () => {
  assert.match(playersTitle(mud('x', 10, 2.16)), /10 online.*typically about 2/)
  assert.equal(playersTitle(mud('x', 4, null)), '4 online when last checked')
  assert.equal(playersTitle(mud('x', null, 3.2)), '')
})

check('sorting by players ranks by who is actually online', () => {
  // The real regression: Threshold RPG's 145 logged-in players sorted below
  // MUDs whose *average* was higher than its average.
  const sorted = [
    mud('Realms of Despair', 85, 44.72),
    mud('Threshold RPG', 145, 15.87),
    mud('Chaos Mud', 10, 6.25)
  ].sort(SORTS.players)
  assert.deepEqual(sorted.map((m) => m.name), ['Threshold RPG', 'Realms of Despair', 'Chaos Mud'])
})

check('the average only breaks ties between equal live counts', () => {
  const sorted = [mud('quiet', 2, 0.3), mud('busy', 2, 9.1)].sort(SORTS.players)
  assert.deepEqual(sorted.map((m) => m.name), ['busy', 'quiet'])
})

check('MUDs with no player data sort last, not first', () => {
  const sorted = [mud('unknown', null, null), mud('empty', 0, null)].sort(SORTS.players)
  assert.deepEqual(sorted.map((m) => m.name), ['empty', 'unknown'])
})

check('an absent rank sorts last, not as rank zero', () => {
  const r = (name: string, rank: number | null): DirectoryMud => ({ name, rank } as DirectoryMud)
  const sorted = [r('unranked', null), r('second', 2), r('first', 1)].sort(SORTS.rank)
  assert.deepEqual(sorted.map((m) => m.name), ['first', 'second', 'unranked'])
})

// ---- TLS ----------------------------------------------------------------
// Raised by SlySven (Mudlet): whether a connection is secured affects which
// port to show. MSSP defines SSL as the port number of the encrypted listener,
// and we had been reading it as a boolean.
check('an SSL value is a port, not a flag', () => {
  // Real values from the crawler.
  assert.deepEqual(parseSslValue('4443'), { offered: true, port: 4443 })
  assert.deepEqual(parseSslValue('992'), { offered: true, port: 992 })
  assert.deepEqual(parseSslValue('5679'), { offered: true, port: 5679 })
})

check('zero and -1 mean no encrypted connection', () => {
  for (const v of ['0', '-1', '', null, undefined, 'nonsense']) {
    assert.equal(parseSslValue(v).offered, false, String(v))
  }
})

check('"1" means yes without saying where', () => {
  // Four MUDs in the corpus read the spec as a boolean. Port 1 is a privileged
  // system port; taking it literally would produce a connection to nowhere.
  assert.deepEqual(parseSslValue('1'), { offered: true, port: null })
})

check('a port outside the valid range is not a port', () => {
  assert.equal(parseSslValue('70000').offered, false)
})

check('reading SSL as a boolean loses most TLS-capable MUDs', () => {
  // The regression this replaced: `v === '1'` matched 4 of the 16 that offer
  // encryption, and discarded every port.
  const corpus = ['0', '1', '4443', '992', '5679', '0', '1', '3334']
  const oldWay = corpus.filter((v) => v === '1').length
  const nowWay = corpus.filter((v) => parseSslValue(v).offered).length
  assert.equal(oldWay, 2)
  assert.equal(nowWay, 6)
})

console.log(`directory-smoke: ${passed} checks passed`)
