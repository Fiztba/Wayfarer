/**
 * Guess the character name from a MUD's login exchange — the fallback for
 * servers that don't announce it over GMCP.
 *
 * Deliberately conservative:
 *   - Only the player's OWN input right after a recognizable name prompt is
 *     considered; server text is never mined for names.
 *   - The candidate stays provisional until the server has taken a password
 *     (echo masking turned on, then off) — that is the strongest generic
 *     signal that the name was accepted. It's dropped if the server asks
 *     for a name again in the meantime (rejection / typo / "no such name").
 *   - MUDs with no password step (guest logins) never confirm — the tab
 *     simply keeps its plain label rather than risk a wrong name.
 *   - Only name-shaped words qualify: 2–20 letters, single token, and not a
 *     login keyword like "new", "guest", "yes".
 *
 * A guess is only ever a fallback: the caller lets GMCP override it.
 */

const NAME_PROMPT = new RegExp(
  [
    'by what name',
    'what is your name',
    'what.{0,12}your name',
    "enter (your )?(character'?s? )?name",
    'character name',
    'your name\\??\\s*$',
    '\\bname\\s*[:?]\\s*$',
    '\\blogin\\s*:\\s*$',
    'who are you',
    'what shall (we|i) call you',
    'name of your character',
    'account name',
    'name, please',
  ].join('|'),
  'i'
)

const NOT_A_NAME = new Set([
  'new', 'create', 'guest', 'yes', 'no', 'y', 'n', 'quit', 'help', 'who', 'look',
  'login', 'connect', 'exit', 'back', 'list', 'info', 'password', 'anonymous',
])

export function looksLikeName(word: string): boolean {
  if (!/^[A-Za-z][A-Za-z'-]{1,19}$/.test(word)) return false
  return !NOT_A_NAME.has(word.toLowerCase())
}

export class LoginGuesser {
  private candidate: string | null = null
  private confirmed = false

  reset(): void {
    this.candidate = null
    this.confirmed = false
  }

  /**
   * The player sent `sent` in answer to `promptText`. Returns a name to
   * apply immediately only when it is already confirmed; otherwise null.
   */
  onSend(promptText: string, sent: string): string | null {
    if (this.confirmed) return null
    const trimmed = sent.trim()
    if (NAME_PROMPT.test(promptText.trim())) {
      // A name prompt: the answer must be exactly one name-shaped word.
      // Anything else ("kill rat", "new character") is not a name.
      const words = trimmed.split(/\s+/).filter(Boolean)
      const word = words.length === 1 ? words[0] : ''
      this.candidate = looksLikeName(word) ? capitalize(word) : null
      return null
    }
    // Any other prompt leaves the candidate alone (password, y/n, etc.).
    return null
  }

  /**
   * Password masking just ended: if we have a candidate, the server took a
   * password after the name — treat the name as accepted.
   */
  onMaskEnd(): string | null {
    if (this.confirmed || !this.candidate) return null
    this.confirmed = true
    return this.candidate
  }
}

function capitalize(word: string): string {
  // First letter only, like Diku's CAP(): the rest is the player's own
  // spelling (O'Brien, McCoy).
  return word[0].toUpperCase() + word.slice(1)
}
