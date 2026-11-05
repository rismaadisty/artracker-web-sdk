import type { TelemetryContext } from '../core/client'
import { scrubUrl } from '../privacy/urlScrubber'

/** Perubahan route SPA: patch pushState/replaceState + popstate + hashchange -> event page_view + breadcrumb. */
export function installNavigationListeners(ctx: TelemetryContext): () => void {
  const hist = window.history
  const origPush = hist.pushState
  const origReplace = hist.replaceState
  const scrub = (u: string): string => scrubUrl(u, { maskUrlPathIds: ctx.cfg.privacy.maskUrlPathIds })
  let lastHref = window.location.href
  let active = true

  const record = (): void => {
    try {
      const to = window.location.href
      if (to === lastHref) return // replaceState ke URL yang sama (mis. update state framework) bukan navigasi
      const from = lastHref
      lastHref = to
      const data = { from: scrub(from), to: scrub(to) }
      ctx.breadcrumbs.add({ type: 'navigation', at: Date.now(), data })
      ctx.emit({ type: 'event', name: 'page_view', attributes: { ...data, referrer: scrub(document.referrer) } })
    } catch {
      /* tidak boleh mengganggu navigasi aplikasi host */
    }
  }

  const wrap = (orig: History['pushState']): History['pushState'] =>
    function (this: History, ...args: Parameters<History['pushState']>) {
      const result = orig.apply(this, args)
      if (active) record()
      return result
    }
  const patchedPush = wrap(origPush)
  const patchedReplace = wrap(origReplace)
  hist.pushState = patchedPush
  hist.replaceState = patchedReplace

  window.addEventListener('popstate', record)
  window.addEventListener('hashchange', record)

  return () => {
    active = false
    window.removeEventListener('popstate', record)
    window.removeEventListener('hashchange', record)
    // Jangan menimpa patch library lain yang dipasang setelah kita; wrapper kita jadi pass-through (active=false).
    if (hist.pushState === patchedPush) hist.pushState = origPush
    if (hist.replaceState === patchedReplace) hist.replaceState = origReplace
  }
}
