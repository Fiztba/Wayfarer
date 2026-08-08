/**
 * TelnetSocket — a full telnet protocol engine for MUD connections.
 *
 * Handles: option negotiation (WILL/WONT/DO/DONT with loop protection),
 * subnegotiation, TTYPE/MTTS cycling, NAWS, CHARSET, ECHO (password masking),
 * EOR/GA prompt marking, MCCP2 (zlib inflate), GMCP, MSSP, and basic MSDP.
 *
 * This module is intentionally self-contained (Node builtins only) so it can
 * be exercised headlessly outside Electron.
 */
import { EventEmitter } from 'node:events'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { StringDecoder } from 'node:string_decoder'

// Telnet commands
const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const GA = 249
const NOP = 241
const SE = 240
const EOR_CMD = 239

// Telnet options
export const OPT = {
  BINARY: 0,
  ECHO: 1,
  SGA: 3,
  TTYPE: 24,
  EOR: 25,
  NAWS: 31,
  CHARSET: 42,
  MSDP: 69,
  MSSP: 70,
  COMPRESS2: 86,
  MSP: 90,
  MXP: 91,
  ATCP: 200,
  GMCP: 201
} as const

// CHARSET subnegotiation codes
const CHARSET_REQUEST = 1
const CHARSET_ACCEPTED = 2
const CHARSET_REJECTED = 3

// TTYPE subnegotiation codes
const TTYPE_IS = 0
const TTYPE_SEND = 1

// MSSP subnegotiation codes
const MSSP_VAR = 1
const MSSP_VAL = 2

// Parser states
const ST_DATA = 0
const ST_IAC = 1
const ST_NEG = 2
const ST_SB_OPT = 3
const ST_SB_DATA = 4
const ST_SB_IAC = 5

export type Encoding = 'utf8' | 'latin1'

export interface TelnetOptions {
  host: string
  port: number
  tls?: boolean
  encoding?: Encoding
  /** Terminal-type names reported via TTYPE cycling (MTTS). */
  termTypes?: string[]
}

export interface TelnetEvents {
  connect: []
  close: [hadError: boolean]
  error: [message: string]
  /** Decoded in-band text from the server. */
  text: [data: string]
  /** Server sent GA or EOR — the current partial line is a prompt. */
  prompt: []
  /** true = server is echoing (client should mask input, e.g. passwords). */
  echo: [serverEchoes: boolean]
  gmcp: [pkg: string, data: unknown]
  mssp: [data: Record<string, string>]
  msdp: [data: Record<string, unknown>]
  /** Emitted when MCCP2 compression begins. */
  compression: [enabled: boolean]
  gmcpEnabled: []
  msdpEnabled: []
  mxpEnabled: []
  mspEnabled: []
}

export class TelnetSocket extends EventEmitter<TelnetEvents> {
  private socket: net.Socket | null = null
  private inflater: zlib.Inflate | null = null
  private decoder: StringDecoder

  private state = ST_DATA
  private pendingNeg = 0
  private sbOption = 0
  private sbBuf: number[] = []
  private textBuf: number[] = []

  /** Options the remote end has active (they sent WILL, we sent DO). */
  private remoteOpts = new Set<number>()
  /** Options we have active locally (they sent DO, we sent WILL). */
  private localOpts = new Set<number>()

  private ttypeIndex = 0
  private termTypes: string[]
  private naws: { cols: number; rows: number } = { cols: 100, rows: 40 }

  readonly opts: TelnetOptions
  encoding: Encoding
  gmcpActive = false
  compressed = false
  closed = false

  constructor(opts: TelnetOptions) {
    super()
    this.opts = opts
    this.encoding = opts.encoding ?? 'utf8'
    this.decoder = new StringDecoder(this.encoding)
    this.termTypes = opts.termTypes ?? ['WAYFARER', 'XTERM', 'MTTS 269']
  }

  connect(): void {
    const onConnect = () => this.emit('connect')
    if (this.opts.tls) {
      this.socket = tls.connect(
        { host: this.opts.host, port: this.opts.port, rejectUnauthorized: false },
        onConnect
      )
    } else {
      this.socket = net.connect({ host: this.opts.host, port: this.opts.port }, onConnect)
    }
    this.socket.setNoDelay(true)
    this.socket.setKeepAlive(true, 30_000)
    this.socket.on('data', (buf: Buffer) => this.feed(buf))
    this.socket.on('error', (err) => this.emit('error', err.message))
    this.socket.on('close', (hadError) => {
      this.closed = true
      this.emit('close', hadError)
    })
  }

