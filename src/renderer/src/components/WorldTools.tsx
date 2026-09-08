import React, { useEffect, useState } from 'react'
import type { Profile } from '../../../shared/types'
import type { WorldBackup, WorldPreview } from '../../../shared/world'
import { sessionStores, forgetWorldMap } from '../SessionStore'
import { settingsManager } from '../SettingsManager'
import { useToolDialog } from './useToolDialog'

export function WorldTools({ onClose }: { onClose(): void }) {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [backups, setBackups] = useState<WorldBackup[]>([])
  const [selected, setSelected] = useState('')
  const [preview, setPreview] = useState<WorldPreview | null>(null)
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const dialogRef = useToolDialog(onClose, busy)
  const [message, setMessage] = useState('')
  const [filter, setFilter] = useState('')
  const refresh = async () => {
    const [p, b] = await Promise.all([window.mud.profiles.list(), window.mud.worlds.backups()])
    setProfiles(p); setBackups(b); setSelected((id) => p.some((x) => x.id === id) ? id : p[0]?.id ?? '')
  }
  const run = async (job: () => Promise<void>) => {
    setBusy(true); setMessage('')
    try { await job() } catch (err) { setMessage(String(err)) } finally { setBusy(false) }
  }
  useEffect(() => { void run(refresh) }, [])
  const flush = async () => { for (const store of sessionStores.values()) if (store.profileId === selected) await store.flushWorld() }
  const showPreview = (p: WorldPreview | null, restore: boolean) => { setPreview(p); setTarget(restore && p ? p.profileId : '') }
  return <div className="tools-overlay"><section ref={dialogRef} className="tools-panel" role="dialog" aria-modal="true" aria-label="World library">
    <div className="tool-heading"><h2>World library</h2><button onClick={onClose} disabled={busy} aria-label="Close world library">✕</button></div>
    <p>Export a world's connection, automation, variables and map in one file. Global settings are separate. Exported variables and scripts may contain private information.</p>
    <fieldset disabled={busy}>
      <label>Saved world <select value={selected} onChange={(e) => setSelected(e.target.value)}>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <div className="tool-actions">
        <button disabled={!selected} onClick={() => void run(async () => { await flush(); if (await window.mud.worlds.export(selected)) setMessage('World exported.') })}>Export world…</button>
        <button disabled={!selected} onClick={() => void run(async () => { await flush(); await window.mud.worlds.snapshot(selected); await refresh(); setMessage('World snapshot saved.') })}>Create backup</button>
        <button onClick={() => void run(async () => showPreview(await window.mud.worlds.chooseImport(), false))}>Import world…</button>
      </div>
      {preview && <section className="world-preview">
        <h3>Preview: {preview.name}</h3><p>{preview.host}:{preview.port} · {preview.source}</p>
        <p>{preview.rooms} rooms · {preview.triggers} triggers · {preview.aliases} aliases · {preview.scripts} scripts · {preview.variables} variables</p>
        <label>Destination <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Import as a new world</option>
          {!profiles.some((p) => p.id === preview.profileId) && <option value={preview.profileId}>Restore deleted world</option>}
          {profiles.map((p) => <option key={p.id} value={p.id}>Replace {p.name}</option>)}
        </select></label>
        <p>{target ? 'Close every tab for the destination world first. Its current data is backed up before replacement.' : 'A separate world is created; existing worlds are preserved.'} Imported scripts run according to their saved settings when you connect.</p>
        <button onClick={() => void run(async () => { const p = await window.mud.worlds.import(preview.token, target || null); forgetWorldMap(p.id); setPreview(null); await settingsManager.reload(p.id); await refresh(); setMessage(`Saved “${p.name}”.`) })}>{target ? 'Restore / replace world' : 'Import as new world'}</button>{' '}
        <button onClick={() => setPreview(null)}>Cancel preview</button>
      </section>}
      <h3>Backups</h3><input aria-label="Filter backups" placeholder="Filter by world name" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="backup-list">{backups.filter((b) => b.name.toLowerCase().includes(filter.toLowerCase())).map((b) =>
        <button key={b.id} onClick={() => void run(async () => showPreview(await window.mud.worlds.previewBackup(b.id), true))}>
          {b.name} · {b.kind === 'worlds' ? 'World snapshot' : `${b.kind} backup`} · {new Date(b.at).toLocaleString()}
        </button>)}{backups.length === 0 && <p>No backups yet. Create a snapshot above; ordinary saves also retain component backups.</p>}</div>
    </fieldset>
    <p role="status">{busy ? 'Working…' : message}</p>
  </section></div>
}
