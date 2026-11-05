import { resolveConfig } from '../../core/config'
import { SessionManager } from '../../core/session'
import type { TelemetryContext } from '../../core/client'
import { BreadcrumbBuffer } from '../breadcrumbs'
import { installNetworkInterceptors } from '../network'

const ENDPOINT = 'https://a.example/api/v1/ingest'
const base = { appKey: 'art_live_' + '0'.repeat(32), endpoint: ENDPOINT }

type Emitted = { type: string; level: string; name: string; message: string; attributes: Record<string, unknown> }
let emit: ReturnType<typeof vi.fn>
let buf: BreadcrumbBuffer
let underlying: ReturnType<typeof vi.fn>
let off: () => void

const install = (extra: Partial<Parameters<typeof resolveConfig>[0]> = {}) => {
  const cfg = resolveConfig({ ...base, ...extra })
  off = installNetworkInterceptors({ cfg, session: new SessionManager(cfg), breadcrumbs: buf, emit: emit as unknown as TelemetryContext['emit'] })
}
const items = () => emit.mock.calls.map((c) => c[0] as Emitted)
const respond = (status: number, body = '{"ok":true}') => new Response(body, { status, headers: { 'content-length': String(body.length) } })

class FakeXHR extends EventTarget {
  status = 0
  nextStatus = 201
  open(_method: string, _url: string | URL): void {}
  send(_body?: unknown): void {
    setTimeout(() => {
      this.status = this.nextStatus
      this.dispatchEvent(new Event('loadend'))
    }, 5)
  }
}

beforeEach(() => {
  sessionStorage.clear()
  emit = vi.fn()
  buf = new BreadcrumbBuffer(30)
  underlying = vi.fn(async () => respond(200))
  vi.stubGlobal('fetch', underlying)
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
})
afterEach(() => {
  off?.()
  vi.unstubAllGlobals()
})

test('fetch menghasilkan item http_request dengan method, status, dan duration_ms', async () => {
  install()
  await fetch('https://api.example/items', { method: 'POST', body: 'hello' })
  const [i] = items()
  expect(i?.type).toBe('log')
  expect(i?.name).toBe('http_request')
  expect(i?.level).toBe('info')
  expect(i?.message).toBe('POST https://api.example/items → 200')
  expect(i?.attributes).toMatchObject({ method: 'POST', url: 'https://api.example/items', status: 200 })
  expect(typeof i?.attributes.duration_ms).toBe('number')
  expect(i?.attributes.req_bytes).toBe(5)
  expect(i?.attributes.res_bytes).toBe(11)
})

test('level mengikuti status: <400 info, 4xx warn, 5xx error', async () => {
  install()
  for (const s of [200, 404, 502]) {
    underlying.mockResolvedValueOnce(respond(s, ''))
    await fetch('https://api.example/x')
  }
  expect(items().map((i) => i.level)).toEqual(['info', 'warn', 'error'])
})

// Review Focus #2
test('menerima Request object dan URL, bukan hanya string, tanpa mengonsumsi body Request', async () => {
  install()
  const req = new Request('https://api.example/a', { method: 'POST', body: 'payload' })
  await fetch(req)
  await fetch(new URL('https://api.example/b'))
  expect(items().map((i) => i.attributes.method)).toEqual(['POST', 'GET'])
  expect(items().map((i) => i.attributes.url)).toEqual(['https://api.example/a', 'https://api.example/b'])
  expect(req.bodyUsed).toBe(false)
})

test('argumen diteruskan apa adanya ke fetch yang sudah ada dan Response dikembalikan utuh', async () => {
  install()
  const init = { method: 'PUT' }
  const res = await fetch('https://api.example/x', init)
  expect(underlying.mock.calls[0]?.[0]).toBe('https://api.example/x')
  expect(underlying.mock.calls[0]?.[1]).toBe(init)
  expect(await res.json()).toEqual({ ok: true }) // body tidak dibaca/dikonsumsi oleh SDK
})

test('URL relatif diselesaikan terhadap lokasi halaman', async () => {
  install()
  await fetch('/api/me')
  expect(String(items()[0]?.attributes.url)).toBe(`${location.origin}/api/me`)
})