  destroy(): void {
    this.socket?.destroy()
    this.inflater?.close()
    this.inflater = null
  }

  /** Send a line of user input (appends CRLF, escapes IAC bytes). */
  sendLine(text: string): void {
    const raw = Buffer.from(text + '\r\n', this.encoding)
    this.writeEscaped(raw)
  }

  sendGmcp(pkg: string, data?: unknown): void {
    if (!this.gmcpActive) return
    const payload = data === undefined ? pkg : `${pkg} ${JSON.stringify(data)}`
    const body = Buffer.from(payload, 'utf8')
    this.writeSub(OPT.GMCP, body)
  }

  setWindowSize(cols: number, rows: number): void {
    this.naws = { cols, rows }
    if (this.localOpts.has(OPT.NAWS)) this.sendNaws()
  }

  // ---- wire helpers -------------------------------------------------------

  private write(buf: Buffer): void {
    if (this.socket && !this.closed) this.socket.write(buf)
  }

  private writeEscaped(raw: Buffer): void {
    if (!raw.includes(IAC)) {
      this.write(raw)
      return
    }
    const out: number[] = []
    for (const b of raw) {
      out.push(b)
      if (b === IAC) out.push(IAC)
    }
    this.write(Buffer.from(out))
  }

  private sendCmd(cmd: number, opt: number): void {
    this.write(Buffer.from([IAC, cmd, opt]))
  }

  private writeSub(opt: number, body: Buffer): void {
    const escaped: number[] = []
    for (const b of body) {
      escaped.push(b)
      if (b === IAC) escaped.push(IAC)
    }
    this.write(Buffer.from([IAC, SB, opt, ...escaped, IAC, SE]))
  }

  private sendNaws(): void {
    const { cols, rows } = this.naws
    this.writeSub(OPT.NAWS, Buffer.from([cols >> 8, cols & 0xff, rows >> 8, rows & 0xff]))
  }

  // ---- inbound data path --------------------------------------------------

  private feed(buf: Buffer): void {
    if (this.inflater) {
      this.inflater.write(buf)
    } else {
      this.parse(buf)
    }
  }

  private startCompression(remainder: Buffer): void {
    this.compressed = true
    this.inflater = zlib.createInflate()
    this.inflater.on('data', (d: Buffer) => this.parse(d))
    this.inflater.on('error', (err) => this.emit('error', `MCCP2 error: ${err.message}`))
    this.inflater.on('end', () => {
      this.inflater = null
      this.compressed = false
      this.emit('compression', false)
    })
    this.emit('compression', true)
    if (remainder.length > 0) this.inflater.write(remainder)
  }

  private flushText(): void {
    if (this.textBuf.length === 0) return
    const text = this.decoder.write(Buffer.from(this.textBuf))
    this.textBuf = []
    if (text.length > 0) this.emit('text', text)
  }

