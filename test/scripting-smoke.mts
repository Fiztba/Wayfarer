/**
 * Headless tests for the JS + Lua script runtime.
 * Run with: node --experimental-strip-types test/scripting-smoke.mts
 */
import { ScriptRuntime } from '../src/renderer/src/scripting/ScriptRuntime.ts'

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

const sent: string[] = []
const echoed: string[] = []
const errors: string[] = []
const vars: Record<string, string> = { target: 'goblin' }

const beeps: number[] = []
const rt = new ScriptRuntime({
  send: (t) => sent.push(t),
  sendRaw: (t) => sent.push('RAW:' + t),
  echo: (t) => echoed.push(t),
  echoError: (t) => errors.push(t),
  getVar: (n) => vars[n],
  setVar: (n, v) => (vars[n] = v),
  beep: (times) => beeps.push(times),
  session: () => ({ name: 'Test', host: 'example.org', port: 4000, connected: true })
})

// ---- JavaScript ----
rt.run('js', 'client.send("kill " + client.getVar("target"))')
check('js send + getVar', sent, ['kill goblin'])

sent.length = 0
rt.run('js', 'client.setVar("hp", "42"); client.echo("hp is " + client.getVar("hp"))')
check('js setVar', vars.hp, '42')
check('js echo', echoed, ['hp is 42'])

rt.run('js', 'globals.helper = (x) => client.send("helped " + x)')
sent.length = 0
rt.run('js', 'globals.helper("bob")')
check('js shared globals across runs', sent, ['helped bob'])

rt.run('js', 'this is not valid javascript(')
check('js compile error reported', errors.length > 0, true)

rt.run('js', 'client.beep(3)')
check('js beep', beeps, [3])

// ---- trigger context ----
sent.length = 0
let gagged = false
rt.run('js', 'client.gag(); client.send("reply " + matches[1])', {
  matches: ['Bob tells you hi', 'Bob'],
  line: 'Bob tells you hi',
  gag: () => (gagged = true)
})
check('js trigger ctx matches', sent, ['reply Bob'])
check('js trigger gag()', gagged, true)

// ---- Lua ----
echoed.length = 0
sent.length = 0
rt.run('lua', 'send("kill " .. getVar("target"))')
rt.run('lua', 'setVar("mana", "99")')
rt.run('lua', 'echo("mana=" .. getVar("mana"))')
rt.run('lua', 'x = 10')
rt.run('lua', 'send("x is " .. x)') // globals persist across runs
rt.run('lua', 'send("m=" .. matches[1] .. "/" .. matches[2])', {
  matches: ['whole', 'cap1'],
  line: 'whole'
})
rt.run('lua', 'beep(2)')
rt.run('lua', 'this is invalid lua (((')

await new Promise((r) => setTimeout(r, 4000))

check('lua send + getVar', sent[0], 'kill goblin')
check('lua setVar', vars.mana, '99')
check('lua echo', echoed, ['mana=99'])
check('lua globals persist', sent[1], 'x is 10')
check('lua trigger matches (Mudlet-style)', sent[2], 'm=whole/cap1')
check('lua error reported', errors.some((e) => e.startsWith('Lua error')), true)
check('lua beep', beeps, [3, 2])

rt.dispose()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
