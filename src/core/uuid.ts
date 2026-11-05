function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out)
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256)
  }
  return out
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** UUIDv7 (RFC 9562): 48 bit timestamp ms + versi 7 + variant 10xx + bit acak. */
export function uuidv7(): string {
  const ts = Date.now()
  const b = randomBytes(16)
  b[0] = Math.floor(ts / 2 ** 40) & 0xff
  b[1] = Math.floor(ts / 2 ** 32) & 0xff
  b[2] = (ts >>> 24) & 0xff
  b[3] = (ts >>> 16) & 0xff
  b[4] = (ts >>> 8) & 0xff
  b[5] = ts & 0xff
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
  const h = hex(b)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