  private parse(buf: Buffer): void {
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i]
      switch (this.state) {
        case ST_DATA:
          if (b === IAC) this.state = ST_IAC
          else this.textBuf.push(b)
          break

        case ST_IAC:
          if (b === WILL || b === WONT || b === DO || b === DONT) {
            this.pendingNeg = b
            this.state = ST_NEG
          } else if (b === SB) {
            this.state = ST_SB_OPT
          } else if (b === IAC) {
            this.textBuf.push(IAC)
            this.state = ST_DATA
          } else if (b === GA || b === EOR_CMD) {
            this.flushText()
            this.emit('prompt')
            this.state = ST_DATA
          } else {
            // NOP and anything else: ignore
            this.state = ST_DATA
          }
          break

        case ST_NEG:
          this.flushText()
          this.handleNegotiation(this.pendingNeg, b)
          this.state = ST_DATA
          break

        case ST_SB_OPT:
          this.sbOption = b
          this.sbBuf = []
          this.state = ST_SB_DATA
          break

        case ST_SB_DATA:
          if (b === IAC) this.state = ST_SB_IAC
          else this.sbBuf.push(b)
          break

        case ST_SB_IAC:
          if (b === SE) {
            this.state = ST_DATA
            const opt = this.sbOption
            const data = Buffer.from(this.sbBuf)
            this.sbBuf = []
            if (opt === OPT.COMPRESS2) {
              // Everything after IAC SE is a zlib stream.
              this.flushText()
              this.startCompression(buf.subarray(i + 1))
              return
            }
            this.handleSubnegotiation(opt, data)
          } else if (b === IAC) {
            this.sbBuf.push(IAC)
            this.state = ST_SB_DATA
          } else {
            // Malformed; be lenient.
            this.sbBuf.push(IAC, b)
            this.state = ST_SB_DATA
          }
          break
      }
    }
    this.flushText()
  }

  // ---- negotiation --------------------------------------------------------

  private handleNegotiation(cmd: number, opt: number): void {
    if (cmd === WILL) {
      const accept =
        opt === OPT.ECHO ||
        opt === OPT.SGA ||
        opt === OPT.EOR ||
        opt === OPT.MSSP ||
        opt === OPT.MSDP ||
        opt === OPT.COMPRESS2 ||
        opt === OPT.GMCP ||
        opt === OPT.MXP ||
        opt === OPT.MSP ||
        opt === OPT.BINARY
      if (accept) {
        if (!this.remoteOpts.has(opt)) {
          this.remoteOpts.add(opt)
          this.sendCmd(DO, opt)
          this.onRemoteEnabled(opt)
        }
      } else {
        this.sendCmd(DONT, opt)
      }
    } else if (cmd === WONT) {
      if (this.remoteOpts.delete(opt)) {
        this.sendCmd(DONT, opt)
        if (opt === OPT.ECHO) this.emit('echo', false)
      }
    } else if (cmd === DO) {
      const accept =
        opt === OPT.TTYPE ||
        opt === OPT.NAWS ||
        opt === OPT.CHARSET ||
        opt === OPT.SGA ||
        opt === OPT.MXP ||
        opt === OPT.BINARY
      if (accept) {
        if (!this.localOpts.has(opt)) {
          this.localOpts.add(opt)
          this.sendCmd(WILL, opt)
          if (opt === OPT.NAWS) this.sendNaws()
          if (opt === OPT.MXP) this.emit('mxpEnabled')
        }
      } else {
        this.sendCmd(WONT, opt)
      }
    } else if (cmd === DONT) {
      if (this.localOpts.delete(opt)) this.sendCmd(WONT, opt)
    }
  }

  private onRemoteEnabled(opt: number): void {
    if (opt === OPT.ECHO) this.emit('echo', true)
    if (opt === OPT.GMCP) {
      this.gmcpActive = true
      this.emit('gmcpEnabled')
    }
    if (opt === OPT.MSDP) this.emit('msdpEnabled')
    if (opt === OPT.MXP) this.emit('mxpEnabled')
    if (opt === OPT.MSP) this.emit('mspEnabled')
  }

  /** Send an MSDP VAR/VAL pair (e.g. sendMsdp('REPORT', 'ROOM')). */
  sendMsdp(varName: string, value: string): void {
    const MSDP_VAR = 1
    const MSDP_VAL = 2
    this.writeSub(
      OPT.MSDP,
      Buffer.concat([
        Buffer.from([MSDP_VAR]),
        Buffer.from(varName, 'ascii'),
        Buffer.from([MSDP_VAL]),
        Buffer.from(value, 'ascii')
      ])
    )
  }

  // ---- subnegotiation -----------------------------------------------------

  private handleSubnegotiation(opt: number, data: Buffer): void {
    switch (opt) {
      case OPT.TTYPE:
        if (data[0] === TTYPE_SEND) this.sendTtype()
        break
      case OPT.CHARSET:
        this.handleCharset(data)
        break
      case OPT.GMCP:
        this.handleGmcp(data)
        break
      case OPT.MSSP:
        this.handleMssp(data)
        break
      case OPT.MSDP:
        this.handleMsdp(data)
        break
    }
  }

  private sendTtype(): void {
    const name = this.termTypes[Math.min(this.ttypeIndex, this.termTypes.length - 1)]
    this.ttypeIndex++
    this.writeSub(OPT.TTYPE, Buffer.concat([Buffer.from([TTYPE_IS]), Buffer.from(name, 'ascii')]))
  }

  private handleCharset(data: Buffer): void {
    if (data[0] !== CHARSET_REQUEST || data.length < 3) return
    const sep = String.fromCharCode(data[1])
    const offered = data.subarray(2).toString('ascii').split(sep)
    const utf8 = offered.find((c) => /^utf-?8$/i.test(c))
    const latin = offered.find((c) => /^(iso-?8859-?1|latin-?1)$/i.test(c))
    const pick = utf8 ?? latin
    if (pick) {
      this.encoding = utf8 ? 'utf8' : 'latin1'
      this.decoder = new StringDecoder(this.encoding)
      this.writeSub(
        OPT.CHARSET,
        Buffer.concat([Buffer.from([CHARSET_ACCEPTED]), Buffer.from(pick, 'ascii')])
      )
    } else {
      this.writeSub(OPT.CHARSET, Buffer.from([CHARSET_REJECTED]))
    }
  }

  private handleGmcp(data: Buffer): void {
    const text = data.toString('utf8')
    const space = text.indexOf(' ')
    const pkg = space === -1 ? text : text.slice(0, space)
    const rest = space === -1 ? '' : text.slice(space + 1).trim()
    let parsed: unknown = null
    if (rest) {
      try {
        parsed = JSON.parse(rest)
      } catch {
        parsed = rest
      }
    }
    this.emit('gmcp', pkg, parsed)
  }

  private handleMssp(data: Buffer): void {
    const result: Record<string, string> = {}
    let mode: number = 0
    let varName = ''
    let acc: number[] = []
    const commit = () => {
      const s = Buffer.from(acc).toString('utf8')
      acc = []
      if (mode === MSSP_VAR) varName = s
      else if (mode === MSSP_VAL && varName) {
        result[varName] = result[varName] ? `${result[varName]}, ${s}` : s
      }
    }
    for (const b of data) {
      if (b === MSSP_VAR || b === MSSP_VAL) {
        commit()
        mode = b
      } else {
        acc.push(b)
      }
    }
    commit()
    if (Object.keys(result).length > 0) this.emit('mssp', result)
  }

  private handleMsdp(data: Buffer): void {
    const result = parseMsdpPairs(data, { i: 0 }, null)
    if (Object.keys(result).length > 0) this.emit('msdp', result)
  }
}

