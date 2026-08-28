/**
 * Liveness and capability probing.
 *
 * No directory can be trusted for whether a MUD is up. Measured against a
 * random sample: Top Mud Sites' "Fully Operational" was right 23% of the time,
 * and The Mud Connector's "Connected" 76%. Its *negative* was right 15 times
 * out of 15, which is the one flag worth believing without checking.
 *
 * So we connect — and while the socket is open, we complete just enough of the
 * telnet handshake to learn what the MUD supports.
 *
 * A passive listen is not enough, and finding that out is why this file looks
 * the way it does. The Diku family (KaVir's protocol snippet, which tbaMUD and
 * most of its relatives use) opens with "Attempting to Detect Client" and a
 * bare IAC DO TTYPE, then says nothing further until the client identifies
 * itself. The Builder Academy speaks MSDP, MXP and MCCP and announces none of
 * it to a silent listener. So the probe answers the terminal-type question, and
 * the MUD then volunteers the rest.
 *
 * What it will and will not do:
 *   - It identifies itself honestly as Wayfarer's directory crawler in TTYPE,
 *     so an admin reading their logs can see exactly what connected.
 *   - It accepts MSSP, because that option exists to be asked, and answering it
 *     yields the MUD's own description of itself for free.
 *   - It refuses everything else, MCCP included — compression would turn the
 *     rest of the stream into zlib we have no reason to decode.
 *   - It sends no command and no newline, and never reaches a login prompt. The
 *     socket closes a few seconds after connecting.
 *
 * Two further details:
 *   - DNS is resolved separately so NXDOMAIN is distinguishable from a closed
 *     port. A vanished domain is a strong signal; a refused port could be a
 *     reboot, and downstream they get different retry policies.
 *   - autoSelectFamily is on. A v4-only probe read cyberassault.org as dead
 *     when it was fine over v6, and it is one of only two live tbaMUDs.
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
  /** Telnet options the MUD advertised, e.g. GMCP, MSDP, MXP, MCCP. */
  protocols: string[]
  /** MSSP variables, when the MUD offered them. */
  mssp: Record<string, string>
}

const IAC = 255, SE = 240, SB = 250
const WILL = 251, WONT = 252, DO = 253, DONT = 254
const TTYPE = 24, MSSP = 70
const MSSP_VAR = 1, MSSP_VAL = 2

/** How we introduce ourselves. Honest, and greppable in a MUD's logs. */
const TERMINAL_TYPE = 'Wayfarer-Directory'

const TELNET_OPTIONS: Record<number, string> = {
  1: 'ECHO',
  25: 'EOR',
  69: 'MSDP',
  70: 'MSSP',
  85: 'MCCP1',
  86: 'MCCP',
  90: 'MSP',
  91: 'MXP',
  93: 'ZMP',
  200: 'ATCP',
  201: 'GMCP'
}

/**
 * Walk a telnet stream, recording advertised options and MSSP data, and
 * appending the bytes we owe the server to `reply`.
 *
 * Returns how many bytes were consumed, so a sequence split across two chunks
 * can be carried into the next read instead of being lost.
 */
export function consumeTelnet(
  buf: Buffer,
  found: Set<string>,
  mssp: Record<string, string>,
  reply: number[]
): number {
  let i = 0
  while (i < buf.length) {
    if (buf[i] !== IAC) { i++; continue }
    if (i + 1 >= buf.length) return i
    const verb = buf[i + 1]

    if (verb === WILL || verb === WONT || verb === DO || verb === DONT) {
      if (i + 2 >= buf.length) return i
      const opt = buf[i + 2]
      const name = TELNET_OPTIONS[opt]
      if (name && (verb === WILL || verb === DO)) found.add(name)

      if (verb === WILL) {
        // Accept MSSP only: it exists to be asked, and the answer is the MUD's
        // own account of itself. Everything else is declined so the stream
        // stays plain and the server stops waiting on us.
        reply.push(IAC, opt === MSSP ? DO : DONT, opt)
      } else if (verb === DO) {
        // Agree to identify ourselves; refuse everything else.
        reply.push(IAC, opt === TTYPE ? WILL : WONT, opt)
      }
      i += 3
      continue
    }

    if (verb === SB) {
      let end = i + 2
      while (end < buf.length - 1 && !(buf[end] === IAC && buf[end + 1] === SE)) end++
      if (end >= buf.length - 1) return i // incomplete subnegotiation
      const opt = buf[i + 2]
      const payload = buf.subarray(i + 3, end)

      if (opt === TTYPE) {
        // IAC SB TTYPE SEND IAC SE — answer with our name.
        reply.push(IAC, SB, TTYPE, 0, ...Buffer.from(TERMINAL_TYPE, 'ascii'), IAC, SE)
      } else if (opt === MSSP) {
        let key = ''
        let cur = ''
        let mode = 0
        const flush = (): void => {
          if (mode === MSSP_VAL && key) mssp[key] = cur
          else if (mode === MSSP_VAR) key = cur
          cur = ''
        }
        for (const byte of payload) {
          if (byte === MSSP_VAR || byte === MSSP_VAL) {
            flush()
            mode = byte
          } else if (byte >= 32 || byte === 9) {
            cur += String.fromCharCode(byte)
          }
        }
        flush()
      }
      i = end + 2
      continue
    }
    i += 2
  }
  return i
}

