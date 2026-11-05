/** Menjalankan fn tanpa pernah melempar; kegagalan hanya dicetak saat debug aktif. */
export function safeCall<T>(fn: () => T, debug: boolean, label: string): T | undefined {
  try {
    return fn()
  } catch (err) {
    if (debug && typeof console !== 'undefined') {
      console.warn(`[artracker] ${label}`, err)
    }
    return undefined
  }
}

/**
 * `instanceof Error` gagal untuk Error dari realm lain (iframe, micro-frontend), padahal pesan dan stack-nya valid.
 * Tag internal `[object Error]` / `[object DOMException]` tetap sama lintas-realm dan tidak bisa dipalsukan oleh objek biasa.
 */
export function isError(value: unknown): value is Error {
  if (value instanceof Error) return true
  if (typeof value !== 'object' || value === null) return false
  const tag = Object.prototype.toString.call(value)
  return tag === '[object Error]' || tag === '[object DOMException]'
}
