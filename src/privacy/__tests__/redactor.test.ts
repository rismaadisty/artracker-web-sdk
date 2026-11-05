import { resolveConfig } from '../../core/config'
import { createItem } from '../../core/envelope'
import { redactItem, redactString, redactValue } from '../redactor'

const base = { appKey: 'art_live_' + '0'.repeat(32), endpoint: 'https://a.example/i' }
const cfg = resolveConfig(base)

test.each([
  ['budi@example.com', /^b\*+@example\.com$/],
  ['hubungi budi.santoso+x@mail.example.co.id ya', /b\*+@mail\.example\.co\.id/],
  ['4539 1488 0343 6467', /^\*{4} \*{4} \*{4} 6467$/],
  ['4539-1488-0343-6467', /^\*{4} \*{4} \*{4} 6467$/],
  ['4539148803436467', /^\*{4} \*{4} \*{4} 6467$/],
  ['+628123456789', /^\+?\*+6789$/],
  ['081234567890', /^\*+7890$/],
  ['3201011505900001', /^\[redacted\]$/],
  ['eyJhbGciOiJIUzI1NiJ9.e30.x', /^\[redacted\]$/],
  ['Authorization: Bearer abcdef123456', /\[redacted\]/],
  ['key=art_sec_abcdefghijklmnop', /\[redacted\]/],
  ['sk_live_abcdefghijklmnop', /^\[redacted\]$/],
])('meredaksi %s', (input, expected) => {
  expect(redactString(input)).toMatch(expected)
})

test('angka 16 digit yang gagal Luhn dan bukan NIK tidak diredaksi', () => {
  expect(redactString('1234567812345678')).toBe('1234567812345678')
})

test('timestamp epoch milidetik 13 digit tidak dianggap kartu', () => {
  expect(redactString('start 1762331598050 end')).toBe('start 1762331598050 end')
})

test('teks biasa dan angka pendek tidak berubah', () => {
  expect(redactString('Order #12345 selesai, total 250000')).toBe('Order #12345 selesai, total 250000')
})

test('beberapa PII dalam satu string semuanya diredaksi', () => {
  const out = redactString('a@b.co dan 4539 1488 0343 6467')
  expect(out).not.toContain('a@b.co')
  expect(out).not.toContain('4539')
})

test('query param sensitif di dalam string diredaksi', () => {
  expect(redactString('GET /cb?code=abc123&page=2')).toBe('GET /cb?code=[redacted]&page=2')
})

test('deny-list berbasis key meredaksi nilai apa pun', () => {
  expect(redactValue({ password: 'hunter2', note: 'ok' })).toEqual({ password: '[redacted]', note: 'ok' })
  expect(redactValue({ userPassword: 'x', access_token: 'y', 'x-api-key': 'z', cvv: 1, card: { n: 1 } })).toEqual({
    userPassword: '[redacted]',
    access_token: '[redacted]',
    'x-api-key': '[redacted]',
    cvv: '[redacted]',
    card: '[redacted]',
  })
})

test('deny-list tidak salah menyasar key yang hanya mengandung potongan kata', () => {
  const v = { className: 'btn', shipping: 'JNE', passenger: 'ok', spinner: true, cardinality: 3 }
  expect(redactValue(v)).toEqual(v)
})

test('redactValue merekursi array dan objek bersarang', () => {
  expect(redactValue({ a: [{ email: 'x' }, 'budi@example.com'], n: 5, ok: true, nil: null })).toEqual({
    a: [{ email: 'x' }, expect.stringMatching(/^b\*+@example\.com$/)],
    n: 5,
    ok: true,
    nil: null,
  })
})

test('traversal berhenti di kedalaman 6', () => {
  let deep: Record<string, unknown> = { leaf: 'budi@example.com' }
  for (let i = 0; i < 10; i++) deep = { child: deep }
  expect(JSON.stringify(redactValue(deep))).not.toContain('budi@example.com')
})

test('referensi sirkular tidak menyebabkan loop tak hingga', () => {
  const a: Record<string, unknown> = { name: 'x' }
  a.self = a
  expect(() => redactValue(a)).not.toThrow()
})

