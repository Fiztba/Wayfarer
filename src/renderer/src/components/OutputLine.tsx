/** Shared line renderer for the main output and capture windows. */
import React from 'react'
import type { Line } from '../SessionStore'
import type { MxpLink, Span, SpanStyle } from '../ansi'

export type LinkHandler = (link: MxpLink) => void

export function formatTime(at: number): string {
  const t = new Date(at)
  const hh = String(t.getHours()).padStart(2, '0')
  const mm = String(t.getMinutes()).padStart(2, '0')
  const ss = String(t.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss} `
}

function spanCss(style: SpanStyle): React.CSSProperties {
  const css: React.CSSProperties = {}
  if (style.color) css.color = style.color
  if (style.background) css.backgroundColor = style.background
  if (style.bold) css.fontWeight = 700
  if (style.dim) css.opacity = 0.6
  if (style.italic) css.fontStyle = 'italic'
  const deco = [style.underline && 'underline', style.strike && 'line-through'].filter(Boolean)
  if (deco.length) css.textDecoration = deco.join(' ')
  return css
}

/** Wrap occurrences of `query` (case-insensitive) in <mark> elements. */
function highlightParts(text: string, query: string, current: boolean): React.ReactNode {
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  if (!lower.includes(q)) return text
  const parts: React.ReactNode[] = []
  let i = 0
  let idx: number
  let key = 0
  while ((idx = lower.indexOf(q, i)) !== -1) {
    if (idx > i) parts.push(text.slice(i, idx))
    parts.push(
      <mark key={key++} className={current ? 'search-mark search-mark-current' : 'search-mark'}>
        {text.slice(idx, idx + q.length)}
      </mark>
    )
    i = idx + q.length
  }
  if (i < text.length) parts.push(text.slice(i))
  return parts
}

export const OutputSpan = React.memo(function OutputSpan({
  span,
  highlight,
  highlightCurrent,
  onLink
}: {
  span: Span
  highlight?: string
  highlightCurrent?: boolean
  onLink?: LinkHandler
}) {
  const content = highlight
    ? highlightParts(span.text, highlight, highlightCurrent ?? false)
    : span.text
  if (span.link) {
    const link = span.link
    return (
      <span
        style={spanCss(span.style)}
        className="mxp-link"
        title={link.hint ?? link.url ?? link.command}
        onClick={() => onLink?.(link)}
      >
        {content}
      </span>
    )
  }
  return <span style={spanCss(span.style)}>{content}</span>
})

export const OutputLine = React.memo(function OutputLine({
  line,
  showTime,
  searchQuery,
  searchCurrent,
  onLink
}: {
  line: Line
  showTime: boolean
  searchQuery?: string
  searchCurrent?: boolean
  onLink?: LinkHandler
}) {
  return (
    <div className={`line line-${line.kind}`} data-lid={line.id}>
      {showTime && <span className="line-time">{formatTime(line.at)}</span>}
      {line.spans.length === 0 ? ' ' : line.spans.map((s, i) => (
            <OutputSpan
              key={i}
              span={s}
              highlight={searchQuery}
              highlightCurrent={searchCurrent}
              onLink={onLink}
            />
          ))}
    </div>
  )
})
