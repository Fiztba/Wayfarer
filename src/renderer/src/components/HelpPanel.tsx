import React, { useMemo, useState } from 'react'
import { HELP_TOPICS, type HelpTopic } from '../help'

function topicText(topic: HelpTopic): string {
  return (
    topic.title +
    ' ' +
    topic.blocks
      .map((b) => [b.h, b.p, b.code, ...(b.list ?? [])].filter(Boolean).join(' '))
      .join(' ')
  ).toLowerCase()
}

export function HelpPanel({ onClose }: { onClose(): void }) {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState(HELP_TOPICS[0].id)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return HELP_TOPICS
    return HELP_TOPICS.filter((t) => topicText(t).includes(q))
  }, [query])

  const active = matches.find((t) => t.id === activeId) ?? matches[0]

  return (
    <div className="panel-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">Help</span>
          <span className="help-hint-header">tip: type #help in any session</span>
          <button className="panel-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="panel-body">
          <div className="help-sidebar">
            <input
              className="help-search"
              placeholder="Search help…"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
            {matches.length === 0 && <p className="empty-hint">No topics match.</p>}
            {matches.map((t) => (
              <button
                key={t.id}
                className={`help-topic ${active?.id === t.id ? 'help-topic-active' : ''}`}
                onClick={() => setActiveId(t.id)}
              >
                {t.title}
              </button>
            ))}
          </div>
          <div className="help-content">
            {active && (
              <>
                <h2 className="help-title">{active.title}</h2>
                {active.blocks.map((b, i) => (
                  <React.Fragment key={i}>
                    {b.h && <h3 className="help-heading">{b.h}</h3>}
                    {b.p && <p className="help-p">{b.p}</p>}
                    {b.code && <pre className="help-code">{b.code}</pre>}
                    {b.list && (
                      <ul className="help-list">
                        {b.list.map((item, j) => (
                          <li key={j}>{item}</li>
                        ))}
                      </ul>
                    )}
                  </React.Fragment>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
