/**
 * Headless checks for character scope: the predicate, and an engine whose
 * host reports who is logged in.
 *
 * Run with: node --experimental-strip-types test/scope-smoke.mts
 */
import { AutomationEngine } from '../src/renderer/src/automation/AutomationEngine.ts'
import { characterList, forCharacter } from '../src/renderer/src/automation/scope.ts'
import { defaultSettings } from '../src/shared/types.ts'

let passed = 0
let failed = 0
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`)
}

// ---- the predicate ----
check('blank restriction: any character', forCharacter('', 'Mystra'), true)
check('absent restriction: any character', forCharacter(undefined, null), true)
check('blank restriction, nobody logged in yet', forCharacter('  ', null), true)
check('named restriction, nobody logged in yet: inactive', forCharacter('Mystra', null), false)
check('exact name', forCharacter('Mystra', 'Mystra'), true)
check('any capitalisation (GMCP vs the guesser)', forCharacter('mystra', 'MYSTRA'), true)
check('other character: inactive', forCharacter('Mystra', 'Fizban'), false)
check('a list, with spaces', forCharacter('Mystra, Fizban', 'fizban'), true)
check('a list with semicolons too', forCharacter('Mystra;Fizban', 'Mystra'), true)
check('the list, parsed', characterList(' Mystra , fizban,, '), ['mystra', 'fizban'])

// ---- an engine that knows who is logged in ----
const settings = defaultSettings()
settings.aliases.push(
  { id: '1', name: 'k', commands: 'kill %1', character: 'Mystra', enabled: true },
  { id: '2', name: 'k', commands: 'backstab %1', character: 'Fizban', enabled: true },
  { id: '3', name: 'gh', commands: 'get all corpse', enabled: true }
)
settings.triggers.push({
  id: 't1',
  label: 'mystra only',
  pattern: 'You are hungry',
  matchType: 'substring',
  caseInsensitive: true,
  commands: 'eat bread',
  gag: false,
  highlight: '',
  character: 'Mystra',
  enabled: true
})
settings.macros.push({ id: 'm1', key: 'F5', commands: 'cast shield', character: 'Fizban', enabled: true })

let who: string | null = null
const sent: string[] = []
const engine = new AutomationEngine(
  {
    transmit: (c) => sent.push(c),
    echoTrigger: () => {},
    echoError: (m) => console.log('  engine error:', m),
    runScript: () => {},
    persistVariable: () => {},
    onVariablesChanged: () => {},
    characterName: () => who
  },
  () => [settings]
)

sent.length = 0
engine.processInput('k rat')
check('nobody logged in: a scoped alias does not expand', sent, ['k rat'])
engine.processInput('gh')
check('nobody logged in: an unscoped alias still does', sent.at(-1), 'get all corpse')

who = 'Mystra'
sent.length = 0
engine.processInput('k rat')
check("as Mystra: her 'k'", sent, ['kill rat'])
sent.length = 0
engine.processLine('You are hungry.')
check('as Mystra: her trigger fires', sent, ['eat bread'])
check("as Mystra: Fizban's macro does not", engine.runMacro('F5'), false)

who = 'fizban'
sent.length = 0
engine.processInput('k rat')
check("as Fizban (lower-case from GMCP): his own 'k', same word, same scope", sent, ['backstab rat'])
sent.length = 0
engine.processLine('You are hungry.')
check("as Fizban: Mystra's trigger stays quiet", sent, [])
check('as Fizban: his macro fires', engine.runMacro('F5'), true)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
