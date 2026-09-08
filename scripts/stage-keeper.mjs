// Ship a standalone runtime: a running Electron executable cannot be replaced
// by the Windows installer, and Electron child processes die with their host.
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
const dest = path.resolve('out/keeper')
if (process.version !== 'v24.18.0') throw new Error('Build with Node 24.18.0 so the shipped connection runtime matches build/node-LICENSE.')
fs.mkdirSync(dest, { recursive: true })
fs.copyFileSync(process.execPath, path.join(dest, process.platform === 'win32' ? 'WayfarerConnection.exe' : 'wayfarer-connection'))
fs.copyFileSync('build/node-LICENSE', path.join(dest, 'node-LICENSE'))
await build({ entryPoints: ['src/main/keeper.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dest, 'keeper.cjs') })
