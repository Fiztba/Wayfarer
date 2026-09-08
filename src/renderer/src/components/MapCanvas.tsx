/**
 * MapCanvas — pure canvas renderer + interactions for one zone/level of a map.
 * Driven entirely by props so the docked pane (live model) and the pop-out
 * window (IPC mirror) can share it.
 */
import React, { useCallback, useEffect, useRef } from 'react'
import type { MapRoom, MudMap } from '../map/types'
import { displayLinks, linkHasFocus, type DisplayLink, type ExitFocus } from '../map/displayLinks'
import {
  BEARING_AT,
  CELL,
  DIR_UNIT,
  ROOM,
  cubicPoint,
  cubicTangent,
  drawnAsClaimed,
  linkPath,
  polyPoint,
  polyTangent,
  routeDirectionalLink
} from '../map/geometry'

/** Trace a polyline with its corners rounded off, without stroking it. */
function traceWire(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], radius: number): void {
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let k = 1; k < pts.length - 1; k++) {
    const a = pts[k - 1]
    const b = pts[k]
    const c = pts[k + 1]
    // Preserve a visible straight compass stub at each room. A large rounded
    // first corner can otherwise begin turning while still inside its box.
    const cornerRadius = k === 1 || k === pts.length - 2 ? radius * 0.4 : radius
    const r = Math.min(cornerRadius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2)
    ctx.arcTo(b.x, b.y, c.x, c.y, r)
  }
  const last = pts[pts.length - 1]
  ctx.lineTo(last.x, last.y)
}

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
  exitFocus?: ExitFocus | null
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
    const { map, zoneId, z, currentRoomId, currentIsGuess, selectedRoomId, selectedRoomIds, exitFocus } =
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
    const connectors = displayLinks(rooms, map)
    const highlighted = new Set(multiSelected)
    if (selectedRoomId) highlighted.add(selectedRoomId)
    const focusedLink = exitFocus ? connectors.find((link) => linkHasFocus(link, exitFocus)) : undefined
    const focusedDestination = focusedLink && exitFocus
      ? focusedLink.room.id === exitFocus.roomId ? focusedLink.destination?.id : focusedLink.room.id
      : null
    const isHighlighted = (link: DisplayLink): boolean => exitFocus
      ? linkHasFocus(link, exitFocus)
      : highlighted.has(link.room.id) || (!!link.returning.length && !!link.destination && highlighted.has(link.destination.id))

    /** Draw one exit, as owned by `room`. */
    const drawLink = (link: DisplayLink, highlight: boolean): void => {
      const { room, destination: dest } = link
      const exit = (exitFocus?.roomId === room.id
        ? link.outgoing.find((ref) => ref.index === exitFocus.exitIndex)?.exit : null) ?? link.outgoing[0].exit
      const returnExit = (exitFocus && exitFocus.roomId === dest?.id
        ? link.returning.find((ref) => ref.index === exitFocus.exitIndex)?.exit : null) ?? link.returning[0]?.exit
      const vertical = exit.dir === 'u' || exit.dir === 'd'
      // Up and down are glyphs on the room -- unless both rooms sit on this
      // level, when the pair is drawn as a link (with the glyph riding it)
      // so it does not look unconnected.
      if (vertical && !(dest && visibleById.has(dest.id))) return
      const [rx, ry] = roomPos(room)
      const [sx, sy] = toScreen(rx, ry)
      let ex: number
      let ey: number
      let stub = false
      const door = [...link.outgoing, ...link.returning].some((ref) => ref.exit.door)
      let curve: { c1: [number, number]; c2: [number, number]; span: number } | null = null
      // Screen-space wire around the rooms in the way, when the straight line
      // would cross one and a route exists; otherwise the curve bows.
      let route: { x: number; y: number }[] | null = null
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
        const needsPorts = (exit.dir && !drawnAsClaimed({ x: rx, y: ry }, destCell, exit.dir)) ||
          (returnExit?.dir && !drawnAsClaimed(destCell, { x: rx, y: ry }, returnExit.dir))
        if (path.bowed || needsPorts || dest.id === room.id) {
          const wire = routeDirectionalLink({ x: rx, y: ry }, { x: dx, y: dy }, exit.dir ?? '', returnExit?.dir ?? '', isOccupied)
          if (wire) {
            route = wire.map((p) => {
              const [wx, wy] = toScreen(p.x, p.y)
              return { x: wx, y: wy }
            })
          }
        }
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
        route
          ? polyPoint(route, t)
          : curve
            ? cubicPoint(P0, C1, C2, P3, t)
            : { x: sx + (ex - sx) * t, y: sy + (ey - sy) * t }
      const dirAt = (t: number) =>
        route
          ? polyTangent(route, t)
          : curve
            ? cubicTangent(P0, C1, C2, P3, t)
            : { x: ex - sx, y: ey - sy }

      const folded = !!destCell && (
        link.outgoing.some((r) => r.exit.dir && !drawnAsClaimed({ x: rx, y: ry }, destCell!, r.exit.dir)) ||
        link.returning.some((r) => r.exit.dir && !drawnAsClaimed(destCell!, { x: rx, y: ry }, r.exit.dir))
      )
      const base = highlight
        ? exitFocus ? '#7ddfff' : '#cbd9e8'
        : exitFocus ? '#303c4c'
        : stub
          ? dest
            ? '#8b6f47' // leads off-view (other zone/level)
            : '#4a5568' // unexplored stub
          : folded ? '#ac8cce' : '#647183'
      ctx.strokeStyle = base
      ctx.lineWidth = highlight ? Math.max(2, 2.4 * view.scale) : thin
      ctx.setLineDash(exit.to === null ? [3, 3] : [])
      ctx.beginPath()
      if (route) {
        traceWire(ctx, route, 7 * view.scale)
      } else {
        ctx.moveTo(sx, sy)
        if (curve) ctx.bezierCurveTo(curve.c1[0], curve.c1[1], curve.c2[0], curve.c2[1], ex, ey)
        else ctx.lineTo(ex, ey)
      }
      // A dark under-stroke separates crossings instead of suggesting a
      // junction. The graph only connects at a room, never at a line crossing.
      const width = ctx.lineWidth
      ctx.strokeStyle = '#0d1117'
      ctx.lineWidth = width + Math.max(2, 3 * view.scale)
      ctx.stroke()
      ctx.strokeStyle = base
      ctx.lineWidth = width
      ctx.stroke()
      ctx.setLineDash([])

      // Bearing arrows. Where a link is NOT drawn along the compass direction it
      // claims -- greedy placement put the room somewhere else, and often no
      // coordinate assignment could have done better -- the line itself cannot
      // carry that direction, so a small arrow just outside each room points
      // the way its own exit really goes. Only the liars get marked: on a real
      // 859-room map that was 44 links of 1870.
      if (curve && dest && destCell) {
        const here = { x: rx, y: ry }
        const marks: Array<[number, number, string]> = []
        const outgoingMarks = highlight && exitFocus?.roomId === room.id ? [{ exit }] : link.outgoing
        const returningMarks = highlight && exitFocus?.roomId === dest.id && returnExit ? [{ exit: returnExit }] : link.returning
        for (const { exit: out } of outgoingMarks) {
          if (out.dir && !drawnAsClaimed(here, destCell, out.dir)) marks.push([sx, sy, out.dir])
        }
        for (const { exit: back } of returningMarks) {
          if (back.dir && !drawnAsClaimed(destCell, here, back.dir)) marks.push([ex, ey, back.dir])
        }
        if (marks.length > 0) {
          ctx.strokeStyle = base
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
            if (view.scale >= 0.8 && (!exitFocus || highlight)) {
              ctx.font = `${Math.max(8, 9 * view.scale)}px sans-serif`
              ctx.textAlign = 'center'
              ctx.fillStyle = base
              ctx.fillText(d.toUpperCase(), tipX + u[0] * 10 * view.scale, tipY + u[1] * 10 * view.scale + 3 * view.scale)
            }
          }
          ctx.strokeStyle = base
        }
      }

      const oneWay = !!dest && dest.id !== room.id && !stub && link.returning.length === 0
      if (curve && curve.span > 1) {
        // Paired slash marks denote a long drawing of ONE exit. Unlike the
        // old chevrons these cannot be mistaken for permission to travel only
        // in the arbitrary direction used to paint a bidirectional connector.
        ctx.lineWidth = Math.max(1, 1.2 * view.scale)
        {
          const p = at(door || oneWay ? 0.3 : 0.5)
          const g = dirAt(door || oneWay ? 0.3 : 0.5)
          const a = Math.atan2(g.y, g.x)
          const len = 4 * view.scale
          for (const offset of [-2, 2]) {
            const x = p.x + Math.cos(a) * offset * view.scale
            const y = p.y + Math.sin(a) * offset * view.scale
            ctx.beginPath()
            ctx.moveTo(x - Math.cos(a + 1.0) * len, y - Math.sin(a + 1.0) * len)
            ctx.lineTo(x + Math.cos(a + 1.0) * len, y + Math.sin(a + 1.0) * len)
            ctx.stroke()
          }
        }
      }

      if (oneWay) {
        const p = at(0.5), g = dirAt(0.5)
        const a = Math.atan2(g.y, g.x), size = Math.max(4, 5 * view.scale)
        ctx.fillStyle = base
        ctx.beginPath()
        ctx.moveTo(p.x + Math.cos(a) * size, p.y + Math.sin(a) * size)
        ctx.lineTo(p.x - Math.cos(a - 0.7) * size, p.y - Math.sin(a - 0.7) * size)
        ctx.lineTo(p.x - Math.cos(a + 0.7) * size, p.y - Math.sin(a + 0.7) * size)
        ctx.closePath()
        ctx.fill()
      }

      if (door) {
        // Door tick: short bar across the path at its midpoint, perpendicular
        // to the direction the path is actually travelling there.
        const mid = at(oneWay ? 0.7 : 0.5)
        const g = dirAt(oneWay ? 0.7 : 0.5)
        const angle = Math.atan2(g.y, g.x) + Math.PI / 2
        const t = 5 * view.scale
        ctx.strokeStyle = '#e5c07b'
        ctx.lineWidth = Math.max(1.5, 2 * view.scale)
        ctx.beginPath()
        ctx.moveTo(mid.x - Math.cos(angle) * t, mid.y - Math.sin(angle) * t)
        ctx.lineTo(mid.x + Math.cos(angle) * t, mid.y + Math.sin(angle) * t)
        ctx.stroke()
      }

      if (vertical) {
        // Two rooms on one level joined by up or down: the line says
        // connected, the glyph riding it says which way (off the midpoint
        // when a door tick is already there).
        const p = at(door ? 0.3 : 0.5)
        const glyph = Math.max(7, 9 * view.scale)
        ctx.font = `${glyph}px sans-serif`
        ctx.textAlign = 'center'
        ctx.fillStyle = highlight ? '#ffffff' : '#c8ccd4'
        ctx.fillText(exit.dir === 'u' ? '▲' : '▼', p.x, p.y + glyph * 0.35)
      }
    }

    for (const link of connectors) if (!isHighlighted(link)) drawLink(link, false)
    // Selected connections cross over context lines, but stay underneath room
    // boxes so highlighting never paints a false route through another room.
    for (const link of connectors) if (isHighlighted(link)) drawLink(link, true)

    // ---- rooms ----
    for (const room of rooms) {
      const [rx, ry] = roomPos(room)
      const [sx, sy] = toScreen(rx, ry)
      if (sx < -cell || sy < -cell || sx > w + cell || sy > h + cell) continue

      const isSelected = room.id === selectedRoomId || multiSelected.has(room.id)
      // A room the mapper had to create even though an existing one might have
      // been the same place. It is drawn dashed until later evidence either
      // merges it away or rules the rivals out, so a copy is visible rather
      // than silently sitting in the map looking exactly like real geography.
      const unsure = (room.rivals?.length ?? 0) > 0
      ctx.fillStyle = room.color || '#1c2128'
      ctx.strokeStyle = isSelected ? '#ffffff' : unsure ? '#c8a04a' : '#8b949e'
      ctx.lineWidth = isSelected ? 2 : 1
      if (unsure && !isSelected) ctx.setLineDash([3, 2])
      ctx.beginPath()
      ctx.roundRect(sx - half, sy - half, half * 2, half * 2, 4 * view.scale)
      ctx.fill()
      ctx.stroke()
      ctx.setLineDash([])

      if (room.id === focusedDestination) {
        ctx.strokeStyle = '#7ddfff'
        ctx.lineWidth = 2
        ctx.strokeRect(sx - half - 4, sy - half - 4, half * 2 + 8, half * 2 + 8)
      }

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
