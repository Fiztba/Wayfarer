/** Moving sessions between windows: shapes shared by main, preload and renderer. */

/** Another window a session could move to, for the tab menu. */
export interface WindowChoice {
  id: number
  label: string
  main: boolean
}

export type WindowResult = { ok: true; value?: unknown } | { ok: false; error: string }
