/** Only the packaged app page may retain the privileged preload bridge. */
export function isOwnPage(url: string, appPage: string, devUrl?: string): boolean {
  try {
    const target = new URL(url)
    const own = new URL(appPage)
    if (target.protocol === 'file:') {
      return target.host === own.host && target.pathname === own.pathname
    }
    return !!devUrl && target.origin === new URL(devUrl).origin
  } catch {
    return false
  }
}
