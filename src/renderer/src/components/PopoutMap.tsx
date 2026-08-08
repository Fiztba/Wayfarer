/**
 * PopoutMap — the standalone map window. Renders the same MapCanvas from a
 * state mirror pushed over IPC by the session renderer. View/walk/"I am here"
 * live here; full editing lives in the docked pane.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { MapCanvas, type MapContextInfo } from './MapCanvas'
import { ClampedMenu } from './ClampedMenu'
import type { MudMap } from '../map/types'

interface MirrorState {
  map: MudMap
  activeZoneId: string
  currentRoomId: string | null
  lost: boolean
  mode: string
  name: string
}

export function PopoutMap({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<MirrorState | null>(null)
  const [viewZoneId, setViewZoneId] = useState<string | null>(null)
  const [viewZ, setViewZ] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [centerToken, setCenterToken] = useState(0)
  const [menu, setMenu] = useState<MapContextInfo | null>(null)

  useEffect(() => {
    const off = window.mud.map.onState((id, s) => {
      if (id === sessionId) setState(s as MirrorState)
    })
    window.mud.map.hello(sessionId)
    // Re-request periodically in case the session was mid-load at hello time.
    const retry = setInterval(() => window.mud.map.hello(sessionId), 3000)
    return () => {
      off()
      clearInterval(retry)
    }
  }, [sessionId])

  const currentRoom = state?.currentRoomId ? state.map.rooms[state.currentRoomId] : null

  useEffect(() => {
    if (currentRoom) {
      setViewZoneId(null)
      setViewZ(null)
      setCenterToken((t) => t + 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoom?.id])

  const sendAction = useCallback(
    (action: Record<string, unknown>) => window.mud.map.sendAction(sessionId, action),
    [sessionId]
  )

  if (!state) {
    return <div className="popout-loading">Waiting for map data…</div>
  }

  const zoneId = viewZoneId ?? currentRoom?.zoneId ?? state.activeZoneId
  const z = viewZ ?? currentRoom?.z ?? 0
  const zone = state.map.zones.find((zn) => zn.id === zoneId)

  return (
    <div className="popout-map" onClick={() => setMenu(null)}>
      <div className="map-toolbar">
        <span className="popout-title">{state.name}</span>
        <select
          className="map-select map-zone-select"
          value={zoneId}
          onChange={(e) => setViewZoneId(e.target.value)}
        >
          {state.map.zones.map((zn) => (
            <option key={zn.id} value={zn.id}>
              {zn.name}
            </option>
          ))}
        </select>
        <span className="map-level">
          <button className="map-btn" onClick={() => setViewZ(z - 1)}>
            −
          </button>
          <span>L{z}</span>
          <button className="map-btn" onClick={() => setViewZ(z + 1)}>
            +
          </button>
        </span>
        <button
          className="map-btn"
          title="Center on your position"
          onClick={() => {
            setViewZoneId(null)
            setViewZ(null)
            setCenterToken((t) => t + 1)
          }}
        >
          ⌖
        </button>
      </div>
      {state.lost && <div className="map-lost">Position unknown — right-click your room → “I am here”.</div>}
      <div className="map-canvas-wrap">
        <MapCanvas
          map={state.map}
          zoneId={zoneId}
          z={z}
          currentRoomId={state.currentRoomId}
          selectedRoomId={selectedId}
          centerToken={centerToken}
          onSelectRoom={setSelectedId}
          onWalkRoom={(id) => sendAction({ type: 'walkTo', roomId: id })}
          onContextMenu={(info) => setMenu(info)}
        />
        {menu && menu.roomId && (
          <ClampedMenu
            x={menu.clientX}
            y={menu.clientY}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="map-menu-title">{state.map.rooms[menu.roomId]?.name}</div>
            <button
              onClick={() => {
                sendAction({ type: 'setCurrent', roomId: menu.roomId })
                setMenu(null)
              }}
            >
              ⌖ I am here
            </button>
            <button
              onClick={() => {
                sendAction({ type: 'walkTo', roomId: menu.roomId })
                setMenu(null)
              }}
            >
              🚶 Walk here
            </button>
            <button
              onClick={() => {
                sendAction({ type: 'walkTo', roomId: menu.roomId, fast: true })
                setMenu(null)
              }}
            >
              ⚡ Walk here (fast)
            </button>
            <p className="field-hint" style={{ padding: '4px 10px' }}>
              Editing lives in the docked map pane.
            </p>
          </ClampedMenu>
        )}
      </div>
      <div className="popout-footer">
        {zone?.name ?? '?'} · level {z} ·{' '}
        {Object.values(state.map.rooms).filter((r) => r.zoneId === zoneId).length} rooms
      </div>
    </div>
  )
}
