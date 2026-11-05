/** Panjang string dalam byte UTF-8 (backend menghitung batas attributes dalam byte, bukan karakter JS). */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4 // surrogate pair valid (emoji dll.)
      i++
    } else n += 3 // termasuk surrogate tunggal: TextEncoder menggantinya dengan U+FFFD (3 byte)
  }
  return n
}
