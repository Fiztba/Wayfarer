/**
 * Headless tests for the telnet parser. No socket is opened: bytes are fed
 * straight into the private parse() and the emitted events are recorded.
 * Run with: node --experimental-strip-types test/telnet-smoke.mts
 */
import { TelnetSocket, parseMsdpPairs } from '../src/main/telnet/TelnetSocket.ts'

const IAC = 255
const SB = 250
const SE = 240
const GA = 249
const GMCP = 201

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

type Ev = [string, ...unknown[]]
function harness(encoding: 'utf8' | 'latin1' = 'utf8'): { t: TelnetSocket; events: Ev[] } {
  const t = new TelnetSocket({ host: 'localhost', port: 4000, encoding })
  const events: Ev[] = []
  for (const name of ['text', 'prompt', 'gmcp', 'error', 'msdp'] as const) {
    t.on(name, (...args: unknown[]) => events.push([name, ...args]))
  }
  return { t, events }
}
function feed(t: TelnetSocket, ...parts: (number[] | string | Buffer)[]): void {
  const bufs = parts.map((p) =>
    typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.isBuffer(p) ? p : Buffer.from(p)
  )
  ;(t as any).parse(Buffer.concat(bufs))
}

// ---- text ahead of a GMCP block is delivered first ----
{
  const { t, events } = harness()
  feed(t, 'You are here.\r\n', [IAC, SB, GMCP], 'Room.Info {"num":3001}', [IAC, SE], 'tail')
  check('gmcp: text first', events[0], ['text', 'You are here.\r\n'])
  check('gmcp: packet second', events[1], ['gmcp', 'Room.Info', { num: 3001 }])
  check('gmcp: trailing text last', events[2], ['text', 'tail'])
}

// ---- IAC IAC is a literal 255 ----
{
  const { t, events } = harness('latin1')
  feed(t, 'a', [IAC, IAC], 'b')
  const text = events[0]?.[1] as string
  check('iac iac: one text event', events.length, 1)
  check('iac iac: literal byte', [...text].map((c) => c.charCodeAt(0)), [97, 255, 98])
}

// ---- GA marks the preceding partial line as a prompt ----
{
  const { t, events } = harness()
  feed(t, 'Enter name: ', [IAC, GA])
  check('ga: text then prompt', events, [['text', 'Enter name: '], ['prompt']])
}

// ---- runaway subnegotiation is abandoned, parser recovers ----
{
  const { t, events } = harness()
  feed(t, [IAC, SB, GMCP], Buffer.alloc(70_000, 0x41))
  check('overflow: error emitted', events[0]?.[0], 'error')
  check('overflow: back in data state', (t as any).state, 0)
  check('overflow: buffer dropped', (t as any).sbBuf.length, 0)
  events.length = 0
  feed(t, 'still alive')
  check('overflow: text flows again', events.at(-1), ['text', 'still alive'])
}

// ---- MSDP nested table/array ----
{
  const VAR = 1, VAL = 2, TO = 3, TC = 4, AO = 5, AC = 6
  const s = (x: string) => [...Buffer.from(x, 'ascii')]
  const wire = Buffer.from([
    VAR, ...s('ROOM'), VAL, TO,
    VAR, ...s('VNUM'), VAL, ...s('3001'),
    VAR, ...s('EXITS'), VAL, AO, VAL, ...s('n'), VAL, ...s('e'), AC,
    TC
  ])
  check('msdp: nested table', parseMsdpPairs(wire, { i: 0 }, null), {
    ROOM: { VNUM: '3001', EXITS: ['n', 'e'] }
  })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
