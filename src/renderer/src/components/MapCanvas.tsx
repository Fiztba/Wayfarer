/**
 * MapCanvas — pure canvas renderer + interactions for one zone/level of a map.
 * Driven entirely by props so the docked pane (live model) and the pop-out
 * window (IPC mirror) can share it.
 */
import React, { useCallback, useEffect, useRef } from 'react'
import type { MapExit, MapRoom, MudMap } from '../map/types'
import {
  BEARING_AT,
  CELL,
  DIR_UNIT,
  ROOM,
  cubicPoint,
  cubicTangent,
  drawnAsClaimed,
  linkPath
} from '../map/geometry'

export interface MapContextInfo {
  roomId: string | null
  clientX: number
  clientY: number
  worldX: number
  worldY: number
}

interface Props {
  map: MudMap
  zoneId: string
  z: number
  currentRoomId: string | null
  /** The position is a guess the mapper has not settled yet. */
  currentIsGuess?: boolean
  selectedRoomId: string | null
  /** Additional multi-selection (shift-click / shift-drag marquee). */
  selectedRoomIds?: string[]
  onSelectRoom(id: string | null): void
  /** Shift-click: toggle a room in/out of the multi-selection. */
  onToggleSelect?(id: string): void
  /** Shift-drag marquee finished: rooms inside the box. */
  onMarqueeSelect?(ids: string[]): void
  onWalkRoom(id: string): void
  onContextMenu(info: MapContextInfo): void
  onMoveRoom?(id: string, x: number, y: number): void
  /** Incremented externally to request centering. */
  centerToken: number
  /** Room to center on when centerToken changes; falls back to current room. */
  centerRoomId?: string | null
}

interface View {
  panX: number
  panY: number
  scale: number
}

