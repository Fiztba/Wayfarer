/**
 * SettingsManager — renderer-side cache of automation settings.
 * Scope 'null' is global (all worlds); a profile id scopes to one world.
 * Engines read through getSets() so saved changes apply immediately.
 */
import { defaultSettings, type SettingsSet } from '../../shared/types'

type Listener = () => void

class SettingsManager {
  private global: SettingsSet = defaultSettings()
  private profiles = new Map<string, SettingsSet>()
  private loaded = new Set<string>() // 'global' or profile ids
  private listeners = new Set<Listener>()

  async ensure(profileId: string | null | undefined): Promise<void> {
    const jobs: Promise<void>[] = []
    if (!this.loaded.has('global')) {
      this.loaded.add('global')
      jobs.push(
        window.mud.settings.get(null).then((s) => {
          this.global = s
        })
      )
    }
    if (profileId && !this.loaded.has(profileId)) {
      this.loaded.add(profileId)
      jobs.push(
        window.mud.settings.get(profileId).then((s) => {
          this.profiles.set(profileId, s)
        })
      )
    }
    if (jobs.length > 0) {
      await Promise.all(jobs)
      this.notify()
    }
  }

  /** Profile scope first (wins), then global. */
  getSets(profileId: string | null | undefined): SettingsSet[] {
    const sets: SettingsSet[] = []
    if (profileId) {
      const p = this.profiles.get(profileId)
      if (p) sets.push(p)
    }
    sets.push(this.global)
    return sets
  }

  getScope(profileId: string | null): SettingsSet {
    if (profileId === null) return this.global
    return this.profiles.get(profileId) ?? defaultSettings()
  }

  /** App-wide UI options (stored in the global scope). */
  get globalOptions() {
    return this.global.options
  }

  async save(profileId: string | null, set: SettingsSet): Promise<void> {
    const saved = await window.mud.settings.save(profileId, set)
    if (profileId === null) this.global = saved
    else this.profiles.set(profileId, saved)
    this.notify()
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }
}

export const settingsManager = new SettingsManager()
