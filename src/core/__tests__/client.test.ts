import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { createBatchStore } from '../../transport/persistence'
import { createItem } from '../envelope'
import { ARTrackerClient } from '../client'
import type { Envelope, RawItem } from '../../types'

const KEY = 'art_live_' + '0'.repeat(32)
const opts = { appKey: KEY, endpoint: 'https://a.example/api/v1/ingest' }

let fetchMock: ReturnType<typeof vi.fn>
let clients: ARTrackerClient[]

const respond = (status: number, headers?: Record<string, string>) => new Response(null, { status, headers })
const envelopes = (): Envelope[] =>
  fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string) as Envelope)
const sent = (): RawItem[] => envelopes().flatMap((e) => e.items)
const make = () => {
  const c = new ARTrackerClient()
  clients.push(c)
  return c
}

beforeEach(() => {
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('CompressionStream', undefined) // body JSON polos agar mudah dibaca
  fetchMock = vi.fn(async () => respond(202))
  vi.stubGlobal('fetch', fetchMock)
  clients = []
})
afterEach(() => {
  clients.forEach((c) => c.shutdown())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('track sebelum init ditampung lalu dialirkan setelah init', async () => {
  const c = make()
  c.track('early')
  c.init(opts)
  await c.flush()
  expect(sent().map((i) => i.name)).toContain('early')
})

test('buffer pre-init dibatasi 100 item', async () => {
  const c = make()
  for (let i = 0; i < 150; i++) c.track('e')
  c.init(opts)
  await c.flush()
  expect(sent().filter((i) => i.name === 'e')).toHaveLength(100)
})

test('init kedua tidak membuat instance baru', async () => {
  const c = make()
  c.init(opts)
  c.init(opts)
  await c.flush()
  expect(sent().filter((i) => i.name === 'session_start')).toHaveLength(1)
})

test('init dengan opsi invalid tidak melempar ke pemanggil', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const c = make()
  expect(() => c.init({} as never)).not.toThrow()
  expect(warn).toHaveBeenCalled()
  expect(() => c.track('x')).not.toThrow()
})

test('sesi baru memancarkan item session_start bertipe session dengan metadata perangkat', async () => {
  const c = make()
  c.init(opts)
  await c.flush()
  const s = sent().find((i) => i.name === 'session_start')
  expect(s?.type).toBe('session')
  expect(s?.session_id).toMatch(/^ses_/)
  expect(s?.attributes).toHaveProperty('entry_url')
  expect(s?.attributes).toHaveProperty('ua')
})

test('envelope memuat sent_at, sdk artracker-web, dan context environment', async () => {
  const c = make()
  c.init({ ...opts, appVersion: '2.4.1' })
  await c.flush()
  const e = envelopes()[0]
  expect(e?.sdk.name).toBe('artracker-web')
  expect(typeof e?.sent_at).toBe('string')
  expect(e?.context).toMatchObject({ environment: 'production', app_version: '2.4.1' })
})

test('identify menyetel user_id pada item berikutnya dan mengirim $identify', async () => {
  const c = make()
  c.init(opts)
  c.identify('usr_1', { plan: 'pro' })
  c.track('x')
  await c.flush()
  expect(sent().find((i) => i.name === 'x')?.user_id).toBe('usr_1')
  const id = sent().find((i) => i.name === '$identify')
  expect(id?.type).toBe('event')
  expect(id?.attributes).toEqual({ plan: 'pro' })
})

test('setiap item melewati redactor sebelum masuk store maupun jaringan', async () => {
  fetchMock.mockImplementation(async () => respond(503)) // batch tetap pending di IndexedDB
  const c = make()
  c.init(opts)
  c.track('x', { note: 'budi@example.com' })
  await c.flush()
  const pending = await (await createBatchStore()).listPending()
  expect(JSON.stringify(pending)).toContain('"x"')
  expect(JSON.stringify(pending)).not.toContain('budi@example.com')
  expect(JSON.stringify(sent())).not.toContain('budi@example.com')
})

test('sampleRate 0 membuang event tetapi mempertahankan log dan item sesi', async () => {
  const c = make()
  c.init({ ...opts, sampleRate: 0 })
  c.track('dropped')
  c.log('error', 'boom')
  await c.flush()
  expect(sent().map((i) => i.name)).not.toContain('dropped')
  expect(sent().map((i) => i.message)).toContain('boom')
  expect(sent().map((i) => i.name)).toContain('session_start')
})

test('reset() memancarkan session_end dan session_start baru serta menghapus identitas', async () => {
  const c = make()
  c.init(opts)
  c.identify('usr_1')
  c.reset()
  c.track('after')
  await c.flush()
  const starts = sent().filter((i) => i.name === 'session_start')
  expect(starts).toHaveLength(2)
  expect(starts[0]?.session_id).not.toBe(starts[1]?.session_id)
  expect(sent().find((i) => i.name === 'session_end')?.session_id).toBe(starts[0]?.session_id)
  expect(sent().find((i) => i.name === 'after')?.user_id).toBeUndefined()
})

test('setContext menimpa environment di envelope', async () => {
  const c = make()
  c.init(opts)
  c.setContext('environment', 'staging')
  await c.flush()
  const all = envelopes()
  expect(all[all.length - 1]?.context.environment).toBe('staging')
})

test('captureException mencatat log error dengan stack dan breadcrumbs', async () => {
  const c = make()
  c.init(opts)
  c.addBreadcrumb({ type: 'click', data: { a: 1 } })
  c.captureException(new Error('boom'))
  await c.flush()
  const e = sent().find((i) => i.type === 'log')
  expect(e?.level).toBe('error')
  expect(e?.message).toBe('Error: boom')
  expect(typeof e?.attributes?.stack).toBe('string')
  expect(e?.attributes?.breadcrumbs).toHaveLength(1)
})

test('batch dari penyimpanan dikirim ulang saat init dengan id yang sama (idempoten)', async () => {
  const stored = createItem({ type: 'event', name: 'from_last_session' })
  const store = await createBatchStore()
  await store.put({ id: 'old', createdAt: Date.now() - 1000, bytes: 100, items: [stored] })
  const c = make()
  c.init(opts)
  await c.flush()
  expect(sent().find((i) => i.name === 'from_last_session')?.id).toBe(stored.id)
  expect(await (await createBatchStore()).listPending()).toEqual([])
})

test('413 memecah batch menjadi dua dan semua item tetap terkirim', async () => {
  fetchMock.mockImplementationOnce(async () => respond(413))
  const c = make()
  c.init(opts)
  c.track('a')
  c.track('b')
  await c.flush()
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(sent().map((i) => i.name)).toEqual(expect.arrayContaining(['a', 'b', 'session_start']))
})

test('429 dengan Retry-After menjeda pengiriman berikutnya', async () => {
  fetchMock.mockImplementation(async () => respond(429, { 'Retry-After': '60' }))
  const c = make()
  c.init(opts)
  await c.flush()
  await c.flush()
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('event online membuka jeda dan melanjutkan pengiriman', async () => {
  fetchMock.mockImplementationOnce(async () => respond(503))
  const c = make()
  c.init(opts)
  await c.flush()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  window.dispatchEvent(new Event('online'))
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
})

// Review Focus #4
test('outcome kill (401) menghentikan pengiriman berikutnya', async () => {
  fetchMock.mockImplementation(async () => respond(401))
  const c = make()
  c.init(opts)
  await c.flush()
  c.track('later')
  await c.flush()
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('pagehide mengirim lewat sendBeacon dengan api_key dan tidak memakai fetch', async () => {
  const beacon = vi.fn(() => true)
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true, writable: true })
  const c = make()
  c.init(opts)
  c.track('bye')
  window.dispatchEvent(new Event('pagehide'))
  expect(beacon).toHaveBeenCalledTimes(1)
  expect((beacon.mock.calls[0] as unknown as [string])[0]).toContain('api_key=' + KEY)
  expect(fetchMock).not.toHaveBeenCalled()
  Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true, writable: true })
})

test('shutdown melepas listener dan menghentikan pengiriman', async () => {
  const c = make()
  c.init(opts)
  c.shutdown()
  window.dispatchEvent(new Event('online'))
  window.dispatchEvent(new Event('pagehide'))
  c.track('x')
  await c.flush()
  expect(fetchMock).not.toHaveBeenCalled()
})

test('method publik tidak pernah melempar meski storage dan jaringan rusak', async () => {
  fetchMock.mockImplementation(async () => {
    throw new TypeError('offline')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  const c = make()
  expect(() => {
    c.init(opts)
    c.identify('u')
    c.track('x')
    c.log('info', 'm')
    c.captureException('string error')
    c.reset()
  }).not.toThrow()
  await expect(c.flush()).resolves.toBeUndefined()
})

test('init memasang listener error dan shutdown melepasnya', async () => {
  const c = make()
  c.init(opts)
  const err = new TypeError('wired')
  window.dispatchEvent(new ErrorEvent('error', { error: err, message: 'Uncaught TypeError: wired' }))
  await c.flush()
  expect(sent().find((i) => i.message === 'TypeError: wired')?.level).toBe('error')
  const before = sent().length
  c.shutdown()
  const swallow = (e: Event) => e.preventDefault() // cegah vitest menganggapnya uncaught exception
  window.addEventListener('error', swallow)
  window.dispatchEvent(new ErrorEvent('error', { error: new Error('after'), message: 'x' }))
  window.removeEventListener('error', swallow)
  expect(sent().length).toBe(before)
})

test('captureException menyertakan fingerprint', async () => {
  const c = make()
  c.init(opts)
  c.captureException(new Error('fp'))
  await c.flush()
  expect(typeof sent().find((i) => i.message === 'Error: fp')?.attributes?.fingerprint).toBe('string')
})

test('init memasang breadcrumb click dan page_view navigasi', async () => {
  History.prototype.pushState.call(history, null, '', '/home')
  const c = make()
  c.init(opts)
  document.body.innerHTML = '<button id="go">Lanjut</button>'
  document.getElementById('go')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  history.pushState(null, '', '/next')
  c.captureException(new Error('after click'))
  await c.flush()
  expect(sent().find((i) => i.name === 'page_view')?.attributes?.to).toContain('/next')
  const crumbs = sent().find((i) => i.message === 'Error: after click')?.attributes?.breadcrumbs as Array<{ type: string }>
  expect(crumbs.map((b) => b.type)).toEqual(['click', 'navigation'])
})
