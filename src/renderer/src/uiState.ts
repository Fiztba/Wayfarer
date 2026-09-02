/** Tiny shared UI flags that live outside React. */
export const uiState = {
  /** True while a modal (settings/help panel) is open; macros are suppressed. */
  modalOpen: false,
  /** Set by App; lets non-React code (e.g. the #help command) open help. */
  openHelp: undefined as (() => void) | undefined,
  /** Set by App; opens Settings → Triggers with an editor seeded from a line
   *  of output, so a trigger can be built from what the MUD actually said. */
  openTriggerFromLine: undefined as ((sessionId: string, line: string) => void) | undefined
}
