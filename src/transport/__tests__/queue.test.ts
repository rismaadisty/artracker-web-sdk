import { resolveConfig } from '../../core/config'
import { createItem } from '../../core/envelope'
import { BatchQueue, type FlushReason } from '../queue'
import type { RawItem } from '../../types'

const base = { appKey: 'art_live_' + '0'.repeat(32), endpoint: 'https://a.example/i' }
const item = (attrs?: Record<string, unknown>) => createItem({ type: 'event', name: 'x', attributes: attrs })

let flushes: Array<{ items: RawItem[]; reason: FlushReason }>
const onFlush = (items: RawItem[], reason: FlushReason) => flushes.push({ items, reason })

beforeEach(() => {
  flushes = []
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

test('flush saat mencapai maxItems', () => {
  const q = new BatchQueue(resolveConfig(base), onFlush)
  for (let i = 0; i < 50; i++) q.add(item())
  expect(flushes).toHaveLength(1)
  expect(flushes[0]?.reason).toBe('count')
  expect(flushes[0]?.items).toHaveLength(50)
  expect(q.size).toBe(0)
  q.stop()
})

test('flush saat melewati maxBytes', () => {
  const q = new BatchQueue(resolveConfig({ ...base, batch: { maxBytes: 1024 } }), onFlush)
  q.add(item({ blob: 'a'.repeat(600) }))
  expect(flushes).toHaveLength(0)
  q.add(item({ blob: 'b'.repeat(600) }))
  expect(flushes).toHaveLength(1)
  expect(flushes[0]?.reason).toBe('bytes')
  expect(flushes[0]?.items).toHaveLength(2)
  q.stop()
})

test('flush saat timer flushIntervalMs berjalan', () => {
  const q = new BatchQueue(resolveConfig(base), onFlush)
  q.add(item())
  vi.advanceTimersByTime(4999)
  expect(flushes).toHaveLength(0)
  vi.advanceTimersByTime(1)
  expect(flushes).toHaveLength(1)
  expect(flushes[0]?.reason).toBe('timer')
  q.stop()
})

test('flush tidak memanggil onFlush saat antrean kosong', () => {
  const q = new BatchQueue(resolveConfig(base), onFlush)
  q.flush('manual')
  vi.advanceTimersByTime(20_000)
  expect(flushes).toHaveLength(0)
  q.stop()
})

test('item yang di-flush dikeluarkan dari antrean dan reason diteruskan', () => {
  const q = new BatchQueue(resolveConfig(base), onFlush)
  q.add(item())
  q.add(item())
  expect(q.size).toBe(2)
  q.flush('lifecycle')
  expect(q.size).toBe(0)
  expect(flushes[0]?.reason).toBe('lifecycle')
  q.flush('manual')
  expect(flushes).toHaveLength(1)
  q.stop()
})

test('stop() menghentikan timer', () => {
  const q = new BatchQueue(resolveConfig(base), onFlush)
  q.stop()
  q.add(item())
  vi.advanceTimersByTime(60_000)
  expect(flushes).toHaveLength(0)
})

test('onFlush yang melempar tidak merusak antrean', () => {
  const q = new BatchQueue(resolveConfig(base), () => {
    throw new Error('x')
  })
  q.add(item())
  expect(() => q.flush('manual')).not.toThrow()
  expect(q.size).toBe(0)
  q.stop()
})
