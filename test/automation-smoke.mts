/**
 * Headless tests for the automation engine (no MUD required).
 * Run with: node --experimental-strip-types test/automation-smoke.mts
 */
import {
  AutomationEngine,
  parseRepeat,
  parseSpeedwalk,
  substituteArgs,
  substituteVars,
  splitPastedBlock,
  keyEventSignature
} from '../src/renderer/src/automation/AutomationEngine.ts'
import { defaultSettings, type SettingsSet } from '../src/shared/types.ts'

let failures = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) console.log(`  ok  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}\n      expected ${e}\n      got      ${a}`)
  }
}

// ---- speedwalk ----
check('speedwalk .3n2eu', parseSpeedwalk('.3n2eu'), ['n', 'n', 'n', 'e', 'e', 'u'])
check('speedwalk .2ne', parseSpeedwalk('.2ne'), ['ne', 'ne'])
check('speedwalk non-walk', parseSpeedwalk('.chat hello'), null)
check('speedwalk plain command', parseSpeedwalk('north'), null)

// ---- substitutions ----
check('args %1 %2', substituteArgs('give %1 to %2', ['sword', 'bob'], 'sword bob'), 'give sword to bob')
check('args %0', substituteArgs('say %0', ['a', 'b'], 'a b'), 'say a b')
check('args missing', substituteArgs('kill %1 %2', ['rat'], 'rat'), 'kill rat ')
check('vars @target', substituteVars('kill @target', { target: 'dragon' }), 'kill dragon')
check('vars unknown kept', substituteVars('mail @unknownx', {}), 'mail @unknownx')
check('vars @@ escape', substituteVars('say hi@@example', { hi: 'X' }), 'say hi@example')

// ---- pasted blocks ----
check('paste single line', splitPastedBlock('kill rat'), ['kill rat'])
check('paste trailing newline dropped', splitPastedBlock('kill rat\n'), ['kill rat'])
check('paste CRLF normalized', splitPastedBlock('one\r\ntwo\r\n'), ['one', 'two'])
check('paste bare CR normalized', splitPastedBlock('one\rtwo'), ['one', 'two'])
check('paste keeps indentation', splitPastedBlock('if %actor.is_pc%\n  wait 1 s\nend'), [
  'if %actor.is_pc%',
  '  wait 1 s',
  'end'
])
check('paste keeps interior blanks', splitPastedBlock('a\n\nb\n'), ['a', '', 'b'])
check('paste keeps one trailing blank line', splitPastedBlock('a\n\n'), ['a', ''])
check('paste empty', splitPastedBlock(''), [''])
check('paste lone newline', splitPastedBlock('\n'), [''])

// ---- macro signatures ----
check(
  'sig F5',
  keyEventSignature({ key: 'F5', code: 'F5', ctrlKey: false, altKey: false, shiftKey: false }),
  'F5'
)
check(
  'sig Ctrl+G',
  keyEventSignature({ key: 'g', code: 'KeyG', ctrlKey: true, altKey: false, shiftKey: false }),
  'Ctrl+G'
)
check(
  'sig plain letter rejected',
  keyEventSignature({ key: 'g', code: 'KeyG', ctrlKey: false, altKey: false, shiftKey: false }),
  null
)
check(
  'sig Numpad1',
  keyEventSignature({ key: '1', code: 'Numpad1', ctrlKey: false, altKey: false, shiftKey: false }),
  'Numpad1'
)

// ---- engine pipeline ----
const sent: string[] = []
const echoed: string[] = []
const settings: SettingsSet = {
  ...defaultSettings(),
  aliases: [
    { id: '1', name: 'gh', commands: 'get all corpse;bury corpse', enabled: true },
    { id: '2', name: 'k', commands: 'kill %1', enabled: true },
    { id: '3', name: 'kt', commands: 'k @target', enabled: true }
  ],
  triggers: [
    {
      id: 't1',
      label: '',
      pattern: '^(\\w+) tells you',
      matchType: 'regex',
      caseInsensitive: false,
      commands: 'reply %1 I am AFK',
      gag: false,
      highlight: '#ff0000',
      enabled: true
    },
    {
      id: 't2',
      label: '',
      pattern: 'spam line',
      matchType: 'substring',
      caseInsensitive: true,
      commands: '',
      gag: true,
      highlight: '',
      enabled: true
    }
  ],
  variables: { target: 'goblin' }
}
const scriptCalls: Array<{ lang: string; code: string; matches?: string[] }> = []
const errors: string[] = []
const persisted: Array<[string, string]> = []
let varsChanged = 0
const engine = new AutomationEngine(
  {
    transmit: (c) => sent.push(c),
    echoTrigger: (c) => echoed.push(c),
    echoError: (m) => errors.push(m),
    runScript: (lang, code, ctx) => scriptCalls.push({ lang, code, matches: ctx.matches }),
    persistVariable: (n, v) => persisted.push([n, v]),
    onVariablesChanged: () => varsChanged++
  },
  () => [settings]
)

sent.length = 0
engine.processInput('gh')
check('alias expansion + stacking', sent, ['get all corpse', 'bury corpse'])

sent.length = 0
engine.processInput('k dragon')
check('alias args', sent, ['kill dragon'])

sent.length = 0
engine.processInput('kt')
check('alias → alias → variable', sent, ['kill goblin'])

