/**
 * Whether a downloaded update is sitting ready to install.
 *
 * App-wide rather than per-session, so every tab's status bar agrees. Kept
 * outside React (like SessionStore) and read through useSyncExternalStore.
 *
 * The main process both pushes the event and answers a pull, because a window
 * that mounts after the download finished — a reopened pop-out, a slow first
 * paint — would otherwise never learn about it.
 */
type Listener = () => void

class UpdateState {
  private listeners = new Set<Listener>()
  private version: string | null = null
  private started = false

  /** Version waiting to install, or null. */
  readonly get = (): string | null => this.version

  readonly subscribe = (fn: Listener): (() => void) => {
    this.start()
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** Begin listening on first use; idempotent across every subscriber. */
  private start(): void {
    if (this.started) return
    this.started = true
    window.mud.onUpdateReady((version) => this.set(version))
    void window.mud.updateState().then((version) => {
      if (version) this.set(version)
    })
  }

  private set(version: string): void {
    if (this.version === version) return
    this.version = version
    for (const fn of this.listeners) fn()
  }
}

export const updateState = new UpdateState()
