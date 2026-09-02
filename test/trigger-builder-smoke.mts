/**
 * Headless checks for the trigger builder: tokenising a line, composing a
 * pattern from chosen captures, and previewing what it would fire on.
 *
 * Run with: node --experimental-strip-types test/trigger-builder-smoke.mts
 */
import {
  buildPattern,
  captureNumber,
  previewMatches,
  tokenizeLine
} from '../src/renderer/src/automation/triggerBuilder.ts'

let failures = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) console.log(`  ok  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}\n      expected ${e}\n      actual   ${a}`)
  }
}

// ---- tokenising ----
{
  const toks = tokenizeLine('Bob tells you, "Hello there!" (3 gold)')
  check('tokens: words, space, punctuation, numbers', toks.map((t) => t.text), [
    'Bob', ' ', 'tells', ' ', 'you', ',', ' ', '"', 'Hello', ' ', 'there', '!"', ' ', '(', '3', ' ', 'gold', ')'
  ])
  check('tokens: kinds', toks.map((t) => t.kind), [
    'word', 'other', 'word', 'other', 'word', 'other', 'other', 'other', 'word', 'other', 'word',
    'other', 'other', 'other', 'number', 'other', 'word', 'other'
  ])
  check('tokens: numbers and later capitals are suggested', toks.filter((t) => t.suggested).map((t) => t.text), ['Hello', '3'])
  check('tokens: the opening word is not suggested for its capital alone', toks[0].suggested, false)
  check('tokens: decimals stay one number', tokenizeLine('12.5 lbs').map((t) => t.text), ['12.5', ' ', 'lbs'])
  check("tokens: apostrophes stay in a word", tokenizeLine("Bob's").map((t) => t.text), ["Bob's"])
}

// ---- composing ----
{
  const line = 'Bob tells you, "meet me at 5"'
  const toks = tokenizeLine(line)
  const none = buildPattern(toks, new Set(), { anchorStart: true, anchorEnd: true })
  check('pattern: nothing captured is the literal line, escaped and anchored',
    none, '^Bob\\s+tells\\s+you,\\s+"meet\\s+me\\s+at\\s+5"$')
  check('pattern: the literal pattern matches its own line', new RegExp(none).test(line), true)
  const both = buildPattern(toks, new Set([0, toks.length - 2]), { anchorStart: true, anchorEnd: false })
  check('pattern: word and number captures', both, "^([\\w']+)\\s+tells\\s+you,\\s+\"meet\\s+me\\s+at\\s+(\\d+)\"")
  const m = new RegExp(both).exec('Alice tells you, "meet me at 12" ok')
  check('pattern: captures come back in order', m ? [m[1], m[2]] : null, ['Alice', '12'])
  check('pattern: regex metacharacters are escaped',
    new RegExp(buildPattern(tokenizeLine('[ Exits: n s ]'), new Set(), { anchorStart: false, anchorEnd: false }))
      .test('[ Exits: n s ]'), true)
  check('pattern: wrapped whitespace still matches',
    new RegExp(buildPattern(tokenizeLine('a  b'), new Set(), { anchorStart: true, anchorEnd: true })).test('a b'), true)
  check('capture numbering follows token order', [captureNumber(new Set([4, 0]), 4), captureNumber(new Set([4, 0]), 0), captureNumber(new Set([4]), 1)], [2, 1, null])
}

// ---- previewing ----
{
  const lines = ['Bob tells you hi', 'You are hungry.', 'alice tells you bye', 'Nothing here']
  const sub = previewMatches({ pattern: 'TELLS YOU', matchType: 'substring', caseInsensitive: true }, lines)
  check('preview: substring, case folded', [sub.count, sub.total, sub.sample], [2, 4, 'alice tells you bye'])
  const strict = previewMatches({ pattern: 'TELLS YOU', matchType: 'substring', caseInsensitive: false }, lines)
  check('preview: substring, case kept', strict.count, 0)
  const re = previewMatches({ pattern: '^(\\w+) tells you', matchType: 'regex', caseInsensitive: false }, lines)
  check('preview: regex', [re.count, re.sample], [2, 'alice tells you bye'])
  const bad = previewMatches({ pattern: '(', matchType: 'regex', caseInsensitive: false }, lines)
  check('preview: a broken regex reports instead of throwing', [bad.count, typeof bad.error], [0, 'string'])
  const empty = previewMatches({ pattern: '', matchType: 'regex', caseInsensitive: false }, lines)
  check('preview: empty pattern fires on nothing', empty.count, 0)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
