/**
 * MapStore — persistence for maps, one JSON file per map key
 * (profile id, or a host_port slug for quick-connect sessions).
 * Atomic writes; timestamped backups are taken at most once per hour per map
 * (maps save frequently — backing up every write would balloon disk use).
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite, backupFile, resolveKeyedFile, safeFileKey } from './storage'

const BACKUPS_PER_MAP = 10
const BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000

export class MapStore {
  private dir: string
  private backupDir: string
  private lastBackup = new Map<string, number>()

  /** Resolves a map key to the profile's name, so files are readable on disk.
   *  Quick-connect keys have no profile and keep their host_port name. */
  private labelFor: (key: string) => string | undefined

  constructor(baseDir: string, labelFor?: (key: string) => string | undefined) {
    this.labelFor = labelFor ?? (() => undefined)
    this.dir = path.join(baseDir, 'maps')
    this.backupDir = path.join(baseDir, 'backups', 'maps')
    fs.mkdirSync(this.dir, { recursive: true })
    fs.mkdirSync(this.backupDir, { recursive: true })
  }

  load(key: string): unknown | null {
    const target = this.fileFor(key)
    try {
      return JSON.parse(fs.readFileSync(target, 'utf8'))
    } catch {
      return null
    }
  }

  save(key: string, map: unknown): void {
    const target = this.fileFor(key)
    const now = Date.now()
    if (fs.existsSync(target) && now - (this.lastBackup.get(key) ?? 0) > BACKUP_MIN_INTERVAL_MS) {
      backupFile(this.backupDir, safeFileKey(key), target, BACKUPS_PER_MAP)
      this.lastBackup.set(key, now)
    }
    atomicWrite(target, JSON.stringify(map))
  }

  private fileFor(key: string): string {
    return resolveKeyedFile(this.dir, key, this.labelFor(key))
  }
}
