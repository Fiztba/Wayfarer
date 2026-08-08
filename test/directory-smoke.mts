/**
 * Headless test for the TMC biglist parser.
 * Run with: node --experimental-strip-types test/directory-smoke.mts
 */
import { parseBiglist } from '../src/main/MudDirectory.ts'

const res = await fetch('https://www.mudconnect.com/cgi-bin/search.cgi?mode=tmc_biglist', {
  headers: { 'User-Agent': 'Wayfarer-MUD-Client/0.1 (directory browser)' }
})
const html = await res.text()
const entries = parseBiglist(html)

console.log(`parsed ${entries.length} entries`)
console.log('top 5 by rank:')
for (const e of entries.slice(0, 5)) {
  console.log(`  #${e.rank} ${e.name} — ${e.host}:${e.port} ${e.connected ? '(up)' : '(down)'}`)
}
const dod = entries.find((e) => /dawn of demise/i.test(e.name))
console.log('Dawn of Demise in list:', dod ? `${dod.host}:${dod.port}` : 'not found')
process.exit(entries.length > 100 ? 0 : 1)
