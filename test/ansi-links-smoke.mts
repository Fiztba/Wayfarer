import assert from 'node:assert/strict'
import { AnsiParser, type Span } from '../src/renderer/src/ansi.ts'
import { splitSpanLinks } from '../src/renderer/src/linkify.ts'

const spansOf = (parser: AnsiParser, text: string) => parser.parse(text).flatMap(t => t.kind === 'span' ? [t.span] : [])
const url = 'https://www.last-outpost.com/'
for (let split = 1; split < url.length; split++) {
  const parser = new AnsiParser()
  const spans = [...spansOf(parser, url.slice(0, split)), ...spansOf(parser, '\x1b[31m' + url.slice(split))]
  const parts = splitSpanLinks(spans).flat()
  assert.equal(parts.map(p => p.text).join(''), url)
  assert.ok(parts.every(p => p.href === url), `split at ${split}`)
}
const parser = new AnsiParser()
const streamed: Span[] = []
for (const char of `see ${url} now`) streamed.push(...spansOf(parser, char))
const parts = splitSpanLinks(streamed).flat()
assert.equal(parts.filter(p => p.href).map(p => p.text).join(''), url)
assert.ok(parts.filter(p => p.href).every(p => p.href === url))
const explicit: Span = { text: 'example.com', style: {}, link: { command: 'say please' } }
assert.deepEqual(splitSpanLinks([explicit]), [[{ text: 'example.com' }]])
assert.deepEqual(explicit.link, { command: 'say please' })
assert.equal(splitSpanLinks([{ text: 'https://one.com ', style: {} }, { text: 'two.org', style: {} }])[1][0].href, 'https://two.org')

for (let split = 1; split < 5; split++) {
  const p = new AnsiParser()
  const sequence = '\x1b[21m'
  assert.deepEqual(p.parse(sequence.slice(0, split)), [])
  assert.equal(spansOf(p, sequence.slice(split) + 'double')[0].style.underline, 'double')
}
const p = new AnsiParser()
const styles = spansOf(p, '\x1b[1;2;21mA\x1b[22mB\x1b[4mC\x1b[21mD\x1b[24mE\x1b[21mF\x1b[0mG').map(s => s.style)
assert.deepEqual(styles, [
  { bold: true, dim: true, underline: 'double' }, { underline: 'double' },
  { underline: true }, { underline: 'double' }, {}, { underline: 'double' }, {}
])
console.log('Streaming URL boundaries, explicit links, and double underline checks passed')

for (const end of ['\x07', '\x1b\\']) {
  for (const [uri, expected] of [
    ['https://example.com/path', { protocol: 'osc8', url: 'https://example.com/path' }],
    ['send:say%20please', { protocol: 'osc8', command: 'say please', prompt: false }],
    ['prompt:buy%20%3Cquantity%3E', { protocol: 'osc8', command: 'buy <quantity>', prompt: true }]
  ] as const) {
    const parser = new AnsiParser()
    const spans: Span[] = []
    for (const char of `\x1b]8;id=test;${uri}${end}Label\x1b[31mColor\x1b]8;;${end}Plain`) {
      spans.push(...spansOf(parser, char))
    }
    assert.equal(spans.map(s => s.text).join(''), 'LabelColorPlain')
    assert.ok(spans.slice(0, 10).every(s => JSON.stringify(s.link) === JSON.stringify(expected)))
    assert.ok(spans.slice(10).every(s => !s.link))
  }
}
for (const uri of ['send:%ZZ', 'send:hello%0Aworld', 'javascript:alert(1)', 'file:///test']) {
  assert.equal(spansOf(new AnsiParser(), `\x1b]8;;${uri}\x07label\x1b]8;;\x07`)[0].link, undefined)
}
const original = new AnsiParser()
original.parse('\x1b]8;;send:say%20please\x07')
const restored = new AnsiParser()
restored.restore(original.snapshot())
assert.equal(spansOf(restored, 'continued')[0].link?.command, 'say please')
console.log('OSC 8 links survive bytewise delivery, color changes, closing, and copyover')
