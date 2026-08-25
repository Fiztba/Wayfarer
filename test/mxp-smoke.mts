/**
 * Headless tests for MXP parsing and MSP line parsing.
 * Run with: node --experimental-strip-types test/mxp-smoke.mts
 */
import { AnsiParser, setClientVersion, type Span } from '../src/renderer/src/ansi.ts'
import { parseMspLine } from '../src/renderer/src/sound.ts'

// The renderer injects the real build version at startup; pin a known one so
// the <VERSION> reply is assertable without hardcoding today's release.
setClientVersion('9.9.9')

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

function mxpParser(): { p: AnsiParser; replies: string[] } {
  const p = new AnsiParser()
  p.mxpEnabled = true
  const replies: string[] = []
  p.onMxpReply = (t) => replies.push(t)
  return { p, replies }
}

function spansOf(p: AnsiParser, input: string): Span[] {
  return p.parse(input).filter((t) => t.kind === 'span').map((t) => (t as { span: Span }).span)
}

// ---- send tags in secure mode ----
{
  const { p } = mxpParser()
  const spans = spansOf(p, '\x1b[1z<send href="kill troll">a troll</send> stands here\r\n')
  check('send: link text', spans[0]?.text, 'a troll')
  check('send: link command', spans[0]?.link?.command, 'kill troll')
  check('send: following text unlinked', spans[1]?.link, undefined)
}

// ---- text-content fallback command ----
{
  const { p } = mxpParser()
  const spans = spansOf(p, '\x1b[1zExits: <send>north</send>\r\n')
  check('send: text fallback command', spans[1]?.link?.command, 'north')
}

// ---- tags ignored outside secure mode ----
{
  const { p } = mxpParser()
  const spans = spansOf(p, 'Bob says: <send>gotcha</send>\r\n')
  check('open mode: tag shown literally', spans.map((s) => s.text).join(''), 'Bob says: <send>gotcha</send>')
  check('open mode: no link created', spans.every((s) => !s.link), true)
}

// ---- mxp disabled: nothing parsed at all ----
{
  const p = new AnsiParser()
  const spans = p.parse('\x1b[1z<b>hi</b> &amp;\r\n').filter((t) => t.kind === 'span')
  check(
    'disabled: tags and entities untouched',
    spans.map((t) => (t as { span: Span }).span.text).join(''),
    '<b>hi</b> &amp;'
  )
}

// ---- styling tags ----
{
  const { p } = mxpParser()
  const spans = spansOf(p, '\x1b[1z<b>bold</b><i>ital</i><color red>warn</color>plain\r\n')
  check('b tag', spans[0]?.style.bold, true)
  check('i tag', spans[1]?.style.italic, true)
  check('i tag not bold', spans[1]?.style.bold, undefined)
  check('color tag', spans[2]?.style.color, 'red')
  check('color restored', spans[3]?.style.color, undefined)
}

// ---- entities ----
{
  const { p } = mxpParser()
  const spans = spansOf(p, '\x1b[1zrocks &amp; stones &lt;3\r\n')
  check('entities decoded', spans.map((s) => s.text).join(''), 'rocks & stones <3')
}

// ---- mode 4: secure for a single tag ----
{
  const { p } = mxpParser()
  const spans = spansOf(p, '\x1b[4z<b>x <send>n</send>\r\n')
  check('mode4: first tag honored', spans[0]?.style.bold, true)
  check('mode4: second tag literal', spans.map((s) => s.text).join(''), 'x <send>n</send>')
}

// ---- tag split across chunks ----
{
  const { p } = mxpParser()
  const s1 = spansOf(p, '\x1b[1z<sen')
  const s2 = spansOf(p, 'd href="look">here</send>\r\n')
  check('split: no partial output', s1.length, 0)
  check('split: link intact', s2[0]?.link?.command, 'look')
}

// ---- version/support replies ----
{
  const { p, replies } = mxpParser()
  p.parse('\x1b[1z<VERSION>\x1b[1z<SUPPORT>')
  check('version reply sent', replies[0]?.includes('<VERSION MXP=1.0 CLIENT=Wayfarer'), true)
  check('version reply carries the injected build version', replies[0]?.includes('VERSION=9.9.9'), true)
  check('support reply sent', replies[1]?.includes('+send'), true)
}

// ---- a tags ----
{
  const { p } = mxpParser()
  const spans = spansOf(p, '\x1b[1z<a href="https://example.org">site</a>\r\n')
  check('a: url', spans[0]?.link?.url, 'https://example.org')
}

// ---- MSP parsing ----
check('msp: basic sound', parseMspLine('!!SOUND(thunder.wav)'), {
  kind: 'sound',
  off: false,
  file: 'thunder.wav',
  volume: 100,
  loops: 1
})
check('msp: params', parseMspLine('!!SOUND(hit.wav V=50 L=3)')?.volume, 50)
check('msp: loops', parseMspLine('!!SOUND(hit.wav V=50 L=3)')?.loops, 3)
check('msp: music', parseMspLine('!!MUSIC(town.mid L=-1)')?.kind, 'music')
check('msp: infinite loop', parseMspLine('!!MUSIC(town.mid L=-1)')?.loops, -1)
check('msp: off', parseMspLine('!!SOUND(Off)')?.off, true)
check('msp: url param', parseMspLine('!!SOUND(a.wav U=http://x.com/s/)')?.url, 'http://x.com/s/')
check('msp: non-msp line', parseMspLine('You hear !!SOUND(fake.wav) somewhere'), null)
check('msp: plain prose', parseMspLine('The thunder rolls.'), null)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
