import React from 'react'
import type { MapRoom, MudMap } from '../map/types'
import { exitCommandLabel, type ExitFocus } from '../map/displayLinks'

/** Inspect a connection without issuing any movement commands. */
export function MapExitInspector({ map, room, focus, onFocus, onLocate }: {
  map: MudMap
  room: MapRoom
  focus: ExitFocus | null
  onFocus(value: ExitFocus | null): void
  onLocate(roomId: string): void
}) {
  return (
    <section className="map-exit-inspector" aria-label="Room exits">
      <div className="map-exit-heading"><strong>{room.name}</strong><span>{room.exits.length} exits</span></div>
      <div className="map-exit-list">
        {room.exits.map((exit, index) => {
          const dest = exit.to ? map.rooms[exit.to] : null
          const returns = dest?.exits.filter((back) => back.to === room.id) ?? []
          const location = dest && (dest.zoneId !== room.zoneId || dest.z !== room.z)
            ? `${map.zones.find((zone) => zone.id === dest.zoneId)?.name ?? 'Other zone'} · L${dest.z}` : ''
          const detail = [exit.door ? `Door${exit.doorName ? `: ${exit.doorName}` : ''}` : '', location,
            dest ? dest.id === room.id ? 'Returns to this room' : returns.length ? `Back: ${returns.map(exitCommandLabel).join(', ')}` : 'No mapped return' : 'Unexplored']
            .filter(Boolean).join(' · ')
          const active = focus?.roomId === room.id && focus.exitIndex === index
          return (
            <div className={`map-exit-row${active ? ' map-exit-active' : ''}`} key={index}>
              <button className="map-exit-trace" aria-pressed={active}
                title={`Trace ${exitCommandLabel(exit)} to ${dest?.name ?? exit.destName ?? 'an unexplored room'}`}
                onClick={() => onFocus(active ? null : { roomId: room.id, exitIndex: index })}>
                <span className="map-exit-command">{exitCommandLabel(exit)}</span>
                <span className="map-exit-target"><span>{dest?.name ?? exit.destName ?? 'Unexplored'}</span><small>{detail}</small></span>
              </button>
              {dest && <button className="map-exit-locate" title={`Show ${dest.name} on the map (does not walk)`}
                aria-label={`Locate ${dest.name}`} onClick={() => onLocate(dest.id)}>⌖</button>}
            </div>
          )
        })}
        {room.exits.length === 0 && <p className="map-exit-empty">No exits recorded here yet.</p>}
      </div>
      <div className="map-exit-legend">Click an exit to trace it · ⌖ locates without walking<br />Line arrow: no mapped return yet (not necessarily one-way)<br />Room arrow: exit direction differs from the drawing<br />Dashed stub: destination unmapped · Double slash: one exit drawn long</div>
    </section>
  )
}
