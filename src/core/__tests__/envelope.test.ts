import { resolveConfig } from '../config'
import { Bus } from '../bus'
import { buildEnvelope, createItem, MAX_ATTRIBUTE_BYTES } from '../envelope'

const cfg = resolveConfig({ appKey: 'art_live_' + '0'.repeat(32), endpoint: 'https://a.example/i' })

test('setiap item memiliki id uuidv7 dan timestamp RFC3339', () => {
  const i = createItem({ type: 'event', name: 'x' })
  expect(i.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
  expect(i.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
})

test('name dipotong ke 255 dan message ke 4096', () => {
  const i = createItem({ type: 'log', level: 'error', name: 'n'.repeat(500), message: 'm'.repeat(9000) })
  expect(i.name).toHaveLength(255)
  expect(i.message).toHaveLength(4096)
})

test('level dikosongkan untuk tipe selain log', () => {
  expect(createItem({ type: 'event', name: 'x', level: 'error' }).level).toBeUndefined()
})

test('level dipertahankan untuk tipe log', () => {
  expect(createItem({ type: 'log', level: 'warn', message: 'x' }).level).toBe('warn')
})

test('session_id dan user_id dipotong ke 128', () => {
  const i = createItem({ type: 'event', name: 'x', sessionId: 's'.repeat(300), userId: 'u'.repeat(300) })
  expect(i.session_id).toHaveLength(128)
  expect(i.user_id).toHaveLength(128)
})

// Review Focus #3
test('attributes di atas 24 KB dipangkas dan ditandai', () => {
  const i = createItem({ type: 'event', name: 'x', attributes: { blob: 'a'.repeat(40_000), keep: 'ok' } })
  expect(JSON.stringify(i.attributes).length).toBeLessThanOrEqual(MAX_ATTRIBUTE_BYTES)
  expect(i.attributes?._artracker_truncated).toBe(true)
  expect(i.attributes?.keep).toBe('ok')
  expect(i.attributes?._original_bytes).toBeGreaterThan(40_000)
})

test('attributes kecil tidak diubah', () => {
  const i = createItem({ type: 'event', name: 'x', attributes: { a: 1 } })
  expect(i.attributes).toEqual({ a: 1 })
})

test('attributes yang tidak dapat diserialisasi (sirkular) tidak melempar', () => {
  const a: Record<string, unknown> = {}
  a.self = a
  expect(() => createItem({ type: 'event', name: 'x', attributes: a })).not.toThrow()
})

// Review Focus #5
test('envelope selalu memuat sent_at berpasangan dengan timestamp item', () => {
  const e = buildEnvelope([createItem({ type: 'event', name: 'x', at: 1000 })], cfg, {}, 5000)
  expect(e.sent_at).toBe(new Date(5000).toISOString())
  expect(e.items[0]?.timestamp).toBe(new Date(1000).toISOString())
})

test('sdk meta memakai nama artracker-web dan versi', () => {
  const e = buildEnvelope([], cfg, { environment: 'production' }, 0)
  expect(e.sdk.name).toBe('artracker-web')
  expect(e.sdk.version).toBe('0.0.0-test')
  expect(e.context).toEqual({ environment: 'production' })
})

test('Bus mengirim ke semua listener dan on() mengembalikan fungsi unsubscribe', () => {
  const bus = new Bus()
  const a = vi.fn()
  const b = vi.fn()
  const offA = bus.on(a)
  bus.on(b)
  const item = createItem({ type: 'event', name: 'x' })
  bus.emit(item)
  offA()
  bus.emit(item)
  expect(a).toHaveBeenCalledTimes(1)
  expect(b).toHaveBeenCalledTimes(2)
})

test('listener Bus yang melempar tidak menghentikan listener lain', () => {
  const bus = new Bus()
  const ok = vi.fn()
  bus.on(() => {
    throw new Error('x')
  })
  bus.on(ok)
  expect(() => bus.emit(createItem({ type: 'event', name: 'x' }))).not.toThrow()
  expect(ok).toHaveBeenCalled()
})

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length

test('batas 24 KB dihitung dalam BYTE UTF-8, bukan karakter (backend menghitung byte)', () => {
  const i = createItem({ type: 'event', name: 'x', attributes: { teks: '日'.repeat(9000), kecil: 'ok' } }) // 9000 char = 27000 byte
  expect(bytes(i.attributes)).toBeLessThanOrEqual(MAX_ATTRIBUTE_BYTES)
  expect(i.attributes?._artracker_truncated).toBe(true)
  expect(i.attributes?.kecil).toBe('ok')
})

test('emoji (4 byte/surrogate pair) juga dihitung sebagai byte', () => {
  const i = createItem({ type: 'event', name: 'x', attributes: { e: '😀'.repeat(7000) } }) // 14000 char = 28000 byte
  expect(bytes(i.attributes)).toBeLessThanOrEqual(MAX_ATTRIBUTE_BYTES)
})

test('utf8Length cocok dengan TextEncoder', async () => {
  const { utf8Length } = await import('../bytes')
  for (const s of ['', 'abc', 'é', '日本語', '😀', 'a😀é日', '\ud800']) {
    expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length)
  }
})
