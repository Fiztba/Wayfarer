import React, { useMemo } from 'react'
import type { MapModel } from '../map/MapModel'
import { findPath } from '../map/Pathfinder'

export function RoutePreview({ model, from, destination, lost, fast, onWalk, onClose, onLocate }: {
  model: MapModel; from: string | null; destination: string; lost: boolean; fast: boolean
  onWalk(): void; onClose(): void; onLocate(id: string): void
}) {
  const version = model.getVersion()
  const route = useMemo(() => from && !lost ? findPath(model, from, destination) : null, [model, version, from, lost, destination])
  return <section className="route-preview" aria-label="Route preview">
    <div className="tool-heading"><strong>Route to {model.room(destination)?.name ?? 'missing room'}</strong>
      <button onClick={onClose} aria-label="Close route preview">✕</button></div>
    {!from || lost ? <p>Set your position before walking.</p> : route === null ?
      <p>No route with the current avoidance settings.</p> : <>
        <p>{route.length} {route.length === 1 ? 'move' : 'moves'} · cost {route.reduce((sum, step) => sum + (step.cost ?? 1), 0)} · {fast ? 'Fast movement' : 'Wait for each confirmed arrival'}</p>
        <button disabled={route.length === 0} onClick={onWalk}>Start {fast ? 'fast ' : ''}walk</button>
        <ol className="route-steps">{route.map((step, i) => <li key={i}>
          <code>{step.openCommand ? `${step.openCommand} → ` : ''}{step.command}</code>{' → '}
          <button onClick={() => step.toRoomId && onLocate(step.toRoomId)}>{model.room(step.toRoomId)?.name}</button>
          {step.fromRoomId && <button title="Exclude this exit and recalculate" onClick={() =>
            model.setExitAt(step.fromRoomId!, step.exitIndex!, { avoid: true })}>Avoid exit</button>}
        </li>)}</ol>
      </>}
    <p className="field-hint">Room and exit costs are saved with the map. Edit them using Routing or Exits &amp; doors.</p>
  </section>
}
