import React, { useMemo, useState } from 'react'
import type { DirectoryMud, DirectoryResult } from '../../../shared/types'
import { SORTS, SORT_LABELS, displayPlayers, playersTitle, type SortKey } from './directorySort'

/**
 * Filterable browser over the MUD directory snapshot.
 *
 * Two deliberate behaviours, both learned from what the source data is actually
 * like:
 *
 * Codebase matching is lineage-inclusive. Picking "CircleMUD" also returns
 * tbaMUD and LuminariMUD, because sources label the same MUD at different
 * levels of the tree — The Builder Academy is filed as plain CircleMUD by its
 * own host. Strict mode narrows to exactly the chosen label.
 *
 * Metadata filters are tri-state, not two-state. Asking for "Fantasy" should
 * return the MUDs tagged Fantasy, not those plus every MUD that never recorded
 * a genre — so unrecorded values are excluded by default. But coverage varies
 * enormously between fields, and a filter quietly hiding two thirds of the list
 * reads as a bug, so every control shows how many MUDs it actually knows about
 * and "Include unrecorded" widens the net when the data looks thin.
 */

interface Props {
  directory: DirectoryResult
  onPick(mud: DirectoryMud): void
}

const MAPPER_PROTOCOLS = ['GMCP', 'MSDP']