test('fetch yang reject tetap reject ke pemanggil dan tercatat sebagai error', async () => {
  install()
  underlying.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  await expect(fetch('https://api.example/x')).rejects.toThrow('Failed to fetch')
  await Promise.resolve()
  const [i] = items()
  expect(i?.level).toBe('error')
  expect(i?.attributes).toMatchObject({ status: 0, error: 'Failed to fetch' })
})

test('request ke endpoint ingest tidak dicatat (anti-rekursi), termasuk dengan query api_key', async () => {
  install()
  await fetch(ENDPOINT, { method: 'POST' })
  await fetch(`${ENDPOINT}?api_key=${base.appKey}`, { method: 'POST' })
  expect(emit).not.toHaveBeenCalled()
})

test('ignoreUrls (string dan RegExp) dikecualikan', async () => {
  install({ network: { ignoreUrls: ['/healthz', /\/metrics$/] } })
  await fetch('https://api.example/healthz')
  await fetch('https://api.example/metrics')
  await fetch('https://api.example/items')
  expect(items()).toHaveLength(1)
})

test('url dicatat dalam bentuk ter-scrub', async () => {
  install()
  await fetch('https://api.example/x?token=abc&page=1')
  expect(items()[0]?.attributes.url).toBe('https://api.example/x?token=[redacted]&page=1')
  expect(JSON.stringify(items())).not.toContain('abc')
})

test('menambahkan breadcrumb http', async () => {
  install()
  await fetch('https://api.example/x')
  expect(buf.snapshot()[0]).toMatchObject({ type: 'http', data: { method: 'GET', status: 200 } })
})

test('emit yang melempar tidak mengganggu fetch aplikasi host', async () => {
  install()
  emit.mockImplementation(() => {
    throw new Error('boom')
  })
  await expect(fetch('https://api.example/x')).resolves.toBeInstanceOf(Response)
})

test('XHR mencatat status dan latency via loadend dengan url ter-scrub', async () => {
  install()
  const x = new XMLHttpRequest()
  x.open('POST', 'https://api.example/x?token=abc')
  x.send('body')
  await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1))
  expect(items()[0]).toMatchObject({ name: 'http_request', level: 'info' })
  expect(items()[0]?.attributes).toMatchObject({ method: 'POST', status: 201, url: 'https://api.example/x?token=[redacted]' })
  expect(typeof items()[0]?.attributes.duration_ms).toBe('number')
})

test('XHR status 0 (gagal jaringan) dicatat sebagai error; XHR ke endpoint ingest diabaikan', async () => {
  install()
  const bad = new XMLHttpRequest() as unknown as FakeXHR
  bad.nextStatus = 0
  bad.open('GET', 'https://api.example/x')
  bad.send()
  const own = new XMLHttpRequest()
  own.open('POST', ENDPOINT)
  own.send()
  await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1))
  await new Promise((r) => setTimeout(r, 20))
  expect(items()).toHaveLength(1)
  expect(items()[0]?.level).toBe('error')
})

test('fetch dan XHR asli dipulihkan setelah pembersihan', async () => {
  const origOpen = FakeXHR.prototype.open
  install()
  expect(globalThis.fetch).not.toBe(underlying)
  off()
  expect(globalThis.fetch).toBe(underlying)
  expect(FakeXHR.prototype.open).toBe(origOpen)
  await fetch('https://api.example/x')
  expect(emit).not.toHaveBeenCalled()
  install()
})

test('pembersih tidak menimpa patch fetch library lain yang dipasang belakangan', async () => {
  install()
  const theirs = vi.fn(globalThis.fetch)
  globalThis.fetch = theirs as typeof fetch
  off()
  expect(globalThis.fetch).toBe(theirs)
  await fetch('https://api.example/x') // lewat rantai: theirs -> wrapper kita (pass-through, tidak aktif)
  expect(emit).not.toHaveBeenCalled()
  globalThis.fetch = underlying as unknown as typeof fetch
  install()
})
