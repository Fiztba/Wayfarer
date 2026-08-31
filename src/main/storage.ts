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

/** A readable, filesystem-safe fragment of a name. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/**
 * The file holding `key` in `dir`, named so a human can read the directory.
 *
 * Files become "<slug-of-name>-<key>.json". The key stays in the filename in
 * full and stays authoritative -- it is what ties a profile to its map and its
 * settings, so renaming a profile must never orphan either. The name is only a
 * prefix for the eye.
 *
 * Nothing is migrated up front. A file already present wins whatever it is
 * called, including the old bare-key name, so an interrupted or partial
 * migration is simply the normal state and resolves the same way. When a label
 * is supplied and the file is not yet named for it, it is renamed in passing;
 * a failure there is not fatal, the old name keeps working.
 */
export function resolveKeyedFile(dir: string, key: string, label?: string): string {
  const safe = safeFileKey(key)
  const suffix = `-${safe}.json`
  let existing: string | null = null
  const legacy = path.join(dir, `${safe}.json`)
  if (fs.existsSync(legacy)) existing = legacy
  else {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(suffix)) {
          existing = path.join(dir, name)
          break
        }
      }
    } catch {
      /* directory not created yet */
    }
  }
  const slug = label ? slugify(label) : ''
  if (!slug) return existing ?? legacy
  const preferred = path.join(dir, `${slug}${suffix}`)
  if (existing && existing !== preferred) {
    try {
      fs.renameSync(existing, preferred)
    } catch {
      return existing
    }
  }
  return preferred
}
