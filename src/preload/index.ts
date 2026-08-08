import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type {
  ConnectOptions,
  DirectoryResult,
  Profile,
  SessionEvent,
  SettingsSet
} from '../shared/types'

export interface MudApi {
  connect(opts: ConnectOptions): Promise<string>
  send(id: string, text: string): void
  resize(id: string, cols: number, rows: number): void
  disconnect(id: string): Promise<void>
  reconnect(id: string): Promise<void>
  onSessionEvent(cb: (id: string, event: SessionEvent) => void): () => void
  profiles: {
    list(): Promise<Profile[]>
    save(profile: Partial<Profile>): Promise<Profile>
    remove(id: string): Promise<void>
  }
  directory: {
    list(): Promise<DirectoryResult>
    refresh(): Promise<DirectoryResult>
  }
  settings: {
    get(profileId: string | null): Promise<SettingsSet>
    save(profileId: string | null, set: SettingsSet): Promise<SettingsSet>
  }
  log: {
    start(sessionId: string, name: string): Promise<string>
    stop(sessionId: string): Promise<void>
    line(sessionId: string, text: string): void
    openFolder(): Promise<void>
  }
  map: {
    load(key: string): Promise<unknown | null>
    save(key: string, map: unknown): void
    popout(sessionId: string, title: string): Promise<void>
    /** Session side: push state to pop-outs; receive hello/actions. */
    pushState(sessionId: string, state: unknown): void
    onHello(cb: (sessionId: string) => void): () => void
    onAction(cb: (sessionId: string, action: unknown) => void): () => void
    /** Pop-out side: announce, receive state, send actions. */
    hello(sessionId: string): void
    onState(cb: (sessionId: string, state: unknown) => void): () => void
    sendAction(sessionId: string, action: unknown): void
  }
}

const api: MudApi = {
  connect: (opts) => ipcRenderer.invoke('session:connect', opts),
  send: (id, text) => ipcRenderer.send('session:send', id, text),
  resize: (id, cols, rows) => ipcRenderer.send('session:resize', id, cols, rows),
  disconnect: (id) => ipcRenderer.invoke('session:disconnect', id),
  reconnect: (id) => ipcRenderer.invoke('session:reconnect', id),
  onSessionEvent: (cb) => {
    const handler = (_e: IpcRendererEvent, id: string, event: SessionEvent) => cb(id, event)
    ipcRenderer.on('session:event', handler)
    return () => ipcRenderer.off('session:event', handler)
  },
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    save: (profile) => ipcRenderer.invoke('profiles:save', profile),
    remove: (id) => ipcRenderer.invoke('profiles:remove', id)
  },
  directory: {
    list: () => ipcRenderer.invoke('directory:list'),
    refresh: () => ipcRenderer.invoke('directory:refresh')
  },
  settings: {
    get: (profileId) => ipcRenderer.invoke('settings:get', profileId),
    save: (profileId, set) => ipcRenderer.invoke('settings:save', profileId, set)
  },
  log: {
    start: (sessionId, name) => ipcRenderer.invoke('log:start', sessionId, name),
    stop: (sessionId) => ipcRenderer.invoke('log:stop', sessionId),
    line: (sessionId, text) => ipcRenderer.send('log:line', sessionId, text),
    openFolder: () => ipcRenderer.invoke('log:openFolder')
  },
  map: {
    load: (key) => ipcRenderer.invoke('map:load', key),
    save: (key, map) => ipcRenderer.send('map:save', key, map),
    popout: (sessionId, title) => ipcRenderer.invoke('map:popout', sessionId, title),
    pushState: (sessionId, state) => ipcRenderer.send('map:mirror-state', sessionId, state),
    onHello: (cb) => {
      const handler = (_e: IpcRendererEvent, sessionId: string) => cb(sessionId)
      ipcRenderer.on('map:mirror-hello', handler)
      return () => ipcRenderer.off('map:mirror-hello', handler)
    },
    onAction: (cb) => {
      const handler = (_e: IpcRendererEvent, sessionId: string, action: unknown) =>
        cb(sessionId, action)
      ipcRenderer.on('map:mirror-action', handler)
      return () => ipcRenderer.off('map:mirror-action', handler)
    },
    hello: (sessionId) => ipcRenderer.send('map:mirror-hello', sessionId),
    onState: (cb) => {
      const handler = (_e: IpcRendererEvent, sessionId: string, state: unknown) =>
        cb(sessionId, state)
      ipcRenderer.on('map:mirror-state', handler)
      return () => ipcRenderer.off('map:mirror-state', handler)
    },
    sendAction: (sessionId, action) => ipcRenderer.send('map:mirror-action', sessionId, action)
  }
}

contextBridge.exposeInMainWorld('mud', api)