test('traversal dibatasi 1000 node', () => {
  const wide = Array.from({ length: 5000 }, (_, i) => ({ i }))
  const out = redactValue(wide) as unknown[]
  const kept = out.filter((x) => typeof x === 'object' && x !== null)
  expect(kept.length).toBeLessThanOrEqual(1000)
  expect(out).toContain('[truncated]')
})

test('Date, fungsi, dan Error ditangani tanpa melempar', () => {
  const out = redactValue({ d: new Date(0), f: () => 1, e: new Error('boom') }) as Record<string, unknown>
  expect(out.d).toBe('1970-01-01T00:00:00.000Z')
  expect(out.f).toBeUndefined()
  expect(out.e).toBeDefined()
})

test('redactor kustom pengguna dijalankan pada string', () => {
  const c = resolveConfig({ ...base, privacy: { redactors: [(s) => s.replace(/rahasia/g, 'X')] } })
  const item = redactItem(createItem({ type: 'event', name: 'x', attributes: { a: 'ini rahasia' } }), c)
  expect(item?.attributes).toEqual({ a: 'ini X' })
})

test('redactItem meredaksi message, name, dan attributes', () => {
  const item = redactItem(
    createItem({ type: 'log', level: 'error', name: 'u budi@example.com', message: 'gagal 4539 1488 0343 6467', attributes: { password: 'p' } }),
    cfg,
  )
  expect(JSON.stringify(item)).not.toContain('budi@example.com')
  expect(JSON.stringify(item)).not.toContain('4539 1488')
  expect(item?.attributes).toEqual({ password: '[redacted]' })
})

test('redactItem tidak memutasi item masukan', () => {
  const input = createItem({ type: 'event', name: 'x', attributes: { email: 'a@b.co', n: 'budi@example.com' } })
  const snapshot = JSON.stringify(input)
  redactItem(input, cfg)
  expect(JSON.stringify(input)).toBe(snapshot)
})

test('user_id dan session_id tidak diubah', () => {
  const input = createItem({ type: 'event', name: 'x', userId: 'budi@example.com', sessionId: 'ses_1' })
  const out = redactItem(input, cfg)
  expect(out?.user_id).toBe('budi@example.com')
  expect(out?.session_id).toBe('ses_1')
})

test('beforeSend mengembalikan null membuang item', () => {
  expect(redactItem(createItem({ type: 'event', name: 'x' }), { ...cfg, beforeSend: () => null })).toBeNull()
})

test('beforeSend dijalankan paling akhir, setelah redaksi bawaan', () => {
  const seen: string[] = []
  redactItem(createItem({ type: 'event', name: 'x', attributes: { a: 'budi@example.com' } }), {
    ...cfg,
    beforeSend: (i) => {
      seen.push(JSON.stringify(i.attributes))
      return i
    },
  })
  expect(seen[0]).not.toContain('budi@example.com')
})

test('beforeSend yang melempar membuang item (fail-closed)', () => {
  const out = redactItem(createItem({ type: 'event', name: 'x' }), {
    ...cfg,
    beforeSend: () => {
      throw new Error('x')
    },
  })
  expect(out).toBeNull()
})

test('beforeSend yang mengembalikan nilai tidak valid mempertahankan item yang sudah diredaksi', () => {
  const out = redactItem(createItem({ type: 'event', name: 'x', attributes: { a: 'budi@example.com' } }), {
    ...cfg,
    beforeSend: (() => undefined) as never,
  })
  expect(out).not.toBeNull()
  expect(JSON.stringify(out)).not.toContain('budi@example.com')
})

test('fast path: teks tanpa pemicu tidak berubah dan hasil identik dengan jalur penuh', () => {
  for (const s of ['Halaman beranda', 'Selamat datang di toko kami', '', 'a b c']) expect(redactString(s)).toBe(s)
})

test('redactItem dengan skipAttributes tidak menyentuh attributes (objek dalam tetap utuh) tetapi tetap menjalankan beforeSend', () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: 'dalam' } } } } } }, token: 'jangan-diubah' }
  const seen: unknown[] = []
  const out = redactItem(createItem({ type: 'session', name: 'replay_chunk', attributes: deep }), { ...cfg, beforeSend: (i) => (seen.push(i.name), i) }, { skipAttributes: true })
  expect(out?.attributes).toEqual(deep)
  expect(seen).toEqual(['replay_chunk'])
})
