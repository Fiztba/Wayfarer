/**
 * Character scope: an automation item may be limited to one or more
 * characters on top of the world it belongs to. The restriction is a
 * comma-separated list of names, matched case-insensitively, because the
 * login guesser capitalises the first letter and GMCP may not.
 *
 * Nothing scoped to a character is active until the session knows who is
 * logged in (GMCP Char.Name, the login guesser, or #char <name>).
 */

/** The names in a restriction, lower-cased and trimmed; empty = unrestricted. */
export function characterList(restriction: string | undefined): string[] {
  return (restriction ?? '')
    .split(/[,;]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
}

/** Is an item restricted to `restriction` active for the character `charName`? */
export function forCharacter(restriction: string | undefined, charName: string | null | undefined): boolean {
  const names = characterList(restriction)
  if (names.length === 0) return true
  if (!charName) return false
  return names.includes(charName.trim().toLowerCase())
}
