/**
 * Shared corruption-proof file helpers: atomic writes (temp + fsync + rename)
 * and capped timestamped backups. Used by every store that persists user data.
 */
import fs from 'node:fs'
import path from 'node:path'

export function atomicWrite(target: string, content: string): void {
  const tmp = target + '.tmp-' + process.pid
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, content, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, target)
}

export function backupFile(backupRoot: string, key: string, sourceFile: string, keep: number): void {
  const dir = path.join(backupRoot, key)
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(sourceFile, path.join(dir, `${stamp}.json`))
  const backups = fs.readdirSync(dir).sort()
  while (backups.length > keep) {
    const oldest = backups.shift()
    if (oldest) fs.rmSync(path.join(dir, oldest))
  }
}

export function safeFileKey(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]/g, '_')
}
