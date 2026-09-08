import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { once } from 'node:events'
import { LogWriter } from '../src/main/LogWriter.ts'
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wayfarer-logs-test-'))
try {
  const writer = new LogWriter(base)
  const a = writer.start('a', 'Same world')
  const b = writer.start('b', 'Same world')
  assert.notEqual(a, b)
  writer.line('a', 'only session a')
  writer.line('b', 'only session b')
  const finished = [...(writer as any).streams.values()].map((x: any) => once(x.stream, 'finish'))
  writer.stopAll()
  await Promise.all(finished)
  assert.match(fs.readFileSync(a, 'utf8'), /only session a/)
  assert.doesNotMatch(fs.readFileSync(a, 'utf8'), /only session b/)
  assert.match(fs.readFileSync(b, 'utf8'), /only session b/)
  assert.doesNotMatch(fs.readFileSync(b, 'utf8'), /only session a/)
  console.log('logging-smoke: simultaneous sessions have separate complete logs')
} finally {
  assert.equal(path.dirname(base), path.resolve(os.tmpdir()))
  assert.ok(path.basename(base).startsWith('wayfarer-logs-test-'))
  fs.rmSync(base, { recursive: true, force: true })
}
