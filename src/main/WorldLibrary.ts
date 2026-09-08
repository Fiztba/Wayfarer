import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWrite, safeFileKey, resolveKeyedFile } from './storage'
import type { ProfileStore } from './ProfileStore'
import type { SettingsStore } from './SettingsStore'
import type { MapStore } from './MapStore'
import type { WorldBundle, WorldPreview, WorldBackup } from '../shared/world'
import { defaultSettings } from '../shared/types'

const LIMIT = 64 * 1024 * 1024
const record = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v)
/** Validate portable data before any persistent writes or renderer use. */
export function validateWorld(raw: any): WorldBundle {
  if (!record(raw) || raw.format !== 'wayfarer-world' || raw.version !== 1) throw new Error('Not a supported Wayfarer world file')
  const p = raw.profile, m = raw.map
  if (!record(raw.settings)) throw new Error('Invalid world settings')
  const s = { ...defaultSettings(), ...raw.settings }
  if (!record(p) || typeof p.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(p.id) || typeof p.name !== 'string' || typeof p.host !== 'string' || !p.host.trim() ||
    !Number.isInteger(p.port) || p.port < 1 || p.port > 65535) throw new Error('Invalid world connection details')
  if (!record(s) || !record(s.options) || !record(s.variables)) throw new Error('Invalid world settings')
  for (const key of ['triggers', 'aliases', 'macros', 'timers', 'scripts', 'gauges']) {
    if (!Array.isArray(s[key]) || s[key].some((entry: any) => !record(entry) || typeof entry.id !== 'string')) throw new Error(`Invalid ${key}`)
  }
  const fields = (o: any, strings: string[], bools: string[] = [], numbers: string[] = []) => {
    if (!record(o) || strings.some((k) => o[k] !== undefined && typeof o[k] !== 'string') ||
      bools.some((k) => o[k] !== undefined && typeof o[k] !== 'boolean') ||
      numbers.some((k) => o[k] !== undefined && !Number.isFinite(o[k]))) throw new Error('Invalid field type in world file')
  }
  const stringList = (v: any) => v === undefined || (Array.isArray(v) && v.every((s: any) => typeof s === 'string'))
  if (Object.values(s.variables).some((v) => typeof v !== 'string')) throw new Error('Variables must be text values')
  for (const [k, v] of Object.entries(defaultSettings().options)) if (s.options[k] !== undefined &&
    (typeof s.options[k] !== typeof v || (typeof v === 'number' && !Number.isFinite(s.options[k])))) throw new Error('Invalid settings option')
  for (const key of ['triggers','aliases','macros','timers','scripts','gauges']) for (const entry of s[key]) {
    fields(entry, ['id','label','name','pattern','commands','language','highlight','captureWindow','character','key','code','valueVar','maxVar','color'], ['enabled','gag','caseInsensitive','oneShot'], ['intervalMs'])
    const required: Record<string, string[]> = { triggers: ['pattern','commands'], aliases: ['name','commands'], macros: ['key','commands'], timers: ['commands'], scripts: ['name','code'], gauges: ['label','valueVar','maxVar'] }
    if (required[key].some((k) => typeof entry[k] !== 'string')) throw new Error(`Incomplete ${key} entry`)
    if (entry.language !== undefined && !['commands','js','lua'].includes(entry.language)) throw new Error('Unknown action language')
  }
  if (s.capture !== undefined) {
    fields(s.capture, ['exitsLine','exitsHeader','exitsItem','title'], ['builtins'])
    if (!stringList(s.capture.titleStrip) || !stringList(s.capture.ignore)) throw new Error('Invalid capture rules')
  }
  const validExit = (e: any) => {
    fields(e, ['command','doorName','destName','destServerId'], ['door','avoid'], ['cost'])
    if ((e.to !== null && typeof e.to !== 'string') || (e.dir !== null && !['n','s','e','w','ne','nw','se','sw','u','d'].includes(e.dir))) throw new Error('Invalid map exit')
  }
  const validRoom = (r: any, id: string) => {
    if (!record(r) || r.id !== id || typeof r.name !== 'string' || typeof r.zoneId !== 'string' ||
      ![r.x, r.y, r.z].every(Number.isFinite) || !Array.isArray(r.exits)) throw new Error('Invalid map room')
    fields(r, ['serverId','color','notes'], ['avoid'], ['cost'])
    if (!stringList(r.descHashes) || !stringList(r.rivals)) throw new Error('Invalid room identity data')
    r.exits.forEach(validExit)
  }
  if (m !== null) {
    if (!record(m) || m.version !== 1 || !record(m.rooms) || !Array.isArray(m.zones) || !Array.isArray(m.waypoints)) throw new Error('Invalid map')
    for (const [id, r] of Object.entries(m.rooms) as [string, any][]) {
      validRoom(r, id)
    }
    if (m.zones.some((z: any) => !record(z) || typeof z.id !== 'string' || typeof z.name !== 'string') ||
      m.waypoints.some((w: any) => !record(w) || typeof w.name !== 'string' || typeof w.roomId !== 'string')) throw new Error('Invalid map zones or waypoints')
    if (m.merges !== undefined) {
      if (!Array.isArray(m.merges)) throw new Error('Invalid merge history')
      for (const merge of m.merges) {
        fields(merge, ['id','keptId','keptName','reason'], ['auto'], ['at'])
        if (!record(merge.dropped) || !Array.isArray(merge.keptExits) || !Array.isArray(merge.inbound) || !stringList(merge.waypoints)) throw new Error('Invalid merge history')
        validRoom(merge.dropped, merge.dropped.id); merge.keptExits.forEach(validExit)
        for (const inbound of merge.inbound) fields(inbound, ['roomId','command'])
      }
    }
    if (m.relayout !== undefined && (!record(m.relayout) || typeof m.relayout.zoneId !== 'string' || !record(m.relayout.before) ||
      Object.values(m.relayout.before).some((v: any) => !Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)))) throw new Error('Invalid layout history')
    if (m.popout != null) { fields(m.popout, [], [], ['x','y','width','height']) }
  }
  return { ...raw, settings: s }
}

