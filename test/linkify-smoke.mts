/**
 * Headless checks for web addresses found in plain output text.
 *
 * Run with: node --experimental-strip-types test/linkify-smoke.mts
 */
import { findLinks, splitLinks } from '../src/renderer/src/linkify.ts'

let passed = 0
let failed = 0
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`)
}
const texts = (s: string) => findLinks(s).map((l) => s.slice(l.start, l.end))
const hrefs = (s: string) => findLinks(s).map((l) => l.href)

check('a full URL', texts('Docs: https://tbamud.com/docs/index.html today'), ['https://tbamud.com/docs/index.html'])
check('http too', hrefs('see http://example.org'), ['http://example.org'])
check('www without a scheme gets https', hrefs('visit www.example.com now'), ['https://www.example.com'])
check('a bare site name', hrefs('Our forum is at forum.example.org and the wiki at wiki.example.net'), ['https://forum.example.org', 'https://wiki.example.net'])
check('a bare host with a path', texts('read example.com/help/rules please'), ['example.com/help/rules'])
check('a sentence full stop is not part of the link', texts('Go to example.com.'), ['example.com'])
check('a comma either', texts('example.com, then example.org!'), ['example.com', 'example.org'])
check('a closing bracket the link did not open', texts('(see https://example.com/page)'), ['https://example.com/page'])
check('but a bracket it did open stays', texts('https://en.wikipedia.org/wiki/MUD_(disambiguation) is one'), ['https://en.wikipedia.org/wiki/MUD_(disambiguation)'])
check('a MUD address keeps only the site, not the port', texts('connect to tbamud.com:9091 tonight'), ['tbamud.com'])
check('an email address is not a link', texts('mail fizban@tbamud.com about it'), [])
check('e.g. and a filename are not links', texts('e.g. save to notes.txt or config.ini'), [])
check('a TLD-looking word inside a longer one is not cut short', texts('join example.community today'), [])
check('a country second-level domain is taken whole', texts('see example.com.au please'), ['example.com.au'])
check('a quote after the link is not part of it', texts('type "example.com" to go'), ['example.com'])
check('case does not matter', hrefs('HTTPS://EXAMPLE.COM/A'), ['HTTPS://EXAMPLE.COM/A'])
check('nothing in plain prose', findLinks('You are hungry. The rat bites you.'), [])
check('split keeps the text intact', splitLinks('see example.com now').map((p) => p.text).join(''), 'see example.com now')
check('split marks only the link', splitLinks('see example.com now').map((p) => !!p.href), [false, true, false])
check('split of plain text is one run', splitLinks('hello'), [{ text: 'hello' }])

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