export function DirectoryBrowser({ directory, onPick }: Props): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [codebase, setCodebase] = useState('')
  const [strictCodebase, setStrictCodebase] = useState(false)
  const [category, setCategory] = useState('')
  const [liveOnly, setLiveOnly] = useState(true)
  const [includeUnknown, setIncludeUnknown] = useState(false)
  const [needsMapper, setNeedsMapper] = useState(false)
  const [needsTls, setNeedsTls] = useState(false)
  const [hasPlayers, setHasPlayers] = useState(false)
  const [freeOnly, setFreeOnly] = useState(false)
  const [hiring, setHiring] = useState(false)
  const [sort, setSort] = useState<SortKey>('name')
  const [limit, setLimit] = useState(60)

  const all = directory.entries

  /** Codebase options come from the data, counted over the whole lineage. */
  const codebaseOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of all) for (const a of m.ancestry) counts.set(a, (counts.get(a) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [all])

  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of all) {
      for (const c of m.categories) counts.set(c, (counts.get(c) ?? 0) + 1)
      if (m.genre) counts.set(m.genre, (counts.get(m.genre) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [all])

  const knownCounts = useMemo(
    () => ({
      codebase: all.filter((m) => m.codebase).length,
      category: all.filter((m) => m.categories.length || m.genre).length,
      protocols: all.filter((m) => m.protocols.length).length,
      players: all.filter((m) => m.players !== null || m.activePlayers !== null).length
    }),
    [all]
  )

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()

    const out = all.filter((m) => {
      if (liveOnly && m.liveness !== 'live') return false

      if (q) {
        const hay = `${m.name} ${m.host} ${m.tagline ?? ''} ${m.codebase ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }

      if (codebase) {
        if (!m.codebase) {
          if (!includeUnknown) return false
        } else if (strictCodebase ? m.codebase !== codebase : !m.ancestry.includes(codebase)) {
          return false
        }
      }

      if (category) {
        const known = m.categories.length > 0 || m.genre
        if (!known) {
          if (!includeUnknown) return false
        } else if (!m.categories.includes(category) && m.genre !== category) {
          return false
        }
      }

      // Protocol filters are the one place "unknown" cannot be included: a MUD
      // that never advertised GMCP is not a MUD where the mapper is known to
      // work, so silence has to read as "no" here.
      if (needsMapper && !m.protocols.some((p) => MAPPER_PROTOCOLS.includes(p))) return false
      if (needsTls && !m.protocols.includes('SSL') && m.tlsPort === null) return false

      // Matches the live count, so this never selects a MUD whose row shows 0.
      // Using the rolling average here would do exactly that.
      if (hasPlayers && !((m.players ?? 0) > 0)) return false
      if (freeOnly && m.payToPlay) return false
      if (hiring && !(m.hiringBuilders || m.hiringCoders)) return false

      return true
    })

    return [...out].sort(SORTS[sort])
  }, [
    all, search, codebase, strictCodebase, category, liveOnly, includeUnknown,
    needsMapper, needsTls, hasPlayers, freeOnly, hiring, sort
  ])

  const reset = (): void => {
    setSearch(''); setCodebase(''); setCategory(''); setStrictCodebase(false)
    setLiveOnly(true); setIncludeUnknown(false); setNeedsMapper(false)
    setNeedsTls(false); setHasPlayers(false); setFreeOnly(false); setHiring(false)
    setSort('name'); setLimit(60)
  }

  const activeFilters =
    Number(Boolean(codebase)) + Number(Boolean(category)) + Number(needsMapper) +
    Number(needsTls) + Number(hasPlayers) + Number(freeOnly) + Number(hiring)

  return (
    <>
      <div className="dir-controls">
        <div className="dir-search-row">
          <input
            className="dir-search"
            placeholder={`Search ${all.length} worlds by name, host or description…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} title="Sort by">
            {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                Sort: {SORT_LABELS[k]}
              </option>
            ))}
          </select>
        </div>

        <div className="dir-filter-row">
          <label className="dir-filter">
            <span>Codebase</span>
            <select value={codebase} onChange={(e) => setCodebase(e.target.value)}>
              <option value="">Any ({knownCounts.codebase} known)</option>
              {codebaseOptions.map(([name, n]) => (
                <option key={name} value={name}>
                  {name} ({n})
                </option>
              ))}
            </select>
          </label>

          <label className="dir-filter">
            <span>Theme</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Any ({knownCounts.category} known)</option>
              {categoryOptions.map(([name, n]) => (
                <option key={name} value={name}>
                  {name} ({n})
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="dir-toggle-row">
          <label title="Only MUDs that answered on the last sweep">
            <input type="checkbox" checked={liveOnly} onChange={(e) => setLiveOnly(e.target.checked)} />
            Online only
          </label>
          <label title="Advertises GMCP or MSDP, so Wayfarer's mapper tracks rooms exactly">
            <input type="checkbox" checked={needsMapper} onChange={(e) => setNeedsMapper(e.target.checked)} />
            Mapper works
          </label>
          <label title="Offers an encrypted connection">
            <input type="checkbox" checked={needsTls} onChange={(e) => setNeedsTls(e.target.checked)} />
            TLS
          </label>
          <label title="Someone was logged in when the sweep last checked">
            <input type="checkbox" checked={hasPlayers} onChange={(e) => setHasPlayers(e.target.checked)} />
            Has players
          </label>
          <label title="Excludes MUDs that charge to play">
            <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} />
            Free to play
          </label>
          <label title="Advertising for builders or coders">
            <input type="checkbox" checked={hiring} onChange={(e) => setHiring(e.target.checked)} />
            Hiring
          </label>
          {codebase && (
            <label title="Match only this exact codebase, not its descendants">
              <input
                type="checkbox"
                checked={strictCodebase}
                onChange={(e) => setStrictCodebase(e.target.checked)}
              />
              Exactly {codebase}
            </label>
          )}
          {(codebase || category) && (
            <label title="Also show MUDs that never recorded this field">
              <input
                type="checkbox"
                checked={includeUnknown}
                onChange={(e) => setIncludeUnknown(e.target.checked)}
              />
              Include unrecorded
            </label>
          )}
          {activeFilters > 0 && (
            <button className="dir-reset" onClick={reset}>
              Clear filters
            </button>
          )}
        </div>

        <p className="dir-count">
          {matches.length} of {all.length} worlds
          {codebase && !strictCodebase && ` · ${codebase} and everything derived from it`}
        </p>
      </div>

      <div className="dir-list">
        {matches.slice(0, limit).map((m) => (
          <div
            key={m.id}
            className="dir-row"
            title="Click to fill the connect form"
            onClick={() => onPick(m)}
          >
            <span className={`dir-dot dir-dot-${m.liveness}`} title={`${m.state} · ${m.liveness}`}>
              ●
            </span>
            <span className="dir-name">{m.name}</span>
            {m.codebase && (
              <span className={`dir-tag${m.codebaseConflict ? ' dir-tag-warn' : ''}`}
                    title={m.codebaseConflict
                      ? `Sources disagree: ${m.codebaseRaw.join(', ')}`
                      : m.codebaseRaw.join(', ')}>
                {m.codebase}
              </span>
            )}
            {displayPlayers(m) !== null && (
              <span className="dir-players" title={playersTitle(m)}>
                {displayPlayers(m)}
              </span>
            )}
            {m.protocols.some((p) => MAPPER_PROTOCOLS.includes(p)) && (
              <span className="dir-badge" title="Mapper tracks rooms exactly here">map</span>
            )}
            <span className="dir-addr">
              {m.host}:{m.port}
            </span>
          </div>
        ))}
        {matches.length === 0 && (
          <p className="dir-status">
            Nothing matches. {liveOnly && 'Try turning off “Online only” — '}
            {activeFilters > 0 && 'clearing a filter may help.'}
          </p>
        )}
        {matches.length > limit && (
          <button className="dir-more" onClick={() => setLimit((l) => l + 120)}>
            Show more ({matches.length - limit} remaining)
          </button>
        )}
      </div>
    </>
  )
}
