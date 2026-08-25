import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Profile, Encoding, DirectoryResult } from '../../../shared/types'

interface Props {
  onConnect(opts: {
    host: string
    port: number
    tls: boolean
    encoding: Encoding
    name: string
    profileId?: string
  }): void
  onOpenHelp(): void
}

export function ConnectScreen({ onConnect, onOpenHelp }: Props) {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [tls, setTls] = useState(false)
  const [encoding, setEncoding] = useState<Encoding>('utf8')
  const [saveProfile, setSaveProfile] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const formRef = useRef<HTMLDivElement>(null)
  const [directory, setDirectory] = useState<DirectoryResult | null>(null)
  const [dirSearch, setDirSearch] = useState('')

  useEffect(() => {
    let cancelled = false
    window.mud.directory.list().then((d) => {
      if (!cancelled) setDirectory(d)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const dirMatches = useMemo(() => {
    if (!directory) return []
    const q = dirSearch.trim().toLowerCase()
    const all = q
      ? directory.entries.filter(
          (e) => e.name.toLowerCase().includes(q) || e.host.includes(q)
        )
      : directory.entries
    return all.slice(0, 30)
  }, [directory, dirSearch])

  const [loadError, setLoadError] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // Robust load: catches synchronous throws AND rejections (a bare
  // .then().catch() misses a sync throw, which silently left the list empty).
  // Retries a few times before surfacing an error, since a cold start can
  // briefly race the preload bridge.
  const refresh = useCallback(async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const list = await window.mud.profiles.list()
        setProfiles(list)
        setLoadError(false)
        return
      } catch {
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)))
      }
    }
    setLoadError(true)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const clearForm = useCallback(() => {
    setEditingId(null)
    setName('')
    setHost('')
    setPort('')
    setTls(false)
    setEncoding('utf8')
  }, [])

  const formValid = host.trim().length > 0 && Number(port) > 0

  const saveCurrent = useCallback(async (): Promise<Profile | null> => {
    if (!formValid) return null
    const saved = await window.mud.profiles.save({
      id: editingId ?? undefined,
      name: name.trim() || host.trim(),
      host: host.trim(),
      port: Number(port),
      tls,
      encoding
    })
    refresh()
    return saved
  }, [editingId, name, host, port, tls, encoding, formValid, refresh])

  const connectFromForm = useCallback(async () => {
    if (!formValid) return
    let profileId: string | undefined
    if (saveProfile || editingId) {
      const saved = await saveCurrent()
      profileId = saved?.id
    }
    onConnect({
      host: host.trim(),
      port: Number(port),
      tls,
      encoding,
      name: name.trim() || host.trim(),
      profileId
    })
  }, [formValid, saveProfile, editingId, saveCurrent, onConnect, host, port, tls, encoding, name])

  const saveOnly = useCallback(async () => {
    const saved = await saveCurrent()
    if (saved) clearForm()
  }, [saveCurrent, clearForm])

  const startEditing = useCallback((e: React.MouseEvent, p: Profile) => {
    e.stopPropagation()
    setEditingId(p.id)
    setName(p.name)
    setHost(p.host)
    setPort(String(p.port))
    setTls(p.tls)
    setEncoding(p.encoding)
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])

  const removeProfile = useCallback(
    async (id: string) => {
      await window.mud.profiles.remove(id)
      if (editingId === id) clearForm()
      setConfirmDeleteId(null)
      refresh()
    },
    [refresh, editingId, clearForm]
  )

  const onEnterKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') connectFromForm()
  }

  return (
    <div className="connect-screen">
      <div className="connect-panel">
        <h1 className="brand">Wayfarer</h1>
        <p className="tagline">
          Choose a world, or forge a path to a new one.{' '}
          <span className="brand-version">v{window.mud.version}</span>
        </p>
        <p className="help-link-row">
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              onOpenHelp()
            }}
          >
            New here? Read the feature guide →
          </a>
        </p>

        {loadError && (
          <p className="profiles-error">
            Couldn’t load your saved worlds — your data is untouched on disk.{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                void refresh()
              }}
            >
              Retry
            </a>
          </p>
        )}

        {profiles.length > 0 ? (
          <>
            <h2>Saved Worlds</h2>
            <div className="profile-list">
              {profiles.map((p) => (
                <div
                  key={p.id}
                  className={`profile-card ${p.id === editingId ? 'profile-editing' : ''}`}
                  onClick={() =>
                    onConnect({
                      host: p.host,
                      port: p.port,
                      tls: p.tls,
                      encoding: p.encoding,
                      name: p.name,
                      profileId: p.id
                    })
                  }
                >
                  <div className="profile-name">{p.name}</div>
                  <div className="profile-addr">
                    {p.host}:{p.port}
                    {p.tls ? ' (TLS)' : ''}
                  </div>
                  <div className="profile-actions" onClick={(e) => e.stopPropagation()}>
                    {confirmDeleteId === p.id ? (
                      <>
                        <span className="profile-confirm-text">Delete “{p.name}”?</span>
                        <button
                          className="profile-action profile-action-delete"
                          onClick={() => removeProfile(p.id)}
                        >
                          Delete
                        </button>
                        <button className="profile-action" onClick={() => setConfirmDeleteId(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="profile-action"
                          title="Edit profile"
                          onClick={(e) => startEditing(e, p)}
                        >
                          ✎
                        </button>
                        <button
                          className="profile-action profile-action-delete"
                          title="Delete profile (asks first; a backup is kept)"
                          onClick={() => setConfirmDeleteId(p.id)}
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          !loadError && (
            <p className="field-hint" style={{ marginBottom: 12 }}>
              No saved worlds yet — or expected some?{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault()
                  void refresh()
                }}
              >
                Reload saved worlds
              </a>
            </p>
          )
        )}

        <h2 ref={formRef as unknown as React.RefObject<HTMLHeadingElement>}>
          {editingId ? 'Edit World' : 'Quick Connect'}
        </h2>
        {editingId && (
          <p className="editing-note">
            Editing “{profiles.find((p) => p.id === editingId)?.name}” —{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                clearForm()
              }}
            >
              cancel
            </a>
          </p>
        )}
        <div className="connect-form">
          <div className="field">
            <label className="field-label" htmlFor="qc-name">
              Name <span className="field-hint">(optional — how the tab and profile are titled)</span>
            </label>
            <input
              id="qc-name"
              placeholder="e.g. Dawn of Demise"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="host-row">
            <div className="field field-host">
              <label className="field-label" htmlFor="qc-host">
                Host
              </label>
              <input
                id="qc-host"
                placeholder="e.g. tdod.org"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                onKeyDown={onEnterKey}
              />
            </div>
            <div className="field field-port">
              <label className="field-label" htmlFor="qc-port">
                Port
              </label>
              <input
                id="qc-port"
                placeholder="e.g. 4000"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
                onKeyDown={onEnterKey}
              />
            </div>
          </div>
          <div className="options-row">
            <label>
              <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} /> TLS
            </label>
            <label>
              Encoding{' '}
              <select value={encoding} onChange={(e) => setEncoding(e.target.value as Encoding)}>
                <option value="utf8">UTF-8</option>
                <option value="latin1">Latin-1</option>
              </select>
            </label>
            {!editingId && (
              <label>
                <input
                  type="checkbox"
                  checked={saveProfile}
                  onChange={(e) => setSaveProfile(e.target.checked)}
                />{' '}
                Save as profile
              </label>
            )}
          </div>
          <div className="button-row">
            {editingId && (
              <button className="save-btn" disabled={!formValid} onClick={saveOnly}>
                Save Changes
              </button>
            )}
            <button className="connect-btn" disabled={!formValid} onClick={connectFromForm}>
              {editingId ? 'Save & Connect' : 'Connect'}
            </button>
          </div>
        </div>

        <h2>Browse the Realms</h2>
        <p className="dir-credit">
          Listings courtesy of{' '}
          <a href="https://www.mudconnect.com/" target="_blank" rel="noreferrer">
            The Mud Connector
          </a>
          {directory?.fetchedAt && (
            <> · updated {new Date(directory.fetchedAt).toLocaleDateString()}</>
          )}
        </p>
        {directory === null ? (
          <p className="dir-status">Loading directory…</p>
        ) : directory.source === 'unavailable' ? (
          <p className="dir-status">
            Couldn’t load the MUD directory ({directory.error}). You can still connect directly
            above.
          </p>
        ) : (
          <>
            <div className="field">
              <input
                placeholder={`Search ${directory.entries.length} worlds by name or host…`}
                value={dirSearch}
                onChange={(e) => setDirSearch(e.target.value)}
              />
            </div>
            <div className="dir-list">
              {dirMatches.map((e) => (
                <div
                  key={`${e.host}:${e.port}`}
                  className="dir-row"
                  title="Click to fill the connect form"
                  onClick={() => {
                    setEditingId(null)
                    setName(e.name)
                    setHost(e.host)
                    setPort(String(e.port))
                    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
                  }}
                >
                  <span className={`dir-dot ${e.connected ? 'dir-dot-up' : ''}`}>●</span>
                  <span className="dir-name">{e.name}</span>
                  <span className="dir-addr">
                    {e.host}:{e.port}
                  </span>
                </div>
              ))}
              {dirMatches.length === 0 && (
                <p className="dir-status">No worlds match “{dirSearch}”.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
