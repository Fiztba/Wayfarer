import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const electron = process.argv.includes('--electron')
const executable = electron ? createRequire(import.meta.url)('electron') : process.execPath
const tests = electron
  ? ['electron-smoke.cjs', 'main-lifecycle-smoke.cjs']
  : readdirSync(new URL('../test/', import.meta.url)).filter((f) => f.endsWith('-smoke.mts')).sort()
let failed = 0
for (const test of tests) {
  console.log(`\nRunning ${test}`)
  const result = spawnSync(executable, [...(electron ? [] : ['--experimental-strip-types']), `test/${test}`], {
    cwd: root, stdio: 'inherit', windowsHide: true, timeout: 45000
  })
  if (result.error || result.status !== 0) {
    failed++
    console.error(`${test} failed: ${result.error?.message ?? `exit ${result.status}`}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} suites passed`)
process.exitCode = failed ? 1 : 0
