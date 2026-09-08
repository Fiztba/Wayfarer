/** Change only when the handoff schema becomes incompatible. */
export const COPYOVER_PROTOCOL = 1
export const COPYOVER_LIMIT = 128 * 1024 * 1024

/** Only named data fields cross a restart; never callbacks, hosts or handles. */
export function saveFields(target: object, keys: readonly string[]): Record<string, unknown> {
  const obj = target as Record<string, unknown>
  return JSON.parse(JSON.stringify(Object.fromEntries(keys.map((key) => [key, obj[key]]))))
}
export function restoreFields(target: object, keys: readonly string[], state: Record<string, unknown>): void {
  const obj = target as Record<string, unknown>
  for (const key of keys) if (Object.hasOwn(state, key)) obj[key] = state[key]
}