sent.length = 0
engine.processInput('.2n3e')
check('speedwalk via pipeline', sent, ['n', 'n', 'e', 'e', 'e'])

sent.length = 0
const d1 = engine.processLine('Gandalf tells you hello')
check('trigger fires commands', sent, ['reply Gandalf I am AFK'])
check('trigger highlight directive', d1, { gag: false, highlight: '#ff0000' })

const d2 = engine.processLine('some SPAM LINE here')
check('gag trigger (case-insensitive)', d2.gag, true)

const d3 = engine.processLine('nothing special')
check('non-matching line', d3, { gag: false })

// ---- #N repeats and {groups} ----
sent.length = 0
engine.processInput('#3 sneak')
check('#N single command', sent, ['sneak', 'sneak', 'sneak'])

sent.length = 0
engine.processInput('#2 {sneak;hide}')
check('#N braced group', sent, ['sneak', 'hide', 'sneak', 'hide'])

sent.length = 0
engine.processInput('look;#2 {n;e};smile')
check('#N inline with stacking', sent, ['look', 'n', 'e', 'n', 'e', 'smile'])

sent.length = 0
engine.processInput('#2 {#2 {w};d}')
check('#N nested', sent, ['w', 'w', 'd', 'w', 'w', 'd'])

sent.length = 0
engine.processInput('{sneak;hide}')
check('bare brace group', sent, ['sneak', 'hide'])

sent.length = 0
engine.processInput('#2 gh')
check('#N with alias', sent, ['get all corpse', 'bury corpse', 'get all corpse', 'bury corpse'])

sent.length = 0
engine.processInput('#2 k @target')
check('#N with alias args + vars', sent, ['kill goblin', 'kill goblin'])

sent.length = 0
errors.length = 0
engine.processInput('#9999 {n;n;n}')
check('runaway repeat capped at burst limit', sent.length, 20000)
check('runaway repeat reports error', errors.length, 1)

sent.length = 0
engine.processInput('say #1 fan of yours')
check('mid-sentence # untouched', sent, ['say #1 fan of yours'])

// ---- paced repeats (#N@DELAY) ----
check('parse @500ms', parseRepeat('#4@500ms {n;e}'), { count: 4, delayMs: 500, body: 'n;e' })
check('parse @2s', parseRepeat('#4@2s x'), { count: 4, delayMs: 2000, body: 'x' })
check('parse @1.5s', parseRepeat('#4@1.5s x'), { count: 4, delayMs: 1500, body: 'x' })
check('parse @1m', parseRepeat('#2@1m x'), { count: 2, delayMs: 60000, body: 'x' })
check('parse bare @250', parseRepeat('#4@250 x'), { count: 4, delayMs: 250, body: 'x' })
check('parse no delay', parseRepeat('#4 x'), { count: 4, delayMs: 0, body: 'x' })

sent.length = 0
engine.processInput('#3@40ms {sneak;hide}')
check('paced: first tick immediate', sent, ['sneak', 'hide'])
await new Promise((r) => setTimeout(r, 200))
check('paced: all ticks arrived', sent, ['sneak', 'hide', 'sneak', 'hide', 'sneak', 'hide'])

sent.length = 0
echoed.length = 0
engine.processInput('#100@40ms {w}')
await new Promise((r) => setTimeout(r, 110))
engine.processInput('#stop')
const sentAtStop = sent.length
await new Promise((r) => setTimeout(r, 150))
check('paced: #stop halts mid-run', sent.length, sentAtStop)
check('paced: #stop well short of full count', sent.length < 10, true)
check('paced: #stop acknowledged', echoed.some((e) => e.includes('stopped 1 paced repeat')), true)

// ---- variables: #var, runtime overlay, capture windows ----
sent.length = 0
engine.processInput('#var hp 224')
check('#var sets runtime variable', engine.variables.hp, '224')
check('#var persists', persisted.some(([n, v]) => n === 'hp' && v === '224'), true)
check('#var transmits nothing', sent, [])
check('#var notifies', varsChanged > 0, true)

engine.processInput('#var target2 @target')
check('#var substitutes @vars', engine.variables.target2, 'goblin')

engine.setVar('target', 'dragon', false)
check('runtime overlay beats settings', engine.variables.target, 'dragon')
sent.length = 0
engine.processInput('kt')
check('aliases see runtime value', sent, ['kill dragon'])
const persistedBefore = persisted.length
engine.setVar('livehp', '50', false)
check('persist=false skips disk', persisted.length, persistedBefore)

settings.triggers.push({
  id: 't3',
  label: '',
  pattern: 'tells the group',
  matchType: 'substring',
  caseInsensitive: true,
  commands: '',
  gag: false,
  highlight: '',
  captureWindow: 'Group',
  enabled: true
})
const dCap = engine.processLine('Bob tells the group hello')
check('capture directive set', dCap.captures, ['Group'])
const dNone = engine.processLine('Bob waves happily')
check('no capture on non-match', dNone.captures, undefined)

// ---- script-typed actions ----
settings.aliases.push({
  id: '4',
  name: 'jstest',
  commands: 'client.send("ok")',
  language: 'js',
  enabled: true
})
engine.processInput('jstest arg1 arg2')
check('js alias dispatched', scriptCalls.length, 1)
check('js alias matches', scriptCalls[0]?.matches, ['arg1 arg2', 'arg1', 'arg2'])

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
