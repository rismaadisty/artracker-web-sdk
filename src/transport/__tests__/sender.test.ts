import { resolveConfig } from '../../core/config'
import { buildEnvelope, createItem } from '../../core/envelope'
import { Sender } from '../sender'

const cfg = resolveConfig({ appKey: 'art_live_' + '0'.repeat(32), endpoint: 'https://a.example/api/v1/ingest' })
const envOf = (attrs?: Record<string, unknown>) =>
  buildEnvelope([createItem({ type: 'event', name: 'x', attributes: attrs })], cfg, { environment: 'production' }, Date.now())

/** > 60 KB: item dipangkas 24 KB, jadi payload besar harus dibuat dari beberapa item. */
const bigEnv = () =>
  buildEnvelope(
    Array.from({ length: 4 }, () => createItem({ type: 'event', name: 'big', attributes: { blob: 'x'.repeat(20_000) } })),
    cfg,
    {},
    Date.now(),
  )

let fetchMock: ReturnType<typeof vi.fn>
const respond = (status: number, headers?: Record<string, string>) => new Response(null, { status, headers })

beforeEach(() => {
  fetchMock = vi.fn(async () => respond(202))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('POST memakai header X-Artracker-Key, endpoint, dan keepalive', async () => {
  const s = new Sender(cfg)
  expect(await s.send(envOf())).toEqual({ kind: 'accepted' })
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  expect(url).toBe(cfg.endpoint)
  expect(init.method).toBe('POST')
  expect(init.keepalive).toBe(true)
  expect((init.headers as Record<string, string>)['X-Artracker-Key']).toBe(cfg.appKey)
  expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  expect(init.credentials).toBe('omit')
  s.dispose()
})

test('menyetel Content-Encoding gzip hanya saat terkompresi', async () => {
  const s = new Sender(cfg)
  await s.send(envOf())
  expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toHaveProperty('Content-Encoding', 'gzip')
  vi.stubGlobal('CompressionStream', undefined)
  const plain = new Sender(cfg)
  await plain.send(envOf())
  expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).not.toHaveProperty('Content-Encoding')
  s.dispose()
  plain.dispose()
})

test('body di atas 60 KB tidak memakai keepalive (batas browser 64 KB)', async () => {
  vi.stubGlobal('CompressionStream', undefined)
  const s = new Sender(cfg)
  await s.send(bigEnv())
  expect((fetchMock.mock.calls[0]?.[1] as RequestInit).keepalive).toBe(false)
  s.dispose()
})

test('mengembalikan outcome sesuai status dan menghormati Retry-After', async () => {
  const s = new Sender(cfg)
  fetchMock.mockResolvedValueOnce(respond(429, { 'Retry-After': '7' }))
  expect(await s.send(envOf())).toEqual({ kind: 'retry', afterMs: 7000 })
  fetchMock.mockResolvedValueOnce(respond(401))
  expect((await s.send(envOf())).kind).toBe('kill')
  fetchMock.mockResolvedValueOnce(respond(413))
  expect((await s.send(envOf())).kind).toBe('split')
  fetchMock.mockResolvedValueOnce(respond(400))
  expect((await s.send(envOf())).kind).toBe('drop')
  s.dispose()
})

test('error jaringan menghasilkan outcome retry, bukan lemparan', async () => {
  fetchMock.mockRejectedValue(new TypeError('failed'))
  const s = new Sender(cfg)
  const o = await s.send(envOf())
  expect(o.kind).toBe('retry')
  s.dispose()
})

test('jeda retry membesar pada kegagalan beruntun dan direset setelah accepted', async () => {
  const s = new Sender(cfg)
  fetchMock.mockResolvedValue(respond(500))
  const a = await s.send(envOf())
  const b = await s.send(envOf())
  const c = await s.send(envOf())
  const ms = (o: { kind: string; afterMs?: number }) => o.afterMs ?? 0
  expect(ms(c)).toBeGreaterThan(ms(a))
  expect(ms(b)).toBeGreaterThanOrEqual(48_000) // 30s * 2 * 0.8
  fetchMock.mockResolvedValue(respond(202))
  await s.send(envOf())
  fetchMock.mockResolvedValue(respond(500))
  const d = await s.send(envOf())
  expect(ms(d)).toBeLessThanOrEqual(36_000)
  s.dispose()
})

test('fetch yang dipakai adalah referensi saat konstruksi, bukan yang dipatch belakangan', async () => {
  const s = new Sender(cfg)
  const patched = vi.fn(async () => respond(202))
  vi.stubGlobal('fetch', patched)
  await s.send(envOf())
  expect(patched).not.toHaveBeenCalled()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  s.dispose()
})

describe('sendOnUnload', () => {
  let beacon: ReturnType<typeof vi.fn>
  beforeEach(() => {
    beacon = vi.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true, writable: true })
  })

  test('memakai sendBeacon dengan api_key di query dan Blob text/plain', () => {
    const s = new Sender(cfg)
    expect(s.sendOnUnload(envOf())).toBe(true)
    const [url, blob] = beacon.mock.calls[0] as [string, Blob]
    expect(url).toBe(cfg.endpoint + '?api_key=' + cfg.appKey)
    expect(blob.type).toBe('text/plain')
    s.dispose()
  })

  test('mengembalikan false dan tidak mengirim saat payload melebihi 60 KB', () => {
    const s = new Sender(cfg)
    expect(s.sendOnUnload(bigEnv())).toBe(false)
    expect(beacon).not.toHaveBeenCalled()
    s.dispose()
  })

  test('mengembalikan false bila sendBeacon tidak ada atau melempar', () => {
    const s = new Sender(cfg)
    Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true, writable: true })
    expect(s.sendOnUnload(envOf())).toBe(false)
    Object.defineProperty(navigator, 'sendBeacon', {
      value: () => {
        throw new Error('x')
      },
      configurable: true,
      writable: true,
    })
    expect(s.sendOnUnload(envOf())).toBe(false)
    s.dispose()
  })

  test('menambahkan api_key dengan & bila endpoint sudah punya query', () => {
    const s = new Sender(resolveConfig({ appKey: cfg.appKey, endpoint: 'https://a.example/i?x=1' }))
    s.sendOnUnload(envOf())
    expect((beacon.mock.calls[0] as [string])[0]).toBe('https://a.example/i?x=1&api_key=' + cfg.appKey)
    s.dispose()
  })
})
