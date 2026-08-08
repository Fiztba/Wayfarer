import type { MudApi } from '../../preload/index'

declare global {
  interface Window {
    mud: MudApi
  }
}

export {}
