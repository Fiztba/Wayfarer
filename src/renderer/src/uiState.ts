/** Tiny shared UI flags that live outside React. */
export const uiState = {
  /** True while a modal (settings/help panel) is open; macros are suppressed. */
  modalOpen: false,
  /** Set by App; lets non-React code (e.g. the #help command) open help. */
  openHelp: undefined as (() => void) | undefined
}
