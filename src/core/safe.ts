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