// ---- MSDP wire format (supports nested tables/arrays) -----------------------

const MSDP_VAR = 1
const MSDP_VAL = 2
const MSDP_TABLE_OPEN = 3
const MSDP_TABLE_CLOSE = 4
const MSDP_ARRAY_OPEN = 5
const MSDP_ARRAY_CLOSE = 6

interface Cursor {
  i: number
}

function msdpReadString(data: Buffer, cur: Cursor): string {
  const start = cur.i
  while (cur.i < data.length && (data[cur.i] > 6 || data[cur.i] === 0)) cur.i++
  return data.subarray(start, cur.i).toString('utf8')
}

function msdpReadValue(data: Buffer, cur: Cursor): unknown {
  const b = data[cur.i]
  if (b === MSDP_TABLE_OPEN) {
    cur.i++
    return parseMsdpPairs(data, cur, MSDP_TABLE_CLOSE)
  }
  if (b === MSDP_ARRAY_OPEN) {
    cur.i++
    const arr: unknown[] = []
    while (cur.i < data.length && data[cur.i] !== MSDP_ARRAY_CLOSE) {
      if (data[cur.i] === MSDP_VAL) {
        cur.i++
        arr.push(msdpReadValue(data, cur))
      } else {
        cur.i++
      }
    }
    if (cur.i < data.length) cur.i++ // consume ARRAY_CLOSE
    return arr
  }
  return msdpReadString(data, cur)
}

/** Parse VAR/VAL pairs until end-of-buffer or the given closing byte. */
export function parseMsdpPairs(
  data: Buffer,
  cur: Cursor,
  closeByte: number | null
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  while (cur.i < data.length) {
    const b = data[cur.i]
    if (closeByte !== null && b === closeByte) {
      cur.i++
      return result
    }
    if (b === MSDP_VAR) {
      cur.i++
      const name = msdpReadString(data, cur)
      if (cur.i < data.length && data[cur.i] === MSDP_VAL) {
        cur.i++
        result[name] = msdpReadValue(data, cur)
      } else {
        result[name] = ''
      }
    } else {
      cur.i++
    }
  }
  return result
}