export function MapCanvas(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<View>({ panX: 0, panY: 0, scale: 1 })
  const dragRef = useRef<{
    mode: 'pan' | 'room' | 'marquee'
    startX: number
    startY: number
    origPanX: number
    origPanY: number
    roomId?: string
    moved: boolean
    ghostX?: number
    ghostY?: number
    curX?: number
    curY?: number
  } | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { map, zoneId, z, currentRoomId, currentIsGuess, selectedRoomId, selectedRoomIds } =
      propsRef.current
    const multiSelected = new Set(selectedRoomIds ?? [])
    const view = viewRef.current
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const cell = CELL * view.scale
    const half = (ROOM * view.scale) / 2
    const toScreen = (rx: number, ry: number): [number, number] => [
      w / 2 + view.panX + rx * cell,
      h / 2 + view.panY + ry * cell
    ]

    const waypointIds = new Set(map.waypoints.map((wp) => wp.roomId))
    const rooms = Object.values(map.rooms).filter((r) => r.zoneId === zoneId && r.z === z)
    const visibleById = new Map(rooms.map((r) => [r.id, r]))
    const drag = dragRef.current

    const roomPos = (r: MapRoom): [number, number] => {
      if (drag?.mode === 'room' && drag.roomId === r.id && drag.moved) {
        return [drag.ghostX ?? r.x, drag.ghostY ?? r.y]
      }
      return [r.x, r.y]
    }

    // ---- exits ----
    // Which cells are actually drawn, so a link that would cross a room can be
    // bowed around it rather than tunnelling under an opaque box (geometry.ts).
    const occupied = new Set<string>()
    for (const r of rooms) {
      const [rx, ry] = roomPos(r)
      occupied.add(`${rx},${ry}`)
    }
    const isOccupied = (x: number, y: number): boolean => occupied.has(`${x},${y}`)
    const thin = Math.max(1, 1.4 * view.scale)

    /** Draw one exit, as owned by `room`. */
    const drawLink = (room: MapRoom, exit: MapExit, highlight: boolean): void => {
      if (exit.dir === 'u' || exit.dir === 'd') return // drawn as glyphs
      const [rx, ry] = roomPos(room)
      const [sx, sy] = toScreen(rx, ry)
      const dest = exit.to ? map.rooms[exit.to] : null
      let ex: number
      let ey: number
      let stub = false
      let door = exit.door
      let curve: { c1: [number, number]; c2: [number, number]; span: number } | null = null
      let destCell: { x: number; y: number } | null = null
      if (dest && visibleById.has(dest.id)) {
        const [dx, dy] = roomPos(dest)
        destCell = { x: dx, y: dy }
        ;[ex, ey] = toScreen(dx, dy)
        const path = linkPath({ x: rx, y: ry }, { x: dx, y: dy }, exit.dir ?? '', isOccupied)
        curve = {
          c1: toScreen(path.c1.x, path.c1.y),
          c2: toScreen(path.c2.x, path.c2.y),
          span: path.span
        }
        // This face may be the only one carrying the door if the pair was
        // linked one-way, and it is the only face drawn (see dedupe below).
        if (dest.exits.find((e) => e.to === room.id)?.door) door = true
      } else if (exit.dir) {
        const d = DIR_UNIT[exit.dir] ?? [0, 0]
        ex = sx + d[0] * cell * 0.55
        ey = sy + d[1] * cell * 0.55
        stub = true
      } else {
        return // special exit to elsewhere: glyph only
      }

      // Sample the drawn path (straight or cubic) — used for the door tick and
      // the direct-connection chevrons, so both ride the curve rather than the
      // chord they may no longer follow.
      const P0 = { x: sx, y: sy }
      const P3 = { x: ex, y: ey }
      const C1 = curve ? { x: curve.c1[0], y: curve.c1[1] } : P0
      const C2 = curve ? { x: curve.c2[0], y: curve.c2[1] } : P3
      const at = (t: number) =>
        curve ? cubicPoint(P0, C1, C2, P3, t) : { x: sx + (ex - sx) * t, y: sy + (ey - sy) * t }
      const dirAt = (t: number) =>
        curve ? cubicTangent(P0, C1, C2, P3, t) : { x: ex - sx, y: ey - sy }

      const base = highlight
        ? '#ffffff'
        : stub
          ? dest
            ? '#8b6f47' // leads off-view (other zone/level)
            : '#4a5568' // unexplored stub
          : '#5c6370'
      ctx.strokeStyle = base
      ctx.lineWidth = highlight ? Math.max(2, 2.4 * view.scale) : thin
      ctx.setLineDash(exit.to === null ? [3, 3] : [])
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      if (curve) ctx.bezierCurveTo(curve.c1[0], curve.c1[1], curve.c2[0], curve.c2[1], ex, ey)
      else ctx.lineTo(ex, ey)
      ctx.stroke()
      ctx.setLineDash([])

      // Bearing arrows. Where a link is NOT drawn along the compass direction it
      // claims -- greedy placement put the room somewhere else, and often no
      // coordinate assignment could have done better -- the line itself cannot
      // carry that direction, so a small arrow just outside each room points
      // the way its own exit really goes. Only the liars get marked: on a real
      // 859-room map that was 44 links of 1870.
      if (curve && dest && destCell && exit.dir) {
        const here = { x: rx, y: ry }
        const back = dest.exits.find((e) => e.to === room.id)
        const marks: Array<[number, number, string]> = []
        if (!drawnAsClaimed(here, destCell, exit.dir)) marks.push([sx, sy, exit.dir])
        if (back?.dir && !drawnAsClaimed(destCell, here, back.dir)) {
          marks.push([ex, ey, back.dir])
        }
        if (marks.length > 0) {
          ctx.strokeStyle = highlight ? '#ffffff' : '#8b949e'
          ctx.lineWidth = Math.max(1, 1.3 * view.scale)
          for (const [cx, cy, d] of marks) {
            const u = DIR_UNIT[d]
            if (!u) continue
            const tipX = cx + u[0] * BEARING_AT * cell
            const tipY = cy + u[1] * BEARING_AT * cell
            const a = Math.atan2(u[1], u[0])
            const len = 5 * view.scale
            ctx.beginPath()
            ctx.moveTo(tipX - Math.cos(a - 0.5) * len, tipY - Math.sin(a - 0.5) * len)
            ctx.lineTo(tipX, tipY)
            ctx.lineTo(tipX - Math.cos(a + 0.5) * len, tipY - Math.sin(a + 0.5) * len)
            ctx.stroke()
          }
          ctx.strokeStyle = base
        }
      }

      if (curve && curve.span > 1) {
        // Direct-connection chevrons. A link drawn longer than one grid step is
        // still a single passage, but the map's own grammar reads empty space
        // as unmapped ground, so the length has to be marked as layout rather
        // than distance. Placed off-centre to leave the midpoint to the door.
        ctx.lineWidth = Math.max(1, 1.2 * view.scale)
        for (const t of [0.34, 0.66]) {
          const p = at(t)
          const g = dirAt(t)
          const a = Math.atan2(g.y, g.x)
          const len = 4 * view.scale
          ctx.beginPath()
          ctx.moveTo(p.x - Math.cos(a - 0.6) * len, p.y - Math.sin(a - 0.6) * len)
          ctx.lineTo(p.x, p.y)
          ctx.lineTo(p.x - Math.cos(a + 0.6) * len, p.y - Math.sin(a + 0.6) * len)
          ctx.stroke()
        }
      }

      if (door) {
        // Door tick: short bar across the path at its midpoint, perpendicular
        // to the direction the path is actually travelling there.
        const mid = at(0.5)
        const g = dirAt(0.5)
        const angle = Math.atan2(g.y, g.x) + Math.PI / 2
        const t = 5 * view.scale
        ctx.strokeStyle = '#e5c07b'
        ctx.lineWidth = Math.max(1.5, 2 * view.scale)
        ctx.beginPath()
        ctx.moveTo(mid.x - Math.cos(angle) * t, mid.y - Math.sin(angle) * t)
        ctx.lineTo(mid.x + Math.cos(angle) * t, mid.y + Math.sin(angle) * t)
        ctx.stroke()
      }
    }

    for (const room of rooms) {
      for (const exit of room.exits) {
        // A two-way link is drawn once, by the lower room id. Drawing both
        // faces was invisible while links were straight (they coincided);
        // bowed, they would arc to opposite sides and render as a lens.
        const dest = exit.to ? map.rooms[exit.to] : null
        if (dest && visibleById.has(dest.id) && room.id > dest.id) {
          if (dest.exits.some((e) => e.to === room.id)) continue
        }
        drawLink(room, exit, false)
      }
    }

    // ---- rooms ----
    for (const room of rooms) {
      const [rx, ry] = roomPos(room)
      const [sx, sy] = toScreen(rx, ry)
      if (sx < -cell || sy < -cell || sx > w + cell || sy > h + cell) continue

      const isSelected = room.id === selectedRoomId || multiSelected.has(room.id)
      ctx.fillStyle = room.color || '#1c2128'
      ctx.strokeStyle = isSelected ? '#ffffff' : '#8b949e'
      ctx.lineWidth = isSelected ? 2 : 1
      ctx.beginPath()
      ctx.roundRect(sx - half, sy - half, half * 2, half * 2, 4 * view.scale)
      ctx.fill()
      ctx.stroke()

      if (room.id === currentRoomId) {
        // A dashed ring means the mapper is holding a guess rather than a
        // settled position -- it may quietly move once the next room or two
        // rule the alternatives out. Without this, self-correction reads as
        // the map rewriting itself behind you.
        ctx.strokeStyle = currentIsGuess ? '#c8a04a' : '#61afef'
        ctx.lineWidth = 2.5
        if (currentIsGuess) ctx.setLineDash([4, 3])
        ctx.beginPath()
        ctx.roundRect(sx - half - 3, sy - half - 3, half * 2 + 6, half * 2 + 6, 6 * view.scale)
        ctx.stroke()
        ctx.setLineDash([])
      }

      // Up/down/special markers.
      const glyphSize = Math.max(7, 9 * view.scale)
      ctx.font = `${glyphSize}px sans-serif`
      ctx.textAlign = 'center'
      const hasUp = room.exits.some((e) => e.dir === 'u')
      const hasDown = room.exits.some((e) => e.dir === 'd')
      const hasSpecial = room.exits.some((e) => e.dir === null)
      ctx.fillStyle = '#c8ccd4'
      if (hasUp) ctx.fillText('▲', sx + half - 4 * view.scale, sy - half + glyphSize - 2)
      if (hasDown) ctx.fillText('▼', sx + half - 4 * view.scale, sy + half - 2)
      if (hasSpecial) {
        ctx.fillStyle = '#c678dd'
        ctx.fillText('◈', sx - half + 4 * view.scale, sy - half + glyphSize - 2)
      }
      if (waypointIds.has(room.id)) {
        ctx.fillStyle = '#ffd68a'
        ctx.fillText('★', sx, sy - half - 3)
      }
    }

    // ---- selected rooms' own exits, on top ----
    // Drawn after the boxes, and without the two-way dedupe, so that selecting
    // a room answers "is it really connected that way?" at a glance: only the
    // exits this room actually owns light up, however dense the region is.
    const highlighted = new Set(multiSelected)
    if (selectedRoomId) highlighted.add(selectedRoomId)
    if (highlighted.size > 0) {
      for (const room of rooms) {
        if (!highlighted.has(room.id)) continue
        for (const exit of room.exits) drawLink(room, exit, true)
      }
    }

    // ---- marquee rectangle ----
    const dragState = dragRef.current
    if (dragState?.mode === 'marquee' && dragState.moved) {
      const rect = canvas.getBoundingClientRect()
      const x0 = dragState.startX - rect.left
      const y0 = dragState.startY - rect.top
      const x1 = (dragState.curX ?? dragState.startX) - rect.left
      const y1 = (dragState.curY ?? dragState.startY) - rect.top
      ctx.strokeStyle = '#61afef'
      ctx.fillStyle = 'rgba(97, 175, 239, 0.12)'
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
      ctx.setLineDash([])
    }

    // ---- room name of current/selected at bottom ----
    const label =
      (selectedRoomId && map.rooms[selectedRoomId]) ||
      (currentRoomId && map.rooms[currentRoomId]) ||
      null
    if (label) {
      ctx.font = '12px sans-serif'
      ctx.textAlign = 'left'
      ctx.fillStyle = '#8b949e'
      ctx.fillText(label.name, 8, h - 8)
    }
  }, [])

  // Redraw on any prop change.
  useEffect(() => {
    draw()
  })

  // Resize observer keeps the canvas crisp.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const obs = new ResizeObserver(() => draw())
    obs.observe(canvas)
    return () => obs.disconnect()
  }, [draw])

  // Follow the player: whenever the current room changes (including on first
  // mount), snap the view to it. Runs every render so a move can never slip
  // through; manual pan/zoom stays untouched while standing still.
  const lastRoomRef = useRef<string | null>(null)
  useEffect(() => {
    const { currentRoomId, map } = propsRef.current
    if (!currentRoomId || currentRoomId === lastRoomRef.current) return
    lastRoomRef.current = currentRoomId
    const target = map.rooms[currentRoomId]
    if (!target) return
    const view = viewRef.current
    view.panX = -target.x * CELL * view.scale
    view.panY = -target.y * CELL * view.scale
    draw()
  })

  // Center on request (a specific room, or wherever the player is).
  const lastCenter = useRef(-1)
  useEffect(() => {
    if (props.centerToken === lastCenter.current) return
    lastCenter.current = props.centerToken
    const targetId = props.centerRoomId ?? props.currentRoomId
    const target = targetId ? props.map.rooms[targetId] : null
    if (target) {
      const view = viewRef.current
      view.panX = -target.x * CELL * view.scale
      view.panY = -target.y * CELL * view.scale
      draw()
    }
  }, [props.centerToken, props.centerRoomId, props.currentRoomId, props.map, draw])

  const hitTest = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const view = viewRef.current
    const cell = CELL * view.scale
    const x = clientX - rect.left
    const y = clientY - rect.top
    const worldX = (x - rect.width / 2 - view.panX) / cell
    const worldY = (y - rect.height / 2 - view.panY) / cell
    const { map, zoneId, z } = propsRef.current
    const half = ROOM / 2 / CELL + 0.06
    let hit: MapRoom | null = null
    for (const room of Object.values(map.rooms)) {
      if (room.zoneId !== zoneId || room.z !== z) continue
      if (Math.abs(room.x - worldX) <= half && Math.abs(room.y - worldY) <= half) {
        hit = room
        break
      }
    }
    return { room: hit, worldX: Math.round(worldX), worldY: Math.round(worldY) }
  }, [])

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const { room } = hitTest(e.clientX, e.clientY)
      const view = viewRef.current
      if (e.shiftKey) {
        if (room) {
          propsRef.current.onToggleSelect?.(room.id)
        } else {
          dragRef.current = {
            mode: 'marquee',
            startX: e.clientX,
            startY: e.clientY,
            origPanX: view.panX,
            origPanY: view.panY,
            moved: false,
            curX: e.clientX,
            curY: e.clientY
          }
        }
        return
      }
      dragRef.current = {
        mode: room && propsRef.current.onMoveRoom ? 'room' : 'pan',
        startX: e.clientX,
        startY: e.clientY,
        origPanX: view.panX,
        origPanY: view.panY,
        roomId: room?.id,
        moved: false
      }
      if (room) propsRef.current.onSelectRoom(room.id)
    },
    [hitTest]
  )

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return
      drag.moved = true
      const view = viewRef.current
      if (drag.mode === 'pan') {
        view.panX = drag.origPanX + dx
        view.panY = drag.origPanY + dy
      } else if (drag.mode === 'marquee') {
        drag.curX = e.clientX
        drag.curY = e.clientY
      } else if (drag.roomId) {
        const { worldX, worldY } = hitTest(e.clientX, e.clientY)
        drag.ghostX = worldX
        drag.ghostY = worldY
      }
      draw()
    },
    [draw, hitTest]
  )

  const onMouseUp = useCallback(() => {
    const drag = dragRef.current
    dragRef.current = null
    if (
      drag?.mode === 'room' &&
      drag.moved &&
      drag.roomId &&
      drag.ghostX !== undefined &&
      drag.ghostY !== undefined
    ) {
      propsRef.current.onMoveRoom?.(drag.roomId, drag.ghostX, drag.ghostY)
    } else if (drag?.mode === 'marquee' && drag.moved) {
      // Collect rooms of this zone/level whose centers fall inside the box.
      const canvas = canvasRef.current!
      const rect = canvas.getBoundingClientRect()
      const view = viewRef.current
      const cell = CELL * view.scale
      const minX = Math.min(drag.startX, drag.curX ?? drag.startX) - rect.left
      const maxX = Math.max(drag.startX, drag.curX ?? drag.startX) - rect.left
      const minY = Math.min(drag.startY, drag.curY ?? drag.startY) - rect.top
      const maxY = Math.max(drag.startY, drag.curY ?? drag.startY) - rect.top
      const { map, zoneId, z } = propsRef.current
      const ids: string[] = []
      for (const room of Object.values(map.rooms)) {
        if (room.zoneId !== zoneId || room.z !== z) continue
        const sx = rect.width / 2 + view.panX + room.x * cell
        const sy = rect.height / 2 + view.panY + room.y * cell
        if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) ids.push(room.id)
      }
      propsRef.current.onMarqueeSelect?.(ids)
    } else if (drag && !drag.moved && drag.mode === 'pan') {
      propsRef.current.onSelectRoom(null)
    }
    draw()
  }, [draw])

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const { room } = hitTest(e.clientX, e.clientY)
      if (room) propsRef.current.onWalkRoom(room.id)
    },
    [hitTest]
  )

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const { room, worldX, worldY } = hitTest(e.clientX, e.clientY)
      propsRef.current.onContextMenu({
        roomId: room?.id ?? null,
        clientX: e.clientX,
        clientY: e.clientY,
        worldX,
        worldY
      })
    },
    [hitTest]
  )

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const view = viewRef.current
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const next = Math.min(3, Math.max(0.3, view.scale * factor))
      // Zoom around the cursor.
      const canvas = canvasRef.current!
      const rect = canvas.getBoundingClientRect()
      const cx = e.clientX - rect.left - rect.width / 2
      const cy = e.clientY - rect.top - rect.height / 2
      const ratio = next / view.scale
      view.panX = cx - (cx - view.panX) * ratio
      view.panY = cy - (cy - view.panY) * ratio
      view.scale = next
      draw()
    },
    [draw]
  )

  return (
    <canvas
      ref={canvasRef}
      className="map-canvas"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onWheel={onWheel}
    />
  )
}
