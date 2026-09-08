import type { Profile, SettingsSet } from './types'
export interface WorldBundle {
  format: 'wayfarer-world'; version: 1; exportedAt: string
  profile: Profile; settings: SettingsSet; map: unknown | null
}
export interface WorldPreview {
  profileId: string
  token: string; name: string; host: string; port: number; rooms: number
  triggers: number; aliases: number; scripts: number; variables: number
  source: string
}
export interface WorldBackup { id: string; name: string; kind: string; at: string; profileId: string }
