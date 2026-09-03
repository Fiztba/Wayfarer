/**
 * GaugeBar — HP/mana/move style bars across the top of a session, driven by
 * variables (@hp, @maxhp, ...). Variables come from GMCP/MSDP automatically
 * on servers that send vitals, or from a prompt trigger (#var hp %1) anywhere.
 */
import React from 'react'
import type { SessionStore } from '../SessionStore'
import { settingsManager } from '../SettingsManager'
import { forCharacter } from '../automation/scope.ts'

export function GaugeBar({ store }: { store: SessionStore }) {
  const vars = store.engine.variables
  const gauges = settingsManager
    .getSets(store.profileId)
    .flatMap((s) => s.gauges.filter((g) => forCharacter(g.character, store.charName)))
    .filter((g) => g.enabled)

  if (gauges.length === 0) return null

  return (
    <div className="gauge-bar">
      {gauges.map((gauge) => {
        const value = Number(vars[gauge.valueVar])
        const max = gauge.maxVar ? Number(vars[gauge.maxVar]) : NaN
        const hasValue = Number.isFinite(value)
        const hasMax = Number.isFinite(max) && max > 0
        const pct = hasValue && hasMax ? Math.max(0, Math.min(100, (value / max) * 100)) : null
        return (
          <div key={gauge.id} className="gauge" title={`@${gauge.valueVar}${gauge.maxVar ? ` / @${gauge.maxVar}` : ''}`}>
            <span className="gauge-label">{gauge.label}</span>
            {pct !== null ? (
              <span className="gauge-track">
                <span
                  className="gauge-fill"
                  style={{ width: `${pct}%`, background: gauge.color || '#61afef' }}
                />
                <span className="gauge-text">
                  {value}/{max}
                </span>
              </span>
            ) : (
              <span className="gauge-value" style={{ color: gauge.color || '#61afef' }}>
                {hasValue ? value : '—'}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
