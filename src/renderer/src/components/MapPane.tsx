/**
 * MapPane — the full mapper UI (toolbar, canvas, right-click editor, exits &
 * doors). Driven by a plain model + tracker + callbacks so it serves BOTH the
 * docked pane (live SessionStore model) and the pop-out window (RemoteMapModel
 * mirroring over IPC). Every mutation goes through MapModel methods, which the
 * remote variant forwards to the owning session.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { MapCanvas, type MapContextInfo } from './MapCanvas'
import { ClampedMenu } from './ClampedMenu'
import type { MapModel } from '../map/MapModel'
import type { TrackerControl } from '../map/RemoteMap'
import { DIRECTIONS, DIR_FULL, type Direction, type MapExit, type MapRoom } from '../map/types'

export interface MapPaneProps {
  model: MapModel
  tracker: TrackerControl
  walkTo(roomId: string, fast?: boolean): void
  /** Shown only in the docked pane. */
  onPopout?(): void
  onClose?(): void
}

type MenuState =
  | { kind: 'closed' }
  | { kind: 'menu'; info: MapContextInfo }
  | { kind: 'input'; info: MapContextInfo; mode: 'waypoint' | 'rename' | 'notes' | 'special'; value: string }
  | { kind: 'exits'; roomId: string }
  | { kind: 'zonepick'; info: MapContextInfo; roomIds: string[]; newName: string }

const ROOM_COLORS = ['', '#7c2d2d', '#7c5a2d', '#2d5a2d', '#2d4a7c', '#5a2d7c', '#2d6b6b']

