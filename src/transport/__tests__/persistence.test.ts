import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { createItem } from '../../core/envelope'
import { createBatchStore, type PendingBatch } from '../persistence'

const DAY = 24 * 3600 * 1000

function batch(id: string, opts: { name?: string; type?: 'event' | 'log'; level?: 'error' | 'info'; bytes?: number; age?: number } = {}): PendingBatch {
  const item = createItem({
    type: opts.type ?? 'event',
    name: opts.name ?? 'x',
    level: opts.level,
    message: opts.type === 'log' ? 'm' : undefined,
  })
  return { id, createdAt: Date.now() - (opts.age ?? 0), bytes: opts.bytes ?? 600, items: [item] }
}

beforeEach(() => {
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  localStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

test('batch bertahan dan terbaca kembali', async () => {
  const store = await createBatchStore()
  await store.put(batch('a'))
  const pending = await store.listPending()
  expect(pending.map((b) => b.id)).toEqual(['a'])
  expect(pending[0]?.items[0]?.name).toBe('x')
})

test('listPending mengurut dari yang terlama dan menghormati limit', async () => {
  const store = await createBatchStore()
  await store.put(batch('new', { age: 1000 }))
  await store.put(batch('old', { age: 5000 }))
  await store.put(batch('mid', { age: 3000 }))
  expect((await store.listPending()).map((b) => b.id)).toEqual(['old', 'mid', 'new'])
  expect((await store.listPending(2)).map((b) => b.id)).toEqual(['old', 'mid'])
})

test('delete menghapus batch', async () => {
  const store = await createBatchStore()
  await store.put(batch('a'))
  await store.delete('a')
  expect(await store.listPending()).toEqual([])
})

test('prune membuang batch melewati maxAgeMs', async () => {
  const store = await createBatchStore()
  await store.put(batch('stale', { age: 8 * DAY }))
  await store.put(batch('fresh', { age: 1000 }))
  const removed = await store.prune({ maxBytes: 10_000_000, maxAgeMs: 7 * DAY })
  expect(removed).toBe(1)
  expect((await store.listPending()).map((b) => b.id)).toEqual(['fresh'])
})

test('prune membuang replay_chunk lebih dulu, lalu event, dan mempertahankan log error', async () => {
  const store = await createBatchStore()
  await store.put(batch('replay', { name: 'replay_chunk', age: 3000 }))
  await store.put(batch('err', { type: 'log', level: 'error', age: 4000 }))
  await store.put(batch('evt', { age: 2000 }))
  await store.prune({ maxBytes: 700, maxAgeMs: 7 * DAY })
  const left = (await store.listPending()).map((b) => b.id)
  expect(left).toEqual(['err'])
})

test('prune di dalam satu tingkat memakai FIFO', async () => {
  const store = await createBatchStore()
  await store.put(batch('old', { age: 5000 }))
  await store.put(batch('new', { age: 1000 }))
  await store.prune({ maxBytes: 700, maxAgeMs: 7 * DAY })
  expect((await store.listPending()).map((b) => b.id)).toEqual(['new'])
})

// Review Focus #1
test('jatuh ke localStorage saat indexedDB tidak tersedia', async () => {
  vi.stubGlobal('indexedDB', undefined)
  const store = await createBatchStore()
  await store.put(batch('a'))
  expect(await store.listPending()).toHaveLength(1)
  expect(Object.keys(localStorage).some((k) => k.startsWith('ar_q_'))).toBe(true)
  await store.delete('a')
  expect(await store.listPending()).toHaveLength(0)
})

test('jatuh ke localStorage saat indexedDB.open melempar', async () => {
  vi.stubGlobal('indexedDB', {
    open() {
      throw new Error('SecurityError')
    },
  })
  const store = await createBatchStore()
  await store.put(batch('a'))
  expect(await store.listPending()).toHaveLength(1)
})

test('fallback localStorage dibatasi 1 MB dan membuang batch yang paling tidak penting', async () => {
  vi.stubGlobal('indexedDB', undefined)
  const store = await createBatchStore()
  await store.put(batch('replay', { name: 'replay_chunk', bytes: 600_000, age: 3000 }))
  await store.put(batch('evt', { bytes: 600_000, age: 1000 }))
  const ids = (await store.listPending()).map((b) => b.id)
  expect(ids).not.toContain('replay')
})

test('operasi store tidak pernah reject saat localStorage rusak', async () => {
  vi.stubGlobal('indexedDB', undefined)
  const store = await createBatchStore()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('quota', 'QuotaExceededError')
  })
  await expect(store.put(batch('a'))).resolves.toBeUndefined()
  vi.restoreAllMocks()
})
