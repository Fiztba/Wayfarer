/**
 * Polite HTTP for the directory sources.
 *
 * Every source here is someone's hobby site on modest hosting, so requests are
 * spaced out, identified honestly, and retried gently. Nothing in this file is
 * shipped in the app — it runs in CI (or by hand) to build the snapshot.
 */

export const USER_AGENT =
  'Wayfarer-MUD-Client/0.4 (+https://github.com/Fiztba/Wayfarer; directory builder)'

let lastRequestAt = 0

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Fetch text, never issuing requests closer together than `spacingMs`.
 *
 * The spacing is global rather than per-host: the builder walks one source at a
 * time, and a shared throttle is easier to reason about than a per-host pool
 * when the whole point is to stay unobtrusive.
 */
export async function politeText(
  url: string,
  opts: { spacingMs?: number; retries?: number; body?: string; timeoutMs?: number } = {}
): Promise<string> {
  const { spacingMs = 500, retries = 3, body, timeoutMs = 45_000 } = opts

  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = lastRequestAt + spacingMs - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()

    try {
      const res = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          ...(body === undefined
            ? {}
            : { 'Content-Type': 'application/x-www-form-urlencoded' })
        },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      })
      // 5xx and 429 are worth waiting out; 4xx means we asked wrong.
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`)
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true })
      return await res.text()
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal || attempt === retries) throw err
      // Back off hard on the retries — a struggling host should not be pushed.
      await sleep(2000 * (attempt + 1))
    }
  }
  throw new Error('unreachable')
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
}

/** Strip tags to a single flat string with `|` between former elements. */
export function flatten(html: string): string {
  const t = decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, '|'))
  return t.replace(/\s+/g, ' ').replace(/(\|\s*)+/g, '|')
}

/** Pull `|Label|value` out of a flattened page. */
export function labelled(flat: string, label: string, max = 400): string {
  const m = new RegExp(
    `\\|${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|\\s*([^|]{1,${max}})`
  ).exec(flat)
  return m ? m[1].trim() : ''
}
