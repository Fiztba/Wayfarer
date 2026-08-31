/**
 * SettingsStore — persistence for automation settings (triggers, aliases,
 * macros, timers, variables), one JSON file per scope.
 *
 * Scopes: a profile id (world-specific settings) or null (global settings that
 * apply to every session). Same corruption-proofing as profiles: atomic
 * writes plus timestamped backups before every overwrite.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite, backupFile, resolveKeyedFile, safeFileKey } from './storage'
import { defaultSettings, type SettingsSet } from '../shared/types'

const BACKUPS_PER_SCOPE = 25

export class SettingsStore {
  private dir: string
  private backupDir: string

  /** Resolves a profile id to its name, so files are readable on disk. */
  private labelFor: (id: string) => string | undefined

  constructor(baseDir: string, labelFor?: (id: string) => string | undefined) {
    this.labelFor = labelFor ?? (() => undefined)
    this.dir = path.join(baseDir, 'settings')
    this.backupDir = path.join(baseDir, 'backups', 'settings')
    fs.mkdirSync(this.dir, { recursive: true })
    fs.mkdirSync(this.backupDir, { recursive: true })
  }

  get(profileId: string | null): SettingsSet {
    const target = this.fileFor(profileId)
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
      return this.normalize(parsed)
    } catch {
      return defaultSettings()
    }
  }

  save(profileId: string | null, set: SettingsSet): SettingsSet {
    const normalized = this.normalize(set)
    const target = this.fileFor(profileId)
    if (fs.existsSync(target)) {
      backupFile(this.backupDir, this.keyFor(profileId), target, BACKUPS_PER_SCOPE)
    }
    atomicWrite(target, JSON.stringify(normalized, null, 2))
    return normalized
  }

  private keyFor(profileId: string | null): string {
    return profileId ? safeFileKey(profileId) : 'global'
  }

  private fileFor(profileId: string | null): string {
    if (!profileId) return path.join(this.dir, 'global.json')
    return resolveKeyedFile(this.dir, profileId, this.labelFor(profileId))
  }

  /** Fill in any missing fields so old files survive schema additions. */
  private normalize(raw: unknown): SettingsSet {
    const base = defaultSettings()
    if (typeof raw !== 'object' || raw === null) return base
    const o = raw as Partial<SettingsSet>
    return {
      triggers: Array.isArray(o.triggers) ? o.triggers : base.triggers,
      aliases: Array.isArray(o.aliases) ? o.aliases : base.aliases,
      macros: Array.isArray(o.macros) ? o.macros : base.macros,
      timers: Array.isArray(o.timers) ? o.timers : base.timers,
      scripts: Array.isArray(o.scripts) ? o.scripts : base.scripts,
      gauges: Array.isArray(o.gauges) ? o.gauges : base.gauges,
      variables:
        typeof o.variables === 'object' && o.variables !== null ? o.variables : base.variables,
      options: { ...base.options, ...(typeof o.options === 'object' ? o.options : {}) }
    }
  }
}
