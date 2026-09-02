/**
 * MSP (MUD Sound Protocol) — parses !!SOUND(...) / !!MUSIC(...) trigger lines
 * and plays files from the local sounds folder (<userData>/sounds) through the
 * sandboxed msp-sound:// protocol. Nothing is ever fetched from the network.
 */

export interface MspCommand {
  kind: 'sound' | 'music'
  off: boolean
  file: string
  /** 0–100 */
  volume: number
  /** -1 = loop forever */
  loops: number
  url?: string
}

/** Parse an MSP trigger line; null if the line is not one. */
export function parseMspLine(line: string): MspCommand | null {
  const m = /^!!(SOUND|MUSIC)\(\s*([^)]*)\)\s*$/.exec(line.trim())
  if (!m) return null
  const parts = m[2].trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return null
  const file = parts[0]
  const cmd: MspCommand = {
    kind: m[1] === 'SOUND' ? 'sound' : 'music',
    off: /^off$/i.test(file),
    file,
    volume: 100,
    loops: 1
  }
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).toUpperCase()
    const value = part.slice(eq + 1)
    if (key === 'V') cmd.volume = Math.max(0, Math.min(100, Number(value) || 0))
    else if (key === 'L') cmd.loops = Number(value) || 1
    else if (key === 'U') cmd.url = value
  }
  return cmd
}

// ---- attention beep (scripting API) ----------------------------------------

let beepCtx: AudioContext | null = null

/** Synthesized two-tone chime, repeated `times` (1–10). No files involved. */
export function playBeep(times = 1): void {
  if (typeof AudioContext === 'undefined') return
  const count = Math.max(1, Math.min(10, Math.floor(times) || 1))
  beepCtx ??= new AudioContext()
  const ctx = beepCtx
  const start = ctx.currentTime + 0.02
  for (let i = 0; i < count; i++) {
    const t = start + i * 0.45
    const notes: Array<[number, number, number]> = [
      [880, 0, 0.15], // A5
      [1318.5, 0.16, 0.2] // E6
    ]
    for (const [freq, offset, dur] of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, t + offset)
      gain.gain.linearRampToValueAtTime(0.25, t + offset + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, t + offset + dur)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t + offset)
      osc.stop(t + offset + dur + 0.05)
    }
  }
}

const MAX_CONCURRENT_SOUNDS = 8

export class SoundPlayer {
  private music: HTMLAudioElement | null = null
  private active = new Set<HTMLAudioElement>()

  play(cmd: MspCommand): void {
    if (typeof Audio === 'undefined') return
    if (cmd.off) {
      if (cmd.kind === 'music') this.stopMusic()
      else this.stopSounds()
      return
    }
    // Filename only — resolved inside the sounds dir by the main process.
    const src =
      'msp-sound://s/' + cmd.file.split(/[\\/]/).map((p) => encodeURIComponent(p)).join('/')
    const audio = new Audio(src)
    audio.volume = cmd.volume / 100
    if (cmd.loops === -1) audio.loop = true
    let remaining = cmd.loops > 1 ? cmd.loops - 1 : 0
    audio.addEventListener('error', () => this.active.delete(audio))
    audio.addEventListener('ended', () => {
      // A finite loop stays in `active` until its last repeat has played, so
      // !!SOUND(Off) can still silence the remaining plays.
      if (audio.loop) return
      if (remaining > 0) {
        remaining--
        void audio.play().catch(() => this.active.delete(audio))
      } else this.active.delete(audio)
    })
    if (cmd.kind === 'music') {
      this.stopMusic()
      this.music = audio
    } else {
      if (this.active.size >= MAX_CONCURRENT_SOUNDS) return
      this.active.add(audio)
    }
    void audio.play().catch(() => {
      // Missing file or unsupported format — silent by design.
      this.active.delete(audio)
    })
  }

  stopMusic(): void {
    if (this.music) {
      this.music.pause()
      this.music = null
    }
  }

  stopSounds(): void {
    for (const audio of this.active) audio.pause()
    this.active.clear()
  }

  stopAll(): void {
    this.stopMusic()
    this.stopSounds()
  }
}
