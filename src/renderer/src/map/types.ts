/** Mapper data model. The map is a GRAPH: rooms and links are truth,
 *  x/y/z coordinates are only a drawing suggestion. Two rooms are never
 *  merged because they share coordinates — only explicitly, or via a
 *  server-provided room id. */

export type Direction = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'u' | 'd'

export const DIRECTIONS: Direction[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'u', 'd']

export const OPPOSITE: Record<Direction, Direction> = {
  n: 's',
  s: 'n',
  e: 'w',
  w: 'e',
  ne: 'sw',
  sw: 'ne',
  nw: 'se',
  se: 'nw',
  u: 'd',
  d: 'u'
}

export const DIR_DELTA: Record<Direction, [number, number, number]> = {
  n: [0, -1, 0],
  s: [0, 1, 0],
  e: [1, 0, 0],
  w: [-1, 0, 0],
  ne: [1, -1, 0],
  nw: [-1, -1, 0],
  se: [1, 1, 0],
  sw: [-1, 1, 0],
  u: [0, 0, 1],
  d: [0, 0, -1]
}

export const DIR_FULL: Record<Direction, string> = {
  n: 'north',
  s: 'south',
  e: 'east',
  w: 'west',
  ne: 'northeast',
  nw: 'northwest',
  se: 'southeast',
  sw: 'southwest',
  u: 'up',
  d: 'down'
}

const WORD_TO_DIR: Record<string, Direction> = {
  n: 'n', north: 'n',
  s: 's', south: 's',
  e: 'e', east: 'e',
  w: 'w', west: 'w',
  ne: 'ne', northeast: 'ne',
  nw: 'nw', northwest: 'nw',
  se: 'se', southeast: 'se',
  sw: 'sw', southwest: 'sw',
  u: 'u', up: 'u',
  d: 'd', down: 'd'
}

export function wordToDirection(word: string): Direction | null {
  return WORD_TO_DIR[word.toLowerCase()] ?? null
}

export interface MapExit {
  /** Standard direction, or null for special exits ("enter portal"). */
  dir: Direction | null
  /** Command to traverse; for dir exits defaults to the direction itself. */
  command?: string
  /** Destination room id; null = seen but unexplored. */
  to: string | null
  door: boolean
  /** What to `open` (defaults to "door"). */
  doorName?: string
}

export interface MapRoom {
  id: string
  /** Authoritative server identity (e.g. "vnum:3001", "gmcp:12345"). */
  serverId?: string
  name: string
  zoneId: string
  x: number
  y: number
  z: number
  color?: string
  notes?: string
  exits: MapExit[]
}

export interface MapZone {
  id: string
  name: string
}

export interface Waypoint {
  name: string
  roomId: string
}

export interface MudMap {
  version: 1
  zones: MapZone[]
  rooms: Record<string, MapRoom>
  waypoints: Waypoint[]
  /** Where the player last was — restored as the starting position on reconnect. */
  lastRoomId?: string | null
}

export function emptyMap(): MudMap {
  return { version: 1, zones: [], rooms: {}, waypoints: [], lastRoomId: null }
}

export interface RoomDetection {
  name: string
  exits: Array<{ dir: Direction; door: boolean }>
  /** Server room id read off the title line (staff roomflags), when shown. */
  serverId?: string
}

export interface ServerRoomInfo {
  serverId: string
  name?: string
  areaName?: string
  /** dir → destination serverId (when the protocol provides it). */
  exits?: Partial<Record<Direction, string | null>>
}

/**
 * Remove prompt-shaped prefixes ("<221hp 340mv [day]> ") that can end up glued
 * to room titles on MUDs that redraw their prompt with a bare carriage return.
 */
export function stripPromptPrefix(line: string): string {
  return line.replace(/^\s*(?:<[^<>]{1,60}>\s*)+/, '')
}

export function normalizeRoomName(name: string): string {
  return stripPromptPrefix(name).trim().toLowerCase()
}

export function fingerprintOf(name: string, dirs: Direction[]): string {
  return `${normalizeRoomName(name)}|${[...dirs].sort().join(',')}`
}
