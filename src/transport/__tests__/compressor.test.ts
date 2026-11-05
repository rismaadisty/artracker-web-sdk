import { gunzipSync } from 'node:zlib'
import { resolveConfig } from '../../core/config'
import { createCompressor } from '../compressor'

const base = { appKey: 'art_live_' + '0'.repeat(32), endpoint: 'https://a.example/i' }
const cfg = resolveConfig(base)
const JSON_TEXT = JSON.stringify({ a: 1, msg: 'halo '.repeat(200) })

const bytesOf = (body: BodyInit): Buffer => Buffer.from(body as Uint8Array)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('memakai CompressionStream di main thread dan menandai encoding gzip', async () => {
  const c = createCompressor(cfg)
  const r = await c.compress(JSON_TEXT)
  expect(r.encoding).toBe('gzip')
  const b = bytesOf(r.body)
  expect(b[0]).toBe(0x1f)
  expect(b[1]).toBe(0x8b)
  expect(gunzipSync(b).toString()).toBe(JSON_TEXT)
  c.dispose()
})

test('fallback ke JSON polos saat CompressionStream tidak ada', async () => {
  vi.stubGlobal('CompressionStream', undefined)
  const r = await createCompressor(cfg).compress('{"a":1}')
  expect(r).toEqual({ body: '{"a":1}', encoding: null })
})

test('fallback ke main thread saat konstruktor Worker melempar', async () => {
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('CSP blocks worker')
      }
    },
  )
  const r = await createCompressor(resolveConfig({ ...base, workerUrl: 'https://a.example/w.js' })).compress(JSON_TEXT)
  expect(r.encoding).toBe('gzip')
})

test('compress tidak pernah melempar saat CompressionStream rusak', async () => {
  vi.stubGlobal(
    'CompressionStream',
    class {
      constructor() {
        throw new Error('boom')
      }
    },
  )
  const r = await createCompressor(cfg).compress('{"a":1}')
  expect(r).toEqual({ body: '{"a":1}', encoding: null })
})

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  terminated = false
  posted: Array<{ id: number; json: string }> = []
  constructor(public url: string) {
    FakeWorker.instances.push(this)
  }
  postMessage(msg: { id: number; json: string }) {
    this.posted.push(msg)
    const buf = new Uint8Array([0x1f, 0x8b, 9, 9]).buffer
    queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, buf } } as MessageEvent))
  }
  terminate() {
    this.terminated = true
  }
}

test('memakai Worker bila tersedia dan mengikuti protokol {id,json} -> {id,buf}', async () => {
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
  const c = createCompressor(resolveConfig({ ...base, workerUrl: 'https://a.example/w.js' }))
  const r = await c.compress('{"a":1}')
  expect(r.encoding).toBe('gzip')
  expect(bytesOf(r.body)).toEqual(Buffer.from([0x1f, 0x8b, 9, 9]))
  expect(FakeWorker.instances[0]?.url).toBe('https://a.example/w.js')
  expect(FakeWorker.instances[0]?.posted[0]?.json).toBe('{"a":1}')
  c.dispose()
  expect(FakeWorker.instances[0]?.terminated).toBe(true)
})

test('error pada Worker menurunkan tingkat ke main thread secara permanen', async () => {
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
  const c = createCompressor(resolveConfig({ ...base, workerUrl: 'https://a.example/w.js' }))
  const first = c.compress(JSON_TEXT)
  FakeWorker.instances[0]?.onerror?.(new Error('worker crashed'))
  expect((await first).encoding).toBe('gzip')
  await c.compress(JSON_TEXT)
  expect(FakeWorker.instances).toHaveLength(1) // tidak membuat worker baru
  c.dispose()
})

test('Worker yang tidak membalas dalam 5 detik jatuh ke main thread', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  class SilentWorker extends FakeWorker {
    override postMessage(msg: { id: number; json: string }) {
      this.posted.push(msg)
    }
  }
  vi.stubGlobal('Worker', SilentWorker)
  const c = createCompressor(resolveConfig({ ...base, workerUrl: 'https://a.example/w.js' }))
  const p = c.compress(JSON_TEXT)
  await vi.advanceTimersByTimeAsync(5000) // timeout worker -> downgrade
  await vi.advanceTimersByTimeAsync(10) // jadwal idle main-thread yang dibuat setelahnya
  const r = await p
  expect(r.encoding).toBe('gzip')
  expect(gunzipSync(bytesOf(r.body)).toString()).toBe(JSON_TEXT)
  c.dispose()
})

test('workerSource() self-contained: dijalankan dengan self palsu menghasilkan gzip valid', async () => {
  const { workerSource } = await import('../worker/gzip.worker')
  const posted: Array<{ id: number; buf?: ArrayBuffer }> = []
  const fakeSelf: { onmessage: ((e: { data: { id: number; json: string } }) => Promise<void>) | null; postMessage: (m: { id: number; buf?: ArrayBuffer }) => void } = {
    onmessage: null,
    postMessage: (m) => void posted.push(m),
  }
  new Function('self', workerSource())(fakeSelf)
  await fakeSelf.onmessage?.({ data: { id: 7, json: JSON_TEXT } })
  expect(posted[0]?.id).toBe(7)
  expect(gunzipSync(Buffer.from(posted[0]?.buf as ArrayBuffer)).toString()).toBe(JSON_TEXT)
})
