import { resolveConfig } from '../../core/config'
import { SessionManager } from '../../core/session'
import type { TelemetryContext } from '../../core/client'
import { BreadcrumbBuffer } from '../breadcrumbs'
import { buildErrorReport, fingerprintError, installErrorListeners } from '../errors'

const cfg = resolveConfig({ appKey: 'art_live_' + '0'.repeat(32), endpoint: 'https://a.example/i' })
const stackA = 'TypeError: x is not a function\n    at checkout (https://a/app.js?v=1:142:9)\n    at onClick (https://a/app.js:10:1)'
const stackB = 'TypeError: x is not a function\n    at other (https://a/other.js:5:5)\n    at onClick (https://a/app.js:10:1)'

let emit: ReturnType<typeof vi.fn>
let breadcrumbs: BreadcrumbBuffer
let off: () => void

const ctx = (): TelemetryContext => ({ cfg, session: new SessionManager(cfg), breadcrumbs, emit: emit as unknown as TelemetryContext['emit'] })

/** Vitest menganggap ErrorEvent tanpa listener pengguna sebagai uncaught exception; penampung ini mencegahnya. */
const swallow = (fn: () => void) => {
  const noop = (e: Event) => e.preventDefault()
  window.addEventListener('error', noop)
  try {
    fn()
  } finally {
    window.removeEventListener('error', noop)
  }
}
const errorEvent = (error: unknown, extra: ErrorEventInit = {}) =>
  new ErrorEvent('error', { error, message: error instanceof Error ? `Uncaught ${error.name}: ${error.message}` : String(error), ...extra })
const rejection = (reason: unknown) => Object.assign(new Event('unhandledrejection'), { reason, promise: Promise.resolve() })
const lastCall = () => emit.mock.calls[emit.mock.calls.length - 1]?.[0] as { type: string; level?: string; name?: string; message?: string; attributes: Record<string, unknown> }

beforeEach(() => {
  sessionStorage.clear()
  emit = vi.fn()
  breadcrumbs = new BreadcrumbBuffer(30)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_700_000_000_000)
  off = installErrorListeners(ctx())
})
afterEach(() => {
  off()
  vi.useRealTimers()
})

test('window error menghasilkan item log level error dengan atribut lengkap', () => {
  const err = new TypeError('x is not a function')
  err.stack = stackA
  window.dispatchEvent(errorEvent(err, { filename: 'https://a/app.js', lineno: 142, colno: 9 }))
  const item = lastCall()
  expect(item.type).toBe('log')
  expect(item.level).toBe('error')
  expect(item.message).toBe('TypeError: x is not a function')
  expect(item.attributes).toMatchObject({ kind: 'error', filename: 'https://a/app.js', lineno: 142, colno: 9 })
  expect(typeof item.attributes.fingerprint).toBe('string')
  expect(item.attributes.stack).toBe(stackA)
})

test('error non-Error (string dilempar) tetap dicatat dari event.message', () => {
  window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }))
  expect(lastCall().message).toBe('Script error.')
})

test('unhandledrejection menandai attributes.kind untuk reason Error maupun non-Error', () => {
  window.dispatchEvent(rejection(new RangeError('bad range')))
  expect(lastCall().message).toBe('RangeError: bad range')
  expect(lastCall().attributes.kind).toBe('unhandledrejection')
  window.dispatchEvent(rejection('plain string'))
  expect(lastCall().message).toBe('UnhandledRejection: plain string')
  window.dispatchEvent(rejection({ code: 42 }))
  expect(lastCall().message).toContain('42')
})

test('error pada img menghasilkan resource_error level warn dengan url ter-scrub', () => {
  const img = document.createElement('img')
  img.src = 'https://a.example/x.png?token=abc&v=2'
  document.body.appendChild(img)
  img.dispatchEvent(new Event('error'))
  const item = lastCall()
  expect(item.name).toBe('resource_error')
  expect(item.level).toBe('warn')
  expect(item.attributes.tag).toBe('img')
  expect(String(item.attributes.url)).toContain('token=[redacted]')
  expect(String(item.attributes.url)).not.toContain('abc')
  img.remove()
})

test('event error pada elemen non-resource diabaikan', () => {
  const div = document.createElement('div')
  document.body.appendChild(div)
  div.dispatchEvent(new Event('error'))
  expect(emit).not.toHaveBeenCalled()
  div.remove()
})

test('stack dipotong ke 16 KB', () => {
  const err = new Error('big')
  err.stack = 'Error: big\n' + '    at f (x.js:1:1)\n'.repeat(5000)
  window.dispatchEvent(errorEvent(err))
  expect(String(lastCall().attributes.stack).length).toBeLessThanOrEqual(16 * 1024)
})

test('breadcrumbs terkini dilampirkan', () => {
  breadcrumbs.add({ type: 'click', at: 1, data: { selector: 'button#pay' } })
  window.dispatchEvent(errorEvent(new Error('x')))
  expect(lastCall().attributes.breadcrumbs).toEqual([{ type: 'click', at: 1, data: { selector: 'button#pay' } }])
})

test('error identik dalam 10 detik hanya dikirim sekali, lalu boleh lagi', () => {
  const err = new TypeError('x is not a function')
  err.stack = stackA
  window.dispatchEvent(errorEvent(err))
  window.dispatchEvent(errorEvent(err))
  expect(emit).toHaveBeenCalledTimes(1)
  vi.setSystemTime(1_700_000_000_000 + 10_001)
  window.dispatchEvent(errorEvent(err))
  expect(emit).toHaveBeenCalledTimes(2)
})

test('circuit breaker berhenti setelah 20 error per menit dan pulih di menit berikutnya', () => {
  for (let i = 0; i < 25; i++) {
    const e = new Error('e' + i)
    e.stack = `Error: e${i}\n    at f${i} (x.js:${i}:1)`
    window.dispatchEvent(errorEvent(e))
  }
  expect(emit).toHaveBeenCalledTimes(20)
  vi.setSystemTime(1_700_000_000_000 + 60_001)
  const e = new Error('later')
  e.stack = 'Error: later\n    at g (y.js:1:1)'
  window.dispatchEvent(errorEvent(e))
  expect(emit).toHaveBeenCalledTimes(21)
})

test('listener dilepas setelah fungsi pembersih dipanggil', () => {
  off()
  swallow(() => window.dispatchEvent(errorEvent(new Error('x'))))
  window.dispatchEvent(rejection(new Error('y')))
  expect(emit).not.toHaveBeenCalled()
})

test('emit yang melempar tidak merusak aplikasi host', () => {
  emit.mockImplementation(() => {
    throw new Error('boom')
  })
  expect(() => window.dispatchEvent(errorEvent(new Error('x')))).not.toThrow()
})

test('fingerprint stabil untuk nama dan frame teratas yang sama, tanpa query string', () => {
  const a = fingerprintError('TypeError', stackA)
  expect(a).toBe(fingerprintError('TypeError', stackA.replace('?v=1', '?v=999')))
  expect(a).not.toBe(fingerprintError('TypeError', stackB))
  expect(a).not.toBe(fingerprintError('RangeError', stackA))
  expect(fingerprintError('Error', undefined)).toMatch(/^[0-9a-f]{8}$/)
})

test('buildErrorReport menangani nilai non-Error dan memotong stack', () => {
  const r = buildErrorReport('oops', new BreadcrumbBuffer(5), { extra: 1 })
  expect(r.message).toBe('Error: oops')
  expect(r.attributes).toMatchObject({ extra: 1, kind: 'captured' })
  expect(Array.isArray(r.attributes.breadcrumbs)).toBe(true)
})
