/**
 * Liveness probing.
 *
 * No directory can be trusted for whether a MUD is up. Measured against a
 * random sample: Top Mud Sites' "Fully Operational" was right 23% of the time,
 * and The Mud Connector's "Connected" 76%. Its *negative* was right 15 times
 * out of 15, which is the one flag worth believing without checking.
 *
 * So we connect. A TCP handshake is enough — we are asking "is something
 * listening", not talking the protocol, and opening a telnet session to every
 * MUD on the list would be both slower and ruder.
 *
 * Two details that matter:
 *   - DNS is resolved separately so NXDOMAIN is distinguishable from a closed
 *     port. They mean very different things: a vanished domain is a strong
 *     signal, a refused port could be a reboot, and the two deserve different
 *     retry policies downstream.
 *   - autoSelectFamily is on. A dual-stack probe that only tries one family
 *     produces false negatives; cyberassault.org read as dead over a v4-only
 *     probe and answered fine once v6 was tried.
 */
import net from 'node:net'
import dns from 'node:dns/promises'

export type ProbeState = 'up' | 'closed' | 'nodns'

export interface ProbeResult {
  host: string
  port: number
  state: ProbeState
  address: string | null
  ms: number
}

async function probeOne(host: string, port: number, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now()
  let address: string | null = null
  try {
    const addrs = await dns.lookup(host, { all: true, verbatim: true })
    address = addrs[0]?.address ?? null
    if (!address) return { host, port, state: 'nodns', address: null, ms: Date.now() - started }
  } catch {
    return { host, port, state: 'nodns', address: null, ms: Date.now() - started }
  }

  return await new Promise<ProbeResult>((resolve) => {
    const sock = new net.Socket()
    let settled = false
    const done = (state: ProbeState): void => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve({ host, port, state, address, ms: Date.now() - started })
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done('up'))
    sock.once('timeout', () => done('closed'))
    sock.once('error', () => done('closed'))
    try {
      sock.connect({ host, port, autoSelectFamily: true })
    } catch {
      done('closed')
    }
  })
}

/** Probe many targets with bounded concurrency. */
export async function probeAll(
  targets: { host: string; port: number }[],
  opts: { concurrency?: number; timeoutMs?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<Map<string, ProbeResult>> {
  const { concurrency = 40, timeoutMs = 6000, onProgress } = opts
  const results = new Map<string, ProbeResult>()
  let index = 0
  let done = 0

  async function worker(): Promise<void> {
    for (;;) {
      const i = index++
      if (i >= targets.length) return
      const t = targets[i]
      const r = await probeOne(t.host, t.port, timeoutMs)
      results.set(`${t.host}:${t.port}`, r)
      done++
      if (onProgress && done % 25 === 0) onProgress(done, targets.length)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))
  onProgress?.(done, targets.length)
  return results
}
