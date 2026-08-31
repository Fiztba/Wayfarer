/**
 * Headless tests for on-disk file naming.
 * Run with: node --experimental-strip-types test/storage-smoke.mts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveKeyedFile, safeFileKey, slugify } from '../src/main/storage.ts'

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wayfarer-storage-'))
const fresh = (): string => {
  const dir = fs.mkdtempSync(path.join(root, 'case-'))
  return dir
}
const name = (full: string): string => path.basename(full)

// ---- slugs ----
check('slug: spaces become dashes', slugify('Dawn of Demise'), 'dawn-of-demise')
check('slug: punctuation collapses', slugify("Fizban's  Test -- MUD!"), 'fizban-s-test-mud')
check('slug: nothing usable gives nothing', slugify('!!! ???'), '')
check('slug: long names are cut', slugify('x'.repeat(80)).length, 48)

const KEY = 'aa72cea2-6c19-4067-915b-b645623bc297'

// ---- a new file gets a readable name ----
{
  const dir = fresh()
  const f = resolveKeyedFile(dir, KEY, 'Dawn of Demise')
  check('new: named for the profile', name(f), `dawn-of-demise-${KEY}.json`)
  check('new: the key is kept in full', name(f).endsWith(`-${KEY}.json`), true)
}

// ---- an existing bare-key file is adopted and renamed ----
{
  const dir = fresh()
  const legacy = path.join(dir, `${KEY}.json`)
  fs.writeFileSync(legacy, '{"rooms":1}')
  const f = resolveKeyedFile(dir, KEY, 'Dawn of Demise')
  check('migrate: renamed, not copied', fs.readdirSync(dir).length, 1)
  check('migrate: new name', name(f), `dawn-of-demise-${KEY}.json`)
  check('migrate: contents survive', fs.readFileSync(f, 'utf8'), '{"rooms":1}')
  check('migrate: old name gone', fs.existsSync(legacy), false)
}

// ---- renaming the profile renames the file ----
{
  const dir = fresh()
  fs.writeFileSync(resolveKeyedFile(dir, KEY, 'Old Name'), 'x')
  const f = resolveKeyedFile(dir, KEY, 'New Name')
  check('rename: follows the profile', name(f), `new-name-${KEY}.json`)
  check('rename: only one file left', fs.readdirSync(dir).length, 1)
  check('rename: contents survive', fs.readFileSync(f, 'utf8'), 'x')
}

// ---- without a label, whatever exists is used unchanged ----
{
  const dir = fresh()
  const made = resolveKeyedFile(dir, KEY, 'Dawn of Demise')
  fs.writeFileSync(made, 'y')
  const found = resolveKeyedFile(dir, KEY)
  check('unlabelled: finds the readable file', name(found), name(made))
  check('unlabelled: does not rename it', fs.readdirSync(dir).length, 1)
}
{
  // ...and with nothing on disk at all it falls back to the bare key, so a
  // caller without a name still reads and writes somewhere consistent.
  const dir = fresh()
  check('unlabelled: bare key when nothing exists',
    name(resolveKeyedFile(dir, KEY)), `${KEY}.json`)
}

// ---- keys that share a prefix stay separate ----
{
  const dir = fresh()
  const a = resolveKeyedFile(dir, 'adhoc_tdod.org_4000', 'Dawn of Demise')
  fs.writeFileSync(a, 'a')
  const b = resolveKeyedFile(dir, 'adhoc_tdod.org_4001', 'Dawn of Demise')
  fs.writeFileSync(b, 'b')
  check('distinct: two keys, two files', fs.readdirSync(dir).length, 2)
  check('distinct: first is intact', fs.readFileSync(a, 'utf8'), 'a')
  check('distinct: dots are sanitised', name(a).includes('.org'), false)
  check('distinct: key still recoverable',
    name(a), `dawn-of-demise-${safeFileKey('adhoc_tdod.org_4000')}.json`)
}

// ---- a name with nothing sluggable falls back rather than breaking ----
{
  const dir = fresh()
  check('unsluggable: falls back to the bare key',
    name(resolveKeyedFile(dir, KEY, '???')), `${KEY}.json`)
}

fs.rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
