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
import type { ProbeResult } from '../scripts/directory/lib/probe.mts'
import { livenessFor } from '../src/shared/directory.ts'

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
  { host, port, state, address: state === 'nodns' ? null : '1.2.3.4', ms: 1 }
]

check('name keys ignore decoration', () => {
  assert.equal(nameKey('The Darkening Sun'), 'darkeningsun')
  assert.equal(nameKey('Darkening Sun'), 'darkeningsun')
  assert.equal(nameKey('CyberASSAULT'), 'cyberassault')
  assert.equal(nameKey('Doom Mud'), 'doom')
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

console.log(`directory-smoke: ${passed} checks passed`)
