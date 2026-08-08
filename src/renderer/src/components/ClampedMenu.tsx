/**
 * ClampedMenu — a fixed-position popup that measures itself and stays inside
 * the window: flips to the left of the cursor when it would overflow the right
 * edge, and shifts up when it would overflow the bottom.
 */
import React, { useLayoutEffect, useRef, useState } from 'react'

const MARGIN = 8

export function ClampedMenu({
  x,
  y,
  className = 'map-menu',
  onClick,
  children
}: {
  x: number
  y: number
  className?: string
  onClick?(e: React.MouseEvent): void
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let left = x
    let top = y
    if (left + rect.width > window.innerWidth - MARGIN) {
      left = Math.max(MARGIN, x - rect.width)
    }
    if (top + rect.height > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN)
    }
    setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }))
  }, [x, y, children])

  return (
    <div
      ref={ref}
      className={className}
      style={{
        position: 'fixed',
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        visibility: pos ? 'visible' : 'hidden'
      }}
      onClick={onClick}
    >
      {children}
    </div>
  )
}
