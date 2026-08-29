/**
 * PopoutMap — the standalone map window. Hosts the SAME full-featured MapPane
 * as the docked pane, backed by RemoteMapModel/RemoteTracker: reads come from
 * the session's mirror pushes, edits apply optimistically here and relay to
 * the owning session over IPC.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { MapPane } from './MapPane'
import { RemoteMapModel, RemoteTracker, type MapAction } from '../map/RemoteMap'
import type { TrackerMode } from '../map/MapTracker'
import type { MudMap } from '../map/types'

interface MirrorState {
  map: MudMap
  activeZoneId: string
  currentRoomId: string | null
  lost: boolean
  speculative?: boolean
  mode: TrackerMode
  name: string
}

export function PopoutMap({ sessionId }: { sessionId: string }) {
  const modelRef = useRef<RemoteMapModel | null>(null)
  const trackerRef = useRef<RemoteTracker | null>(null)
  const [, bump] = useState(0)
  const [name, setName] = useState('Map')

  const send = useCallback(
    (action: MapAction) => window.mud.map.sendAction(sessionId, action),
    [sessionId]
  )

  useEffect(() => {
    const off = window.mud.map.onState((id, raw) => {
      if (id !== sessionId) return
      const state = raw as MirrorState
      if (!modelRef.current) {
        modelRef.current = new RemoteMapModel(state.map, send)
        trackerRef.current = new RemoteTracker(modelRef.current, send)
      } else {
        modelRef.current.absorb(state.map, state.activeZoneId)
      }
      trackerRef.current!.update(state)
      setName(state.name)
      bump((n) => n + 1)
    })
    window.mud.map.hello(sessionId)
    // Re-request until the first push lands (the session may be mid-load).
    const retry = setInterval(() => {
      if (!modelRef.current) window.mud.map.hello(sessionId)
    }, 2000)
    return () => {
      off()
      clearInterval(retry)
    }
  }, [sessionId, send])

  useEffect(() => {
    document.title = `Map — ${name}`
  }, [name])

  if (!modelRef.current || !trackerRef.current) {
    return <div className="popout-loading">Waiting for map data…</div>
  }

  return (
    <div className="popout-map">
      <MapPane
        model={modelRef.current}
        tracker={trackerRef.current}
        walkTo={(roomId, fast) => send({ type: 'walkTo', roomId, fast })}
      />
    </div>
  )
}
