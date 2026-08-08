/**
 * Headless test of the DoD autoroller triggers against the real roll text.
 * Run with: node --experimental-strip-types test/autoroll-smoke.mts
 */
import { AutomationEngine } from '../src/renderer/src/automation/AutomationEngine.ts'
import { ScriptRuntime } from '../src/renderer/src/scripting/ScriptRuntime.ts'
import { defaultSettings, type SettingsSet } from '../src/shared/types.ts'
import { makeAutorollTriggers } from '../scripts/autoroll.mjs'

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

const settings: SettingsSet = {
  ...defaultSettings(),
  triggers: makeAutorollTriggers() as SettingsSet['triggers']
}

const sent: string[] = []
const echoed: string[] = []
// eslint-disable-next-line prefer-const
let engine: AutomationEngine
const beeps: number[] = []
const runtime = new ScriptRuntime({
  send: (t) => engine.processInput(t),
  sendRaw: (t) => sent.push('RAW:' + t),
  echo: (t) => echoed.push(t),
  echoError: (t) => echoed.push('ERR:' + t),
  getVar: (n) => engine.variables[n],
  setVar: (n, v) => engine.setVar(n, v),
  beep: (times) => beeps.push(times),
  session: () => ({ name: 'DoD', host: 'tdod.org', port: 4000, connected: true })
})
engine = new AutomationEngine(
  {
    transmit: (c) => sent.push(c),
    echoTrigger: () => {},
    echoError: (m) => echoed.push('ERR:' + m),
    runScript: (lang, code, ctx) => runtime.run(lang, code, ctx),
    persistVariable: () => {},
    onVariablesChanged: () => {}
  },
  () => [settings]
)

const feedRoll = (
  s: [number, number, number, number, number, number, number]
) => {
  const names = ['Strength', 'Intelligence', 'Wisdom', 'Dexterity', 'Constitution', 'Charisma', 'Luck']
  engine.processLine('-=Ability Scores=-')
  names.forEach((n, i) => engine.processLine(`  ${n.padEnd(12)} : ${s[i]}`))
  engine.processLine('-=Starting Money=-')
  engine.processLine('  Copper   : 6')
  engine.processLine('Hit <Enter> to reroll or <Y> to keep.')
}

const settle = () => new Promise((r) => setTimeout(r, 450))

// 1. Autoroll off by default: nothing happens.
feedRoll([11, 10, 8, 12, 13, 11, 10])
await settle()
check('off by default: nothing sent', sent, [])

// 2. On, but no thresholds: instructs instead of acting.
engine.setVar('autoroll', '1')
feedRoll([11, 10, 8, 12, 13, 11, 10])
await settle()
check('no thresholds: nothing sent', sent, [])
check('no thresholds: instructions echoed', echoed.some((t) => t.includes('no thresholds')), true)

// 3. Thresholds set, bad roll: rerolls (blank line, delayed).
engine.setVar('rollmin_strength', '15')
engine.setVar('rollmin_total', '78')
feedRoll([11, 10, 8, 12, 13, 11, 10]) // str 11, total 75 — both fail
await settle()
check('bad roll: reroll sent', sent, [''])
check('stats captured', engine.variables.roll_strength, '11')
check('best tracked', engine.variables.roll_best_total, '75')
check('reroll echo shows best', echoed.some((t) => t.includes('best total 75')), true)

// 3b. A better-but-still-bad roll raises the record; a worse one doesn't.
feedRoll([12, 10, 8, 12, 13, 11, 11]) // total 77
await settle()
check('best raised to 77', engine.variables.roll_best_total, '77')
feedRoll([9, 9, 8, 10, 10, 9, 9]) // total 64
await settle()
check('worse roll keeps record', engine.variables.roll_best_total, '77')
check('best summary kept', engine.variables.roll_best?.includes('total 77'), true)

// 3b². Distribution instruments: per-stat ranges, count, average, ceiling.
check('range: strength low', engine.variables.roll_lo_strength, '9')
check('range: strength high', engine.variables.roll_hi_strength, '12')
check('rolls counted', engine.variables.roll_n, '3')
check('sum accumulated', engine.variables.roll_sum, String(75 + 77 + 64))
check(
  'reroll echo shows avg',
  echoed.some((t) => t.includes('avg ' + ((75 + 77 + 64) / 3).toFixed(1))),
  true
)

// 3c. Configurable cap: rollmax reached → stops with best report.
engine.setVar('rollmax', '4')
feedRoll([9, 9, 8, 10, 10, 9, 9]) // roll #4 hits the cap
await settle()
check('cap: autoroll disarmed', engine.variables.autoroll, '0')
check('cap: best reported', echoed.some((t) => t.includes('Best seen: total 77')), true)
check('cap: gave-up beep', beeps.includes(2), true)
check('cap: ranges reported', echoed.some((t) => t.includes('Observed ranges')), true)
check('cap: ceiling reported', echoed.some((t) => t.includes('ceiling if every stat maxed')), true)
engine.setVar('rollmax', '1000')
engine.setVar('autoroll', '1')

// 4. Good roll: stops, announces, does NOT auto-keep by default.
sent.length = 0
echoed.length = 0
feedRoll([16, 12, 10, 14, 15, 11, 12]) // str 16, total 90
await settle()
check('keeper: no reroll', sent, [])
check('keeper: announced', echoed.some((t) => t.includes('AUTOROLL KEEPER')), true)
check('keeper: triple beep', beeps.includes(3), true)
check('keeper: autoroll disarmed', engine.variables.autoroll, '0')
check('keeper: best record reset for next character', engine.variables.roll_best_total, '0')

// 5. rollkeep=1: presses Y automatically.
engine.setVar('autoroll', '1')
engine.setVar('rollkeep', '1')
sent.length = 0
feedRoll([16, 12, 10, 14, 15, 11, 12])
await settle()
check('rollkeep: Y sent', sent, ['Y'])

// 6. Money lines never pollute stat vars.
check('copper not captured', engine.variables.roll_copper, undefined)

runtime.dispose()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
