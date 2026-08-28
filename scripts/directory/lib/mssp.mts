/**
 * MSSP value semantics that more than one place needs to agree on.
 *
 * Raised by SlySven (Mudlet) after seeing the directory: whether a connection
 * is secured affects which port you should be shown. He was right, and we had
 * it wrong — the MSSP spec defines SSL as
 *
 *     SSL   The port number for a SSL (Secure Socket Layer) encrypted
 *           connection.
 *
 * a port, not a flag. Treating it as a boolean and testing it against "1" both
 * dropped most TLS-capable MUDs and threw away the port when it was there. Of
 * 29 MUDs reporting the field, 12 give a real port and only 4 wrote "1".
 *
 * The port almost always differs from the telnet port — Beutelland is 5678
 * plain and 5679 secure, EternityMUD 23 and 992, The Last Outpost 4000 and
 * 4443 — so a client that turns TLS on while keeping the plain port simply
 * fails to connect. Only MUME uses the same number for both.
 */

/** What a MUD's SSL field tells us. */
export interface TlsOffer {
  /** True when the MUD offers an encrypted connection at all. */
  offered: boolean
  /**
   * The port to use, when stated. Null means "offered, port not stated" — some
   * MUDs read the spec as a boolean and answer 1, which is not a plausible MUD
   * port and so cannot be taken literally.
   */
  port: number | null
}

export const NO_TLS: TlsOffer = { offered: false, port: null }

/**
 * Read an MSSP SSL value.
 *
 *   ""  / "0" / "-1"  no encrypted connection
 *   "1"               offered, but the port was not really stated
 *   2..65535          the port to connect to
 */
export function parseSslValue(raw: string | number | null | undefined): TlsOffer {
  if (raw === null || raw === undefined || raw === '') return NO_TLS
  const n = Number(String(raw).trim())
  if (!Number.isFinite(n) || n <= 0) return NO_TLS
  // 1 is a privileged system port no MUD listens on; it means "yes" written by
  // someone who read SSL as a flag.
  if (n === 1) return { offered: true, port: null }
  if (n > 65535) return NO_TLS
  return { offered: true, port: Math.trunc(n) }
}
