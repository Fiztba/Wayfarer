import React from 'react'
import type { DirectoryMud } from '../../../shared/types'

/**
 * Everything known about one MUD.
 *
 * The sweep records 34 fields per world and the list can show about six of
 * them. Website is known for 369 live MUDs, rank for 394, the source list for
 * all of them, categories for 286 — none of which had anywhere to go. This is
 * where the rest lands, so a row can be inspected before it is connected to.
 *
 * Everything is conditional: coverage varies enormously between fields, and a
 * pane full of "unknown" rows would be worse than a short one.
 */

interface Props {
  mud: DirectoryMud | null
  /** `secure` fills the encrypted port rather than the plain one. */
  onConnect(mud: DirectoryMud, secure?: boolean): void
}

const SOURCE_NAMES: Record<string, string> = {
  tmc: 'The Mud Connector',
  tms: 'Top Mud Sites',
  mssp: 'MSSP crawler',
  vineyard: 'Vineyard',
  grapevine: 'Grapevine',
  mudverse: 'MUDVerse'
}

const WORLD_SIZE = (rooms: number): string =>
  rooms >= 20000 ? 'gigantic' : rooms >= 10000 ? 'huge' : rooms >= 6000 ? 'large' : rooms >= 3000 ? 'medium' : 'small'

/**
 * MSSP's convention is that 0 means "roomless" and -1 means "cannot say", but
 * in practice a MUD that never filled the field in sends 0. Reporting that as
 * "0 rooms (small)" states a fact we do not have, so zero reads as unreported
 * — an honest blank is better than a confident wrong number.
 */
const reported = (n: number | null): n is number => n !== null && n > 0

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="dd-row">
      <span className="dd-label">{label}</span>
      <span className="dd-value">{children}</span>
    </div>
  )
}

export function DirectoryDetail({ mud, onConnect }: Props): React.JSX.Element {
  if (!mud) {
    return (
      <aside className="dir-detail dir-detail-empty">
        <p>Select a world to see what is known about it.</p>
      </aside>
    )
  }

  const m = mud
  const themes = [...new Set([...(m.genre ? [m.genre] : []), ...m.categories])]
  const lastSeen = m.lastSeenUp ? new Date(m.lastSeenUp + 'T00:00:00') : null

  return (
    <aside className="dir-detail">
      <div className="dd-head">
        <h3>{m.name}</h3>
        <div className={`dd-status dd-status-${m.liveness}`}>
          {m.liveness === 'live'
            ? m.players !== null
              ? `Online · ${m.players} playing`
              : 'Online'
            : m.state === 'nodns'
              ? 'Address no longer resolves'
              : 'Not answering'}
        </div>
      </div>

      <div className="dd-addr">
        {m.host}:{m.port}
      </div>

      {m.tagline && <p className="dd-tagline">{m.tagline}</p>}

      <div className="dd-actions">
        <button className="dd-connect" onClick={() => onConnect(m)}>
          Use this world
        </button>
        {/* A separate action, because TLS is a different port: offering it as a
            checkbox on the plain address would just fail to connect. */}
        {m.tlsPort !== null && (
          <button
            className="dd-connect dd-connect-tls"
            title={`Encrypted connection on port ${m.tlsPort}`}
            onClick={() => onConnect(m, true)}
          >
            Use over TLS · {m.tlsPort}
          </button>
        )}
      </div>

      <div className="dd-rows">
        {m.codebase && (
          <Row label="Codebase">
            {m.ancestry.length > 1 ? m.ancestry.join(' ← ') : m.codebase}
            {m.codebaseConflict && (
              <span className="dd-warn" title={`Sources disagree: ${m.codebaseRaw.join(', ')}`}>
                {' '}
                sources disagree
              </span>
            )}
          </Row>
        )}

        <Row label="Encrypted">
          {m.tlsPort !== null ? (
            <>
              yes, on port <strong>{m.tlsPort}</strong>
              {m.tlsPort !== m.port && <span className="dd-unknown"> (plain is {m.port})</span>}
            </>
          ) : m.tlsOffered ? (
            <>offered, but the port was not stated</>
          ) : (
            <span className="dd-unknown">not offered</span>
          )}
        </Row>

        {m.protocols.length > 0 && (
          <Row label="Protocols">
            <span className="dd-chips">
              {m.protocols.map((p) => (
                <span
                  key={p}
                  className={`dd-chip${p === 'GMCP' || p === 'MSDP' ? ' dd-chip-good' : ''}`}
                  title={p === 'GMCP' || p === 'MSDP' ? 'The mapper tracks rooms exactly here' : undefined}
                >
                  {p}
                </span>
              ))}
            </span>
          </Row>
        )}

        {themes.length > 0 && <Row label="Theme">{themes.join(', ')}</Row>}
        {m.gameplay && <Row label="Gameplay">{m.gameplay}</Row>}
        {m.created !== null && <Row label="Founded">{m.created}</Row>}

        <Row label="World">
          {reported(m.rooms) ? (
            <>
              {m.rooms.toLocaleString()} rooms ({WORLD_SIZE(m.rooms)})
              {reported(m.areas) && ` · ${m.areas} areas`}
            </>
          ) : (
            <span className="dd-unknown">unreported</span>
          )}
        </Row>

        {reported(m.activePlayers) && (
          <Row label="Typically">about {Math.round(m.activePlayers)} online</Row>
        )}

        {(m.language || m.location) && (
          <Row label="Server">{[m.language, m.location].filter(Boolean).join(' · ')}</Row>
        )}

        {(m.hiringBuilders || m.hiringCoders) && (
          <Row label="Hiring">
            {[m.hiringBuilders && 'builders', m.hiringCoders && 'coders'].filter(Boolean).join(' and ')}
          </Row>
        )}

        {m.payToPlay && <Row label="Cost">Pay to play</Row>}
        {m.rank !== null && <Row label="TMC rank">#{m.rank}</Row>}

        {(m.website || m.discord) && (
          <Row label="Links">
            {m.website && (
              <a href={m.website} target="_blank" rel="noreferrer">
                website
              </a>
            )}
            {m.website && m.discord && ' · '}
            {m.discord && (
              <a href={m.discord} target="_blank" rel="noreferrer">
                discord
              </a>
            )}
          </Row>
        )}

        <Row label="Listed on">
          {m.sources.map((s) => SOURCE_NAMES[s] ?? s).join(', ')}
        </Row>

        {lastSeen && m.liveness !== 'live' && (
          <Row label="Last seen">{lastSeen.toLocaleDateString()}</Row>
        )}

        {/* Rival addresses the merge resolved. Worth showing: it explains why
            this MUD's address may differ from the one a directory lists. */}
        {m.alternates.length > 0 && (
          <Row label="Also listed as">
            <span className="dd-alts">
              {m.alternates.map((a) => (
                <span key={`${a.host}:${a.port}`} className="dd-alt">
                  {a.host}:{a.port}
                  <span className="dd-alt-state">
                    {a.state === 'up' ? 'also up' : a.state === 'nodns' ? 'gone' : 'no answer'}
                  </span>
                </span>
              ))}
            </span>
          </Row>
        )}
      </div>
    </aside>
  )
}