export function MapPane({ model, tracker, walkTo, onPopout, onClose }: MapPaneProps) {
  const [, force] = useState(0)
  useEffect(() => {
    const off1 = model.subscribe(() => force((n) => n + 1))
    const off2 = tracker.subscribe(() => force((n) => n + 1))
    return () => {
      off1()
      off2()
    }
  }, [model, tracker])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [multiSel, setMultiSel] = useState<string[]>([])
  const [viewZoneId, setViewZoneId] = useState<string | null>(null)
  const [viewZ, setViewZ] = useState<number | null>(null)
  const [centerToken, setCenterToken] = useState(0)
  const [centerRoomId, setCenterRoomId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState>({ kind: 'closed' })
  const [showWaypoints, setShowWaypoints] = useState(false)
  const [showDupes, setShowDupes] = useState(false)
  const [zoneDialog, setZoneDialog] = useState<{
    mode: 'create' | 'rename' | 'delete'
    value: string
  } | null>(null)

  const locateRoom = useCallback(
    (roomId: string) => {
      const room = model.room(roomId)
      if (!room) return
      setViewZoneId(room.zoneId)
      setViewZ(room.z)
      setSelectedId(roomId)
      setCenterRoomId(roomId)
      setCenterToken((t) => t + 1)
    },
    [model]
  )

  const current = tracker.currentRoom
  const zoneId = viewZoneId ?? current?.zoneId ?? model.activeZoneId ?? ''
  const z = viewZ ?? current?.z ?? 0

  // Auto-follow: when the player moves, snap the view to their zone/level.
  useEffect(() => {
    if (current) {
      setViewZoneId(null)
      setViewZ(null)
      setCenterRoomId(null)
      setCenterToken((t) => t + 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id])

  const closeMenu = useCallback(() => setMenu({ kind: 'closed' }), [])

  const menuRoom =
    menu.kind === 'menu' || menu.kind === 'input' ? model.room(menu.info.roomId) : null

  const commitInput = () => {
    if (menu.kind !== 'input') return
    const value = menu.value.trim()
    const room = model.room(menu.info.roomId)
    if (menu.mode === 'waypoint' && room && value) model.setWaypoint(value, room.id)
    if (menu.mode === 'rename' && room && value) model.updateRoom(room.id, { name: value })
    if (menu.mode === 'notes' && room) model.updateRoom(room.id, { notes: value || undefined })
    if (menu.mode === 'special' && room && value) {
      model.addSpecialExit(room.id, value, selectedId !== room.id ? selectedId : null)
    }
    closeMenu()
  }

  return (
    <div className="map-pane" onClick={() => menu.kind === 'menu' && closeMenu()}>
      <div className="map-toolbar">
        <select
          className="map-select"
          title="Tracking mode"
          value={tracker.mode}
          onChange={(e) => tracker.setMode(e.target.value as typeof tracker.mode)}
        >
          <option value="map">Map</option>
          <option value="follow">Follow</option>
          <option value="off">Off</option>
        </select>
        <select
          className="map-select map-zone-select"
          title="Zone (#zone <name> to switch/create)"
          value={zoneId}
          onChange={(e) => {
            if (e.target.value === '__new__') {
              setZoneDialog({ mode: 'create', value: '' })
            } else {
              setViewZoneId(e.target.value)
              model.setActiveZone(e.target.value)
              model.setPendingZone(e.target.value)
            }
          }}
        >
          {model.map.zones.map((zone) => (
            <option key={zone.id} value={zone.id}>
              {zone.name} ({model.roomsInZone(zone.id).length})
            </option>
          ))}
          <option value="__new__">＋ New zone…</option>
        </select>
        <button
          className="map-btn"
          title="Rename this zone"
          onClick={() => {
            const zone = model.map.zones.find((zn) => zn.id === zoneId)
            setZoneDialog({ mode: 'rename', value: zone?.name ?? '' })
          }}
        >
          ✎
        </button>
        <button
          className="map-btn"
          title="Delete this zone and all its rooms"
          onClick={() => setZoneDialog({ mode: 'delete', value: '' })}
        >
          🗑
        </button>
        <span className="map-level">
          <button className="map-btn" title="Level down" onClick={() => setViewZ(z - 1)}>
            −
          </button>
          <span title="Level (up/down exits change it)">L{z}</span>
          <button className="map-btn" title="Level up" onClick={() => setViewZ(z + 1)}>
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
        <button className="map-btn" title="Waypoints" onClick={() => setShowWaypoints((s) => !s)}>
          ★
        </button>
        <button className="map-btn" title="Find duplicate rooms" onClick={() => setShowDupes((s) => !s)}>
          🧹
        </button>
        {onPopout && (
          <button className="map-btn" title="Open map in its own window" onClick={onPopout}>
            ⧉
          </button>
        )}
        {onClose && (
          <button className="map-btn" title="Close map pane (#map)" onClick={onClose}>
            ✕
          </button>
        )}
      </div>

      {(tracker.lost || (!tracker.currentRoomId && Object.keys(model.map.rooms).length > 0)) && (
        <div className="map-lost">Position unknown — right-click your room → “I am here”.</div>
      )}

      {zoneDialog?.mode === 'delete' && (
        <div className="map-waypoints">
          <div className="map-waypoint-row">
            <span className="field-hint" style={{ flex: 1 }}>
              Delete zone “{model.map.zones.find((zn) => zn.id === zoneId)?.name}” and its{' '}
              {model.roomsInZone(zoneId).length} rooms? A backup of the map is kept.
            </span>
            <button
              className="map-btn"
              style={{ color: '#ff7b86' }}
              onClick={() => {
                model.deleteZone(zoneId)
                setViewZoneId(null)
                setZoneDialog(null)
              }}
            >
              Delete
            </button>
            <button className="map-btn" onClick={() => setZoneDialog(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {zoneDialog && zoneDialog.mode !== 'delete' && (
        <div className="map-waypoints">
          <div className="map-waypoint-row">
            <span className="field-hint" style={{ flex: 'none' }}>
              {zoneDialog.mode === 'create' ? 'New zone name:' : 'Rename zone:'}
            </span>
            <input
              autoFocus
              className="var-value"
              value={zoneDialog.value}
              placeholder="e.g. Sewer District"
              onChange={(e) => setZoneDialog({ ...zoneDialog, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setZoneDialog(null)
                if (e.key === 'Enter' && zoneDialog.value.trim()) {
                  const name = zoneDialog.value.trim()
                  if (zoneDialog.mode === 'create') {
                    const id = model.createZone(name)
                    model.setActiveZone(id)
                    model.setPendingZone(id)
                    setViewZoneId(id)
                  } else {
                    model.renameZone(zoneId, name)
                  }
                  setZoneDialog(null)
                }
              }}
            />
            <button
              className="map-btn"
              disabled={!zoneDialog.value.trim()}
              onClick={() => {
                const name = zoneDialog.value.trim()
                if (!name) return
                if (zoneDialog.mode === 'create') {
                  const id = model.createZone(name)
                  model.setActiveZone(id)
                  model.setPendingZone(id)
                  setViewZoneId(id)
                } else {
                  model.renameZone(zoneId, name)
                }
                setZoneDialog(null)
              }}
            >
              OK
            </button>
            <button className="map-btn" onClick={() => setZoneDialog(null)}>
              Cancel
            </button>
          </div>
          {zoneDialog.mode === 'create' && (
            <p className="field-hint">
              The new zone becomes active and armed: the next room you map starts it.
            </p>
          )}
        </div>
      )}

      {showWaypoints && (
        <div className="map-waypoints">
          {model.map.waypoints.length === 0 && (
            <p className="field-hint">No waypoints. #wp add &lt;name&gt; creates one where you stand.</p>
          )}
          {model.map.waypoints.map((wp) => (
            <div key={wp.name} className="map-waypoint-row">
              <span
                className="map-waypoint-name"
                title="Walk there"
                onClick={() => {
                  const room = model.room(wp.roomId)
                  if (room) walkTo(room.id)
                  setShowWaypoints(false)
                }}
              >
                ★ {wp.name}
              </span>
              <button className="row-delete" onClick={() => model.removeWaypoint(wp.name)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {showDupes && (
        <div className="map-waypoints">
          {model.findDuplicateGroups().length === 0 ? (
            <p className="field-hint">No rooms share an identical name + exits. Map looks clean.</p>
          ) : (
            <>
              <p className="field-hint">
                Rooms with identical name + exits — phantoms from mis-tracking, or a genuine maze.
                Locate to inspect; merge keeps the best-connected copy and redirects all links.
              </p>
              {model.findDuplicateGroups().map((group) => (
                <div key={group[0].id} className="map-waypoint-row">
                  <span className="map-waypoint-name" style={{ cursor: 'default' }}>
                    {group[0].name} ×{group.length}
                  </span>
                  {group.map((room, i) => (
                    <button
                      key={room.id}
                      className="map-btn"
                      title={`Locate copy ${i + 1} (${model.inboundLinkCount(room.id)} inbound links)`}
                      onClick={() => locateRoom(room.id)}
                    >
                      {i + 1}
                    </button>
                  ))}
                  <button
                    className="map-btn"
                    title="Merge all copies into the best-connected one"
                    onClick={() => {
                      const score = (r: (typeof group)[0]) =>
                        r.exits.filter((e) => e.to).length +
                        model.inboundLinkCount(r.id) +
                        (r.serverId ? 100 : 0)
                      const keeper = [...group].sort((a, b) => score(b) - score(a))[0]
                      for (const room of group) {
                        if (room.id !== keeper.id) model.mergeRooms(keeper.id, room.id)
                      }
                      if (!model.room(tracker.currentRoomId ?? '')) {
                        tracker.setCurrentRoom(keeper.id)
                      }
                      locateRoom(keeper.id)
                    }}
                  >
                    Merge
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <div className="map-canvas-wrap">
        <MapCanvas
          map={model.map}
          zoneId={zoneId}
          z={z}
          currentRoomId={tracker.currentRoomId}
          currentIsGuess={tracker.speculative}
          selectedRoomId={selectedId}
          selectedRoomIds={multiSel}
          centerToken={centerToken}
          centerRoomId={centerRoomId}
          onSelectRoom={(id) => {
            setSelectedId(id)
            if (multiSel.length > 0) setMultiSel([])
          }}
          onToggleSelect={(id) =>
            setMultiSel((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
          }
          onMarqueeSelect={(ids) => {
            setMultiSel(ids)
            setSelectedId(null)
          }}
          onWalkRoom={(id) => walkTo(id)}
          onMoveRoom={(id, x, y) => model.moveRoom(id, x, y)}
          onContextMenu={(info) => setMenu({ kind: 'menu', info })}
        />

        {menu.kind === 'menu' && (
          <ClampedMenu x={menu.info.clientX} y={menu.info.clientY} onClick={(e) => e.stopPropagation()}>
            {menuRoom && multiSel.length > 1 && multiSel.includes(menuRoom.id) ? (
              <>
                <div className="map-menu-title">{multiSel.length} rooms selected</div>
                <button
                  onClick={() =>
                    setMenu({ kind: 'zonepick', info: menu.info, roomIds: multiSel, newName: '' })
                  }
                >
                  🗂 Move {multiSel.length} rooms to zone…
                </button>
                <button
                  className="map-menu-danger"
                  onClick={() => {
                    for (const id of multiSel) model.deleteRoom(id)
                    setMultiSel([])
                    closeMenu()
                  }}
                >
                  🗑 Delete {multiSel.length} rooms
                </button>
                <button
                  onClick={() => {
                    setMultiSel([])
                    closeMenu()
                  }}
                >
                  Clear selection
                </button>
              </>
            ) : menuRoom ? (
              <>
                <div className="map-menu-title">{menuRoom.name}</div>
                <button onClick={() => { tracker.setCurrentRoom(menuRoom.id); closeMenu() }}>
                  ⌖ I am here
                </button>
                <button onClick={() => { walkTo(menuRoom.id); closeMenu() }}>🚶 Walk here</button>
                <button onClick={() => { walkTo(menuRoom.id, true); closeMenu() }}>
                  ⚡ Walk here (fast)
                </button>
                <button onClick={() => setMenu({ kind: 'input', info: menu.info, mode: 'waypoint', value: '' })}>
                  ★ Set waypoint…
                </button>
                <button onClick={() => setMenu({ kind: 'input', info: menu.info, mode: 'rename', value: menuRoom.name })}>
                  ✎ Rename…
                </button>
                <button onClick={() => setMenu({ kind: 'input', info: menu.info, mode: 'notes', value: menuRoom.notes ?? '' })}>
                  📝 Notes…
                </button>
                <button onClick={() => setMenu({ kind: 'input', info: menu.info, mode: 'special', value: '' })}>
                  ◈ Add special exit…
                </button>
                <button onClick={() => setMenu({ kind: 'exits', roomId: menuRoom.id })}>
                  🚪 Exits &amp; doors…
                </button>
                <button
                  onClick={() =>
                    setMenu({ kind: 'zonepick', info: menu.info, roomIds: [menuRoom.id], newName: '' })
                  }
                >
                  🗂 Move to zone…
                </button>
                <div className="map-menu-colors">
                  {ROOM_COLORS.map((c) => (
                    <button
                      key={c || 'none'}
                      className="map-color-swatch"
                      style={{ background: c || '#1c2128' }}
                      title={c ? 'Set color' : 'Clear color'}
                      onClick={() => { model.updateRoom(menuRoom.id, { color: c || undefined }); closeMenu() }}
                    />
                  ))}
                </div>
                {selectedId && selectedId !== menuRoom.id && (
                  <button onClick={() => { model.mergeRooms(selectedId, menuRoom.id); closeMenu() }}>
                    ⇥ Merge into selected room
                  </button>
                )}
                <button
                  className="map-menu-danger"
                  onClick={() => { model.deleteRoom(menuRoom.id); closeMenu() }}
                >
                  🗑 Delete room
                </button>
              </>
            ) : (
              <button
                onClick={() => {
                  const room = model.createRoom({
                    name: 'New room',
                    zoneId,
                    x: menu.info.worldX,
                    y: menu.info.worldY,
                    z
                  })
                  setSelectedId(room.id)
                  closeMenu()
                }}
              >
                ＋ Add room here
              </button>
            )}
          </ClampedMenu>
        )}

        {menu.kind === 'input' && (
          <ClampedMenu x={menu.info.clientX} y={menu.info.clientY} onClick={(e) => e.stopPropagation()}>
            <div className="map-menu-title">
              {menu.mode === 'waypoint' && 'Waypoint name'}
              {menu.mode === 'rename' && 'Room name'}
              {menu.mode === 'notes' && 'Notes'}
              {menu.mode === 'special' && (
                <>Special exit command{selectedId && selectedId !== menu.info.roomId ? ' (→ selected room)' : ' (unlinked)'}</>
              )}
            </div>
            <input
              autoFocus
              value={menu.value}
              placeholder={menu.mode === 'special' ? 'e.g. enter portal' : ''}
              onChange={(e) => setMenu({ ...menu, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitInput()
                if (e.key === 'Escape') closeMenu()
              }}
            />
            <div className="map-menu-row">
              <button onClick={commitInput}>OK</button>
              <button onClick={closeMenu}>Cancel</button>
            </div>
          </ClampedMenu>
        )}

        {menu.kind === 'zonepick' && (
          <ClampedMenu x={menu.info.clientX} y={menu.info.clientY} onClick={(e) => e.stopPropagation()}>
            <div className="map-menu-title">
              Move {menu.roomIds.length === 1 ? 'room' : `${menu.roomIds.length} rooms`} to zone
            </div>
            {model.map.zones.map((zone) => (
              <button
                key={zone.id}
                onClick={() => {
                  model.moveRoomsToZone(menu.roomIds, zone.id)
                  setMultiSel([])
                  closeMenu()
                }}
              >
                {zone.name} ({model.roomsInZone(zone.id).length})
              </button>
            ))}
            <input
              placeholder="…or a new zone name"
              value={menu.newName}
              onChange={(e) => setMenu({ ...menu, newName: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && menu.newName.trim()) {
                  const id = model.createZone(menu.newName.trim())
                  model.moveRoomsToZone(menu.roomIds, id)
                  setMultiSel([])
                  closeMenu()
                }
                if (e.key === 'Escape') closeMenu()
              }}
            />
            <div className="map-menu-row">
              <button
                onClick={() => {
                  if (menu.newName.trim()) {
                    const id = model.createZone(menu.newName.trim())
                    model.moveRoomsToZone(menu.roomIds, id)
                    setMultiSel([])
                  }
                  closeMenu()
                }}
              >
                OK
              </button>
              <button onClick={closeMenu}>Cancel</button>
            </div>
          </ClampedMenu>
        )}

        {menu.kind === 'exits' && (
          <ExitsEditor model={model} roomId={menu.roomId} selectedId={selectedId} onClose={closeMenu} />
        )}
      </div>

      <div className="map-footer">
        {model.roomsInZone(zoneId).length} rooms in{' '}
        {model.map.zones.find((zn) => zn.id === zoneId)?.name ?? 'this zone'} ·{' '}
        {Object.keys(model.map.rooms).length} mapped across {model.map.zones.length}{' '}
        {model.map.zones.length === 1 ? 'zone' : 'zones'} ·{' '}
        {/* Which of the two very different mappers is actually running. Until
            this was shown, the only way to tell was to infer it from how the
            map turned out. */}
        <span
          title={
            tracker.serverDriven
              ? 'The MUD is naming its own rooms, so identity is exact.'
              : 'Rooms are being read off the screen, so identity is worked out from what they look like.'
          }
        >
          {tracker.serverDriven ? 'from the MUD' : 'read from the screen'}
        </span>
      </div>
    </div>
  )
}

/** Give a room an exit it does not have yet. A room made by hand starts with
 *  none, so without this there was nothing in the panel to edit or link and no
 *  way to draw a connection at all. */
function AddExit({ model, room }: { model: MapModel; room: MapRoom }) {
  const missing = DIRECTIONS.filter((d) => !room.exits.some((e) => e.dir === d))
  const [dir, setDir] = useState<Direction>(missing[0] ?? 'n')
  if (missing.length === 0) return null
  const chosen = missing.includes(dir) ? dir : missing[0]
  return (
    <div className="map-exit-row">
      <select value={chosen} onChange={(e) => setDir(e.target.value as Direction)}>
        {missing.map((d) => (
          <option key={d} value={d}>
            {DIR_FULL[d]}
          </option>
        ))}
      </select>
      <button
        className="map-btn"
        title="Add this exit, unexplored — then link it to a room"
        onClick={() => model.addExit(room.id, chosen)}
      >
        Add exit
      </button>
    </div>
  )
}

function ExitsEditor({
  model,
  roomId,
  selectedId,
  onClose
}: {
  model: MapModel
  roomId: string
  selectedId: string | null
  onClose(): void
}) {
  const [, force] = useState(0)
  useEffect(() => model.subscribe(() => force((n) => n + 1)), [model])
  const room = model.room(roomId)
  if (!room) return null

  const describe = (exit: MapExit): string => {
    const dest = exit.to ? model.room(exit.to) : null
    return dest ? dest.name : exit.to ? '(missing)' : 'unexplored'
  }

  return (
    <div className="map-exits" onClick={(e) => e.stopPropagation()}>
      <div className="map-menu-title">
        Exits — {room.name}
        <button className="panel-close" style={{ float: 'right' }} onClick={onClose}>
          ✕
        </button>
      </div>
      {room.exits.length === 0 && <p className="field-hint">No exits recorded.</p>}
      <AddExit model={model} room={room} />
      {room.exits.map((exit, i) => (
        <div key={i} className="map-exit-row">
          <span className="map-exit-dir">
            {exit.dir ? DIR_FULL[exit.dir as Direction] : exit.command}
          </span>
          <span className="map-exit-dest" title={describe(exit)}>
            → {describe(exit)}
          </span>
          <label title="Door on this exit">
            <input
              type="checkbox"
              checked={exit.door}
              onChange={(e) => {
                if (exit.dir) model.setDoor(room.id, exit.dir, e.target.checked)
                else model.setExitAt(room.id, i, { door: e.target.checked })
              }}
            />
            🚪
          </label>
          {exit.door && (
            <input
              className="map-doorname"
              placeholder="door"
              value={exit.doorName ?? ''}
              title='What to open (e.g. "gate")'
              onChange={(e) => {
                if (exit.dir) model.setDoor(room.id, exit.dir, true, e.target.value)
                else model.setExitAt(room.id, i, { doorName: e.target.value })
              }}
            />
          )}
          {exit.to === null && selectedId && selectedId !== room.id && (
            <button
              className="map-btn"
              title="Link to the selected room"
              onClick={() => {
                if (exit.dir) model.linkRooms(room.id, exit.dir, selectedId, false)
                else model.setExitAt(room.id, i, { to: selectedId })
              }}
            >
              ⇥
            </button>
          )}
          <button className="row-delete" title="Delete exit" onClick={() => model.removeExitAt(room.id, i)}>
            ✕
          </button>
        </div>
      ))}
      <p className="field-hint">
        Tip: select a target room first, then use ⇥ to link an unexplored exit to it.
      </p>
    </div>
  )
}
