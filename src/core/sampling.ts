/** FNV-1a 32 bit (unsigned). Deterministik, tanpa crypto. */
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** hash32 sebagai pecahan di [0,1). */
export function hashFraction(s: string): number {
  return hash32(s) / 0x100000000
}

/** Keputusan sampling per sesi: sesi yang sama selalu mendapat keputusan yang sama. */
export function sessionSampled(sessionId: string, rate: number): boolean {
  if (rate >= 1) return true
  if (rate <= 0) return false
  return hashFraction(sessionId) < rate
}
