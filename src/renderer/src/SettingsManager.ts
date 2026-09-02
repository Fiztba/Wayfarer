/**
 * SettingsManager — renderer-side cache of automation settings.
 * Scope 'null' is global (all worlds); a profile id scopes to one world.
 * Engines read through getSets() so saved changes apply immediately.
 */
import { defaultSettings, type SettingsSet } from '../../shared/types'

type Listener = () => void

const GLOBAL_KEY = 'global'

class SettingsManager {
  private global: SettingsSet = defaultSettings()
  private profiles = new Map<string, SettingsSet>()
  /** Scopes with a load in flight or finished — the dedup set. */
  private loading = new Set<string>()
  /** Scopes whose load has actually completed. */
  private ready = new Set<string>()
  private listeners = new Set<Listener>()
  /** Latest save issued per scope, so an older save's result can't win. */
  private saveSeq = new Map<string, number>()

  async ensure(profileId: string | null | undefined): Promise<void> {
    const jobs: Promise<void>[] = []
    if (!this.loading.has(GLOBAL_KEY)) jobs.push(this.load(null))
    if (profileId && !this.loading.has(profileId)) jobs.push(this.load(profileId))
    if (jobs.length > 0) {
      await Promise.all(jobs)
      this.notify()
    }
  }

  private load(profileId: string | null): Promise<void> {
    const key = profileId ?? GLOBAL_KEY
    // Claim the scope before the await so concurrent ensure() calls dedup,
    // but release it on failure — otherwise one bad read leaves the scope
    // stuck on defaults for the rest of the session with no retry.
    this.loading.add(key)
    return window.mud.settings.get(profileId).then(
      (s) => {
        if (profileId === null) this.global = s
        else this.profiles.set(profileId, s)
        this.ready.add(key)
      },
      (err) => {
        this.loading.delete(key)
        throw err
      }
    )
  }

  /**
   * True once the scope's settings have been read from disk. Until then
   * getScope() hands back defaults, and saving a merge on top of those would
   * wipe the file — callers that write derived state (variable persistence)
   * must check this first.
   */
  isLoaded(profileId: string | null | undefined): boolean {
    return this.ready.has(profileId ?? GLOBAL_KEY)
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

  private apply(profileId: string | null, set: SettingsSet): void {
    if (profileId === null) this.global = set
    else this.profiles.set(profileId, set)
    this.notify()
  }

  async save(profileId: string | null, set: SettingsSet): Promise<void> {
    // Optimistic: the settings panel's inputs are controlled by this cache,
    // so waiting for the disk round-trip before updating it made every field
    // snap back to the stale value between keystrokes. Apply now, then let
    // the main process's normalised copy replace it — unless a newer save
    // for the same scope has been issued meanwhile, in which case that one
    // owns the final word.
    const key = profileId ?? GLOBAL_KEY
    const seq = (this.saveSeq.get(key) ?? 0) + 1
    this.saveSeq.set(key, seq)
    this.apply(profileId, set)
    const saved = await window.mud.settings.save(profileId, set)
    if (this.saveSeq.get(key) === seq) this.apply(profileId, saved)
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
