/**
 * ProfileStore — corruption-proof profile persistence.
 *
 * Design goals (born from cMUD's infamous profile corruption):
 *  - One human-readable JSON file per profile.
 *  - Atomic writes: write to a temp file, fsync, then rename over the target.
 *    A crash mid-save can never leave a half-written profile.
 *  - Timestamped backups kept before every overwrite (pruned to a cap).
 *  - Reads that fail validation are quarantined, never silently deleted.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { atomicWrite, backupFile, safeFileKey } from './storage'
import type { Profile } from '../shared/types'

const BACKUPS_PER_PROFILE = 25

export class ProfileStore {
  private dir: string
  private backupDir: string

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, 'profiles')
    this.backupDir = path.join(baseDir, 'backups')
    fs.mkdirSync(this.dir, { recursive: true })
    fs.mkdirSync(this.backupDir, { recursive: true })
  }

  list(): Profile[] {
    const profiles: Profile[] = []
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue
      const full = path.join(this.dir, file)
      try {
        const raw = fs.readFileSync(full, 'utf8')
        const parsed = JSON.parse(raw)
        if (this.isValid(parsed)) profiles.push(parsed)
        else this.quarantine(full)
      } catch {
        this.quarantine(full)
      }
    }
    profiles.sort((a, b) => a.name.localeCompare(b.name))
    return profiles
  }

  save(input: Partial<Profile>): Profile {
    const now = new Date().toISOString()
    // No id given: reuse any existing profile for the same host:port instead
    // of minting a duplicate (duplicates orphan their maps/settings).
    let id = input.id
    if (!id && input.host) {
      const twin = this.list().find(
        (p) =>
          p.host.toLowerCase() === input.host!.trim().toLowerCase() &&
          p.port === (Number(input.port) || 23)
      )
      if (twin) id = twin.id
    }
    id ??= crypto.randomUUID()
    const existing = this.read(id)
    const profile: Profile = {
      id,
      name: input.name?.trim() || 'Unnamed',
      host: input.host?.trim() || '',
      port: Number(input.port) || 23,
      tls: Boolean(input.tls),
      encoding: input.encoding === 'latin1' ? 'latin1' : 'utf8',
      notes: input.notes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    const target = this.fileFor(id)
    if (fs.existsSync(target)) this.backup(id, target)
    atomicWrite(target, JSON.stringify(profile, null, 2))
    return profile
  }

  remove(id: string): void {
    const target = this.fileFor(id)
    if (fs.existsSync(target)) {
      // Deleting still takes a backup — an accidental delete is recoverable.
      this.backup(id, target)
      fs.rmSync(target)
    }
  }

  private read(id: string): Profile | null {
    const target = this.fileFor(id)
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
      return this.isValid(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private fileFor(id: string): string {
    // ids are UUIDs we generate; sanitize anyway.
    return path.join(this.dir, safeFileKey(id) + '.json')
  }

  private backup(id: string, sourceFile: string): void {
    backupFile(this.backupDir, safeFileKey(id), sourceFile, BACKUPS_PER_PROFILE)
  }

  private quarantine(file: string): void {
    try {
      fs.renameSync(file, file + '.corrupt')
    } catch {
      // If even that fails, leave the file in place for manual recovery.
    }
  }

  private isValid(p: unknown): p is Profile {
    if (typeof p !== 'object' || p === null) return false
    const o = p as Record<string, unknown>
    return (
      typeof o.id === 'string' &&
      typeof o.name === 'string' &&
      typeof o.host === 'string' &&
      typeof o.port === 'number'
    )
  }
}