export class WorldLibrary {
  private pending = new Map<string, WorldBundle>()
  constructor(private base: string, private profiles: ProfileStore, private settings: SettingsStore,
    private maps: MapStore, private isOpen: (id: string) => boolean = () => false) {}

  bundle(id: string): WorldBundle {
    const profile = this.profiles.list().find((p) => p.id === id)
    if (!profile) throw new Error('World no longer exists')
    return { format: 'wayfarer-world', version: 1, exportedAt: new Date().toISOString(), profile,
      settings: this.settings.get(id), map: this.maps.load(id) }
  }
  read(file: string): any {
    if (fs.statSync(file).size > LIMIT) throw new Error('World file exceeds 64 MB')
    return JSON.parse(fs.readFileSync(file, 'utf8'), (key, value) => {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsupported object key in world file')
      return value
    })
  }
  preview(raw: unknown, source: string): WorldPreview {
    const bundle = validateWorld(raw)
    const token = randomUUID()
    this.pending.clear() // one preview owns the next import; old tokens cannot be replayed
    this.pending.set(token, structuredClone(bundle))
    return { token, profileId: bundle.profile.id, name: bundle.profile.name, host: bundle.profile.host, port: bundle.profile.port,
      rooms: Object.keys((bundle.map as any)?.rooms ?? {}).length, triggers: bundle.settings.triggers.length,
      aliases: bundle.settings.aliases.length, scripts: bundle.settings.scripts.length,
      variables: Object.keys(bundle.settings.variables).length, source }
  }
  snapshot(id: string): void {
    const dir = path.join(this.base, 'backups', 'worlds', safeFileKey(id))
    fs.mkdirSync(dir, { recursive: true })
    const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`
    atomicWrite(path.join(dir, filename), JSON.stringify(this.bundle(id)))
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    for (const f of files.slice(0, Math.max(0, files.length - 25))) fs.unlinkSync(path.join(dir, f))
  }
  import(token: string, replaceId: string | null) {
    const bundle = this.pending.get(token)
    if (!bundle) throw new Error('Preview expired. Select the file or backup again.')
    if (replaceId && this.isOpen(replaceId)) throw new Error('Close all tabs for this world before replacing it.')
    const exists = replaceId && this.profiles.list().some((p) => p.id === replaceId)
    if (replaceId && !exists && (replaceId !== bundle.profile.id || !/^[a-zA-Z0-9-]{1,100}$/.test(replaceId))) throw new Error('Invalid restore target')
    const previous = exists ? this.bundle(replaceId!) : null
    if (previous) this.snapshot(replaceId!)
    const id = replaceId ?? randomUUID()
    // Preserve even orphaned component files from a deleted profile. Failed
    // imports must not erase those or leave partially-created new worlds.
    const originals = ['profiles','settings','maps'].map((kind) => {
      const dir = path.join(this.base, kind), file = resolveKeyedFile(dir, id)
      return { dir, file, raw: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null }
    })
    try {
      this.settings.save(id, bundle.settings)
      this.maps.save(id, bundle.map)
      const profile = this.profiles.save({ ...bundle.profile, id })
      this.pending.delete(token)
      return profile
    } catch (err) {
      const failures: string[] = []
      for (const old of originals) {
        try {
          const current = resolveKeyedFile(old.dir, id)
          if (old.raw !== null) atomicWrite(old.file, old.raw)
          if (fs.existsSync(current) && (old.raw === null || current !== old.file)) fs.unlinkSync(current)
        } catch (rollback) { failures.push(String(rollback)) }
      }
      if (failures.length) throw new Error(`${String(err)}. Recovery could not finish: ${failures.join('; ')}. ${previous ? 'The pre-replacement world snapshot is retained.' : 'Some component files may require manual recovery.'}`)
      throw err
    }
  }
  private backupFiles(): (WorldBackup & { file: string })[] {
    const result: (WorldBackup & { file: string })[] = []
    const profiles = this.profiles.list()
    const names = new Map(profiles.map((p) => [safeFileKey(p.id), p.name]))
    const nameFor = (key: string) => {
      if (!names.has(key)) {
        const profileDir = path.join(this.base, 'backups', key)
        try {
          const latest = fs.readdirSync(profileDir).filter((f) => f.endsWith('.json')).sort().at(-1)
          const p = latest ? this.read(path.join(profileDir, latest)) : null
          names.set(key, typeof p?.name === 'string' ? `${p.name} (deleted)` : `Deleted world (${key})`)
        } catch { names.set(key, `Deleted world (${key})`) }
      }
      return names.get(key)!
    }
    for (const kind of ['worlds', 'profile', 'settings', 'maps']) {
      const root = path.join(this.base, 'backups', kind === 'profile' ? '' : kind)
      if (!fs.existsSync(root)) continue
      for (const key of fs.readdirSync(root, { withFileTypes: true })) {
        if (!key.isDirectory() || (kind === 'profile' && ['worlds','settings','maps'].includes(key.name))) continue
        const dir = path.join(root, key.name)
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue
          const file = path.join(dir, entry.name)
          result.push({ id: `${kind}/${key.name}/${entry.name}`, kind, profileId: key.name,
            name: nameFor(key.name),
            at: fs.statSync(file).mtime.toISOString(), file })
        }
      }
    }
    return result.sort((a, b) => b.at.localeCompare(a.at))
  }
  backups(): WorldBackup[] { return this.backupFiles().map(({ file, ...item }) => item) }
  previewBackup(id: string): WorldPreview {
    const backup = this.backupFiles().find((b) => b.id === id)
    if (!backup) throw new Error('Backup no longer exists')
    const raw = this.read(backup.file)
    if (backup.kind === 'worlds') return this.preview(raw, `World snapshot · ${backup.at}`)
    const current = this.profiles.list().find((p) => safeFileKey(p.id) === backup.profileId)
    const profile = backup.kind === 'profile' ? raw : current
    if (!profile) throw new Error('Restore a profile backup first, then restore its settings or map.')
    const bundle: WorldBundle = { format: 'wayfarer-world', version: 1, exportedAt: backup.at, profile,
      settings: backup.kind === 'settings' ? raw : this.settings.get(profile.id),
      map: backup.kind === 'maps' ? raw : this.maps.load(profile.id) }
    return this.preview(bundle, `${backup.kind} backup · ${backup.at}; other components use current saved data`)
  }
}
