import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { createBatchStore } from '../../transport/persistence'
import { ARTrackerClient } from '../client'
import type { Envelope, RawItem } from '../../types'

const KEY = 'art_live_' + '0'.repeat(32)
const opts = { appKey: KEY, endpoint: 'https://a.example/api/v1/ingest' }

let fetchMock: ReturnType<typeof vi.fn>
let clients: ARTrackerClient[]
const respond = (status: number) => new Response(null, { status })
const sent = (): RawItem[] => fetchMock.mock.calls.flatMap((c) => (JSON.parse((c[1] as RequestInit).body as string) as Envelope).items)
const make = () => {
  const c = new ARTrackerClient()
  clients.push(c)
  return c
}
const setDnt = (v: string | undefined) => Object.defineProperty(navigator, 'doNotTrack', { value: v, configurable: true })

beforeEach(() => {
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('CompressionStream', undefined)
  fetchMock = vi.fn(async () => respond(202))
  vi.stubGlobal('fetch', fetchMock)
  clients = []
})
afterEach(() => {
  clients.forEach((c) => c.shutdown())
  setDnt(undefined)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('disable() menghentikan pengumpulan, melepas patch, dan bertahan di localStorage', async () => {
  const c = make()
  c.init(opts)
  c.disable()
  expect(localStorage.getItem('ar_disabled')).toBe('1')
  expect(globalThis.fetch).toBe(fetchMock) // interceptor dilepas
  c.track('x')
  await c.flush()
  expect(fetchMock).not.toHaveBeenCalled()
})

test('disable() menghapus batch yang tertunda dari penyimpanan (opt-out = data tidak dikirim nanti)', async () => {
  fetchMock.mockImplementation(async () => respond(503))
  const c = make()
  c.init(opts)
  c.track('x')
  await c.flush()
  expect(await (await createBatchStore()).listPending()).not.toHaveLength(0)
  c.disable()
  await vi.waitFor(async () => expect(await (await createBatchStore()).listPending()).toHaveLength(0))
})

test('localStorage ar_disabled=1 membuat init menjadi no-op', async () => {
  localStorage.setItem('ar_disabled', '1')
  const c = make()
  c.init(opts)
  c.track('x')
  await c.flush()
  expect(fetchMock).not.toHaveBeenCalled()
  expect(globalThis.fetch).toBe(fetchMock) // tidak ada patch terpasang
})

test('disable() sebelum init membuang buffer pre-init dan membuat init berikutnya no-op', async () => {
  const c = make()
  c.track('early')
  c.disable()
  c.init(opts)
  await c.flush()
  expect(fetchMock).not.toHaveBeenCalled()
})

test('enable() menghapus flag dan melanjutkan dengan opsi init terakhir', async () => {
  const c = make()
  c.init(opts)
  c.disable()
  c.enable()
  expect(localStorage.getItem('ar_disabled')).toBeNull()
  c.track('back')
  await c.flush()
  expect(sent().map((i) => i.name)).toContain('back')
})

test('enable() tanpa init sebelumnya hanya menghapus flag', () => {
  localStorage.setItem('ar_disabled', '1')
  const c = make()
  expect(() => c.enable()).not.toThrow()
  expect(localStorage.getItem('ar_disabled')).toBeNull()
})

test('respectDoNotTrack mematikan SDK saat navigator.doNotTrack = "1"', async () => {
  setDnt('1')
  const c = make()
  c.init({ ...opts, respectDoNotTrack: true })
  c.track('x')
  await c.flush()
  expect(fetchMock).not.toHaveBeenCalled()
})

test('DNT diabaikan secara default (opt-in), dan nilai "0" tidak mematikan', async () => {
  setDnt('1')
  const a = make()
  a.init(opts)
  await a.flush()
  expect(fetchMock).toHaveBeenCalled()
  a.shutdown()
  fetchMock.mockClear()
  setDnt('0')
  const b = make()
  b.init({ ...opts, respectDoNotTrack: true })
  await b.flush()
  expect(fetchMock).toHaveBeenCalled()
})

test('disable/enable tidak pernah melempar meski storage diblokir', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  const c = make()
  c.init(opts)
  expect(() => {
    c.disable()
    c.enable()
  }).not.toThrow()
})

test('event yang dipanggil SAAT opt-out tidak ikut terkirim setelah enable()', async () => {
  const c = make()
  c.init(opts)
  c.disable()
  c.track('while_disabled')
  c.enable()
  c.track('after_enable')
  await c.flush()
  const names = sent().map((i) => i.name)
  expect(names).toContain('after_enable')
  expect(names).not.toContain('while_disabled')
})

test('event yang dipanggil saat DNT aktif tidak ditampung', async () => {
  setDnt('1')
  const c = make()
  c.init({ ...opts, respectDoNotTrack: true })
  c.track('under_dnt')
  setDnt(undefined)
  c.init({ ...opts, respectDoNotTrack: true })
  await c.flush()
  expect(sent().map((i) => i.name)).not.toContain('under_dnt')
})
