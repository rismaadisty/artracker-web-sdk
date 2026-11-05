import { chunkEvents } from '../chunker'

const MAX = 24 * 1024
const ev = (i: number, size = 1000, type = 3) => ({ type, timestamp: 1_700_000_000_000 + i, data: 'x'.repeat(size) })

test('event kosong menghasilkan tanpa chunk', () => {
  expect(chunkEvents([], MAX, 0)).toEqual([])
})

test('setiap chunk <= 24 KB setelah serialisasi dan seluruh event terjaga berurutan', () => {
  const events = Array.from({ length: 200 }, (_, i) => ev(i))
  const chunks = chunkEvents(events, MAX, 0)
  expect(chunks.length).toBeGreaterThan(1)
  for (const c of chunks) expect(JSON.stringify(c).length).toBeLessThanOrEqual(MAX)
  const flat = chunks.flatMap((c) => c.events as Array<{ timestamp: number }>)
  expect(flat.map((e) => e.timestamp)).toEqual(events.map((e) => e.timestamp))
})

test('seq berurutan dari seqStart dan start/end mengikuti timestamp event', () => {
  const chunks = chunkEvents(Array.from({ length: 100 }, (_, i) => ev(i)), MAX, 7)
  expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => 7 + i))
  expect(chunks[0]?.start).toBe(1_700_000_000_000)
  const last = chunks[chunks.length - 1]
  expect(last?.end).toBe(1_700_000_000_099)
  for (const c of chunks) expect(c.end).toBeGreaterThanOrEqual(c.start)
})

test('full_snapshot true hanya pada chunk yang memuat event tipe 2', () => {
  const chunks = chunkEvents([ev(0, 10, 2), ev(1, 10, 3)], MAX, 0)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.full_snapshot).toBe(true)
  expect(chunkEvents([ev(0, 10, 3)], MAX, 0)[0]?.full_snapshot).toBe(false)
})

test('event tunggal >24 KB dipotong dan ditandai oversized tanpa membuang event lain', () => {
  const chunks = chunkEvents([ev(0, 10), ev(1, 40_000, 2), ev(2, 10)], MAX, 0)
  const all = chunks.flatMap((c) => c.events as Array<{ oversized?: boolean; timestamp: number; type: number }>)
  const big = all.find((e) => e.oversized)
  expect(big).toMatchObject({ oversized: true, type: 2, timestamp: 1_700_000_000_001 })
  expect(all.filter((e) => !e.oversized)).toHaveLength(2)
  for (const c of chunks) expect(JSON.stringify(c).length).toBeLessThanOrEqual(MAX)
})

test('param sensitif pada URL di dalam event diredaksi dan JSON tetap valid', () => {
  const e = { type: 2, timestamp: 1, data: { node: { attributes: { href: 'https://a/cb?token=abc123&x=1', title: 'ok' } } } }
  const [c] = chunkEvents([e], MAX, 0)
  const text = JSON.stringify(c)
  expect(text).not.toContain('abc123')
  expect(text).toContain('token=[redacted]&x=1')
  expect(JSON.parse(text)).toBeTruthy()
})

test('event yang tidak dapat diserialisasi dilewati tanpa melempar', () => {
  const circular: Record<string, unknown> = { type: 3, timestamp: 1 }
  circular.self = circular
  expect(() => chunkEvents([circular, ev(1, 10)], MAX, 0)).not.toThrow()
  expect(chunkEvents([circular, ev(1, 10)], MAX, 0).flatMap((c) => c.events)).toHaveLength(1)
})
