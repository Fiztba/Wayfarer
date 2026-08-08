/**
 * Walker — executes a path.
 *
 * Confirmed mode (default): send one step, wait for the tracker to confirm
 * arrival in the expected room (or time out / go lost), open doors en route,
 * halt visibly on any surprise. Fast mode blasts every step immediately.
 */
import type { MapTracker } from './MapTracker.ts'
import type { WalkStep } from './Pathfinder.ts'

const STEP_TIMEOUT_MS = 6000

export interface WalkerHost {
  transmit(command: string): void
  info(text: string): void
  error(text: string): void
}

export class Walker {
  private tracker: MapTracker
  private host: WalkerHost

  private steps: WalkStep[] = []
  private index = 0
  private active = false
  private unsub: (() => void) | null = null
  private timeout: ReturnType<typeof setTimeout> | null = null
  private destinationLabel = ''

  constructor(tracker: MapTracker, host: WalkerHost) {
    this.tracker = tracker
    this.host = host
  }

  get walking(): boolean {
    return this.active
  }

  start(steps: WalkStep[], destinationLabel: string, fast: boolean): void {
    this.cancel(false)
    if (steps.length === 0) {
      this.host.info('You are already there.')
      return
    }
    this.destinationLabel = destinationLabel
    if (fast) {
      for (const step of steps) {
        if (step.openCommand) this.host.transmit(step.openCommand)
        this.host.transmit(step.command)
      }
      this.host.info(`Sent ${steps.length} steps to ${destinationLabel} (fast walk).`)
      return
    }
    this.steps = steps
    this.index = 0
    this.active = true
    this.host.info(`Walking to ${destinationLabel} (${steps.length} steps) — #stop to cancel.`)
    this.unsub = this.tracker.subscribe(() => this.onTrackerChange())
    this.sendStep()
  }

  cancel(announce = true): void {
    if (this.active && announce) {
      this.host.info(`Walk to ${this.destinationLabel} cancelled.`)
    }
    this.active = false
    this.steps = []
    this.index = 0
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = null
    }
  }

  private sendStep(): void {
    const step = this.steps[this.index]
    if (step.openCommand) this.host.transmit(step.openCommand)
    this.host.transmit(step.command)
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = setTimeout(() => {
      if (this.active) {
        this.host.error(
          `Walk halted: no confirmation after "${step.command}" (step ${this.index + 1}/${this.steps.length}).`
        )
        this.cancel(false)
      }
    }, STEP_TIMEOUT_MS)
  }

  private onTrackerChange(): void {
    if (!this.active) return
    if (this.tracker.lost) {
      this.host.error('Walk halted: mapper lost its position.')
      this.cancel(false)
      return
    }
    const step = this.steps[this.index]
    if (this.tracker.currentRoomId === step.toRoomId) {
      this.index++
      if (this.timeout) {
        clearTimeout(this.timeout)
        this.timeout = null
      }
      if (this.index >= this.steps.length) {
        this.host.info(`Arrived at ${this.destinationLabel}.`)
        this.cancel(false)
      } else {
        this.sendStep()
      }
    }
  }
}
