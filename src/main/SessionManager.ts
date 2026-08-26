import crypto from 'node:crypto'
import { app, type WebContents } from 'electron'
import { TelnetSocket } from './telnet/TelnetSocket'
import type { ConnectOptions, SessionEvent } from '../shared/types'

const GMCP_SUPPORTS = [
  'Core 1',
  'Char 1',
  'Char.Skills 1',
  'Char.Items 1',
  'Room 1',
  'Comm 1',
  'Comm.Channel 1'
]

interface SessionEntry {
  telnet: TelnetSocket
  opts: ConnectOptions
  size?: { cols: number; rows: number }
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>()

  constructor(private getWebContents: () => WebContents | null) {}

  connect(opts: ConnectOptions): string {
    const id = crypto.randomUUID()
    const entry: SessionEntry = { opts, telnet: null as unknown as TelnetSocket }
    this.sessions.set(id, entry)
    entry.telnet = this.buildTelnet(id, entry)
    return id
  }

  /** Rebuild the socket for an existing session (same id, same options). */
  reconnect(id: string): void {
    const entry = this.sessions.get(id)
    if (!entry) return
    entry.telnet.destroy()
    entry.telnet = this.buildTelnet(id, entry)
  }

  private buildTelnet(id: string, entry: SessionEntry): TelnetSocket {
    const { opts } = entry
    const telnet = new TelnetSocket({
      host: opts.host,
      port: opts.port,
      tls: opts.tls,
      encoding: opts.encoding
    })
    if (entry.size) telnet.setWindowSize(entry.size.cols, entry.size.rows)

    const emit = (event: SessionEvent) => {
      this.getWebContents()?.send('session:event', id, event)
    }

    telnet.on('connect', () => emit({ type: 'connected' }))
    telnet.on('close', (hadError) => {
      // Only report if this socket is still the session's current one —
      // a superseded socket's death is not news.
      if (this.sessions.get(id)?.telnet === telnet) {
        emit({ type: 'disconnected', hadError })
      }
    })
    telnet.on('error', (message) => emit({ type: 'error', message }))
    telnet.on('text', (data) => emit({ type: 'text', data }))
    telnet.on('prompt', () => emit({ type: 'prompt' }))
    telnet.on('echo', (serverEchoes) => emit({ type: 'echo', serverEchoes }))
    telnet.on('gmcp', (pkg, data) => emit({ type: 'gmcp', package: pkg, data }))
    telnet.on('mssp', (data) => emit({ type: 'mssp', data }))
    telnet.on('msdp', (data) => emit({ type: 'msdp', data }))
    telnet.on('mxpEnabled', () => emit({ type: 'mxpEnabled' }))
    telnet.on('mspEnabled', () => emit({ type: 'mspEnabled' }))
    telnet.on('msdpEnabled', () => {
      // Ask the server to push room info and vitals as they change. Room
      // identity has two rival conventions — a single ROOM table, or the flat
      // variables KaVir's protocol snippet defines (tbaMUD and the rest of the
      // DikuMUD family) — and a MUD implements one or the other, so ask for
      // both. A REPORT for a variable the server does not know is ignored.
      for (const variable of [
        'ROOM',
        'ROOM_VNUM',
        'ROOM_NAME',
        'ROOM_EXITS',
        'AREA_NAME',
        'HEALTH',
        'HEALTH_MAX',
        'MANA',
        'MANA_MAX',
        'MOVEMENT',
        'MOVEMENT_MAX',
        'LEVEL',
        'EXPERIENCE'
      ]) {
        telnet.sendMsdp('REPORT', variable)
      }
    })
    telnet.on('compression', (enabled) => emit({ type: 'compression', enabled }))
    telnet.on('gmcpEnabled', () => {
      telnet.sendGmcp('Core.Hello', { client: 'Wayfarer', version: app.getVersion() })
      telnet.sendGmcp('Core.Supports.Set', GMCP_SUPPORTS)
      emit({ type: 'gmcpEnabled' })
    })

    telnet.connect()
    return telnet
  }

  send(id: string, text: string): void {
    this.sessions.get(id)?.telnet.sendLine(text)
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.sessions.get(id)
    if (entry) {
      entry.size = { cols, rows }
      entry.telnet.setWindowSize(cols, rows)
    }
  }

  disconnect(id: string): void {
    const entry = this.sessions.get(id)
    if (entry) {
      entry.telnet.destroy()
      this.sessions.delete(id)
    }
  }

  destroyAll(): void {
    for (const entry of this.sessions.values()) entry.telnet.destroy()
    this.sessions.clear()
  }
}