async function probeOne(
  host: string,
  port: number,
  timeoutMs: number,
  listenMs: number
): Promise<ProbeResult> {
  const started = Date.now()
  let address: string | null = null
  const dead = (state: ProbeState): ProbeResult => ({
    host, port, state, address, ms: Date.now() - started, protocols: [], mssp: {}
  })

  try {
    const addrs = await dns.lookup(host, { all: true, verbatim: true })
    address = addrs[0]?.address ?? null
    if (!address) return dead('nodns')
  } catch {
    return dead('nodns')
  }

  return await new Promise<ProbeResult>((resolve) => {
    const sock = new net.Socket()
    const found = new Set<string>()
    const mssp: Record<string, string> = {}
    // subarray() returns Buffer<ArrayBufferLike>, so the carry buffer has to
    // be declared that way rather than narrowing to Buffer<ArrayBuffer>.
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let total = 0
    let settled = false
    let connected = false
    let listenTimer: NodeJS.Timeout | null = null

    const finish = (state: ProbeState): void => {
      if (settled) return
      settled = true
      if (listenTimer) clearTimeout(listenTimer)
      sock.destroy()
      resolve({
        host, port, state, address,
        ms: Date.now() - started,
        protocols: [...found].sort(),
        mssp
      })
    }

    sock.setTimeout(timeoutMs)
    // Once the handshake completed the MUD is demonstrably running, even if it
    // then hangs up on us — 'connected', not 'sent bytes', is the liveness test.
    sock.once('timeout', () => finish(connected ? 'up' : 'closed'))
    sock.once('error', () => finish(connected ? 'up' : 'closed'))
    sock.once('close', () => finish(connected ? 'up' : 'closed'))

    sock.once('connect', () => {
      connected = true
      listenTimer = setTimeout(() => finish('up'), listenMs)
    })

    sock.on('data', (d: Buffer) => {
      total += d.length
      pending = pending.length ? Buffer.concat([pending, d]) : d
      const reply: number[] = []
      const used = consumeTelnet(pending, found, mssp, reply)
      pending = pending.subarray(used)
      if (reply.length && !sock.destroyed) {
        try { sock.write(Buffer.from(reply)) } catch { /* closing anyway */ }
      }
      // Well past negotiation now — this is the login banner, and we are done.
      if (total >= 32_768) finish('up')
    })

    try {
      sock.connect({ host, port, autoSelectFamily: true })
    } catch {
      finish('closed')
    }
  })
}

/** Probe many targets with bounded concurrency. */
export async function probeAll(
  targets: { host: string; port: number }[],
  opts: {
    concurrency?: number
    timeoutMs?: number
    /** How long to stay connected after the handshake (0 disables the listen). */
    listenMs?: number
    onProgress?: (done: number, total: number) => void
  } = {}
): Promise<Map<string, ProbeResult>> {
  const { concurrency = 40, timeoutMs = 8000, listenMs = 4000, onProgress } = opts
  const results = new Map<string, ProbeResult>()
  let index = 0
  let done = 0

  async function worker(): Promise<void> {
    for (;;) {
      const i = index++
      if (i >= targets.length) return
      const t = targets[i]
      results.set(`${t.host}:${t.port}`, await probeOne(t.host, t.port, timeoutMs, listenMs))
      done++
      if (onProgress && done % 25 === 0) onProgress(done, targets.length)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))
  onProgress?.(done, targets.length)
  return results
}
