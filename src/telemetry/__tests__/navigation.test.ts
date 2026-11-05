import { resolveConfig } from '../../core/config'
import { SessionManager } from '../../core/session'
import type { TelemetryContext } from '../../core/client'
import { BreadcrumbBuffer } from '../breadcrumbs'
import { installNavigationListeners } from '../navigation'

const cfg = resolveConfig({ appKey: 'art_live_' + '0'.repeat(32), endpoint: 'https://a.example/i' })
const rawPush = History.prototype.pushState

let emit: ReturnType<typeof vi.fn>
let buf: BreadcrumbBuffer
let off: () => void
const install = () => installNavigationListeners({ cfg, session: new SessionManager(cfg), breadcrumbs: buf, emit: emit as unknown as TelemetryContext['emit'] })
const calls = () => emit.mock.calls.map((c) => c[0] as { type: string; name: string; attributes: { from: string; to: string; referrer: string } })

beforeEach(() => {
  sessionStorage.clear()
  rawPush.call(history, null, '', '/start')
  emit = vi.fn()
  buf = new BreadcrumbBuffer(30)
  off = install()
})
afterEach(() => off())

test('pushState memancarkan event page_view dengan from dan to', () => {
  history.pushState({ a: 1 }, '', '/products?id=7')
  const [c] = calls()
  expect(c?.type).toBe('event')
  expect(c?.name).toBe('page_view')
  expect(c?.attributes.from).toContain('/start')
  expect(c?.attributes.to).toContain('/products?id=7')
  expect(buf.snapshot().map((b) => b.type)).toEqual(['navigation'])
})

test('replaceState ke URL berbeda memancarkan page_view, ke URL yang sama tidak', () => {
  history.replaceState(null, '', '/start')
  expect(emit).not.toHaveBeenCalled()
  history.replaceState(null, '', '/other')
  expect(emit).toHaveBeenCalledTimes(1)
})

test('param sensitif pada URL tujuan diredaksi', () => {
  history.pushState(null, '', '/cb?code=abc123&page=2')
  expect(calls()[0]?.attributes.to).toContain('code=[redacted]')
  expect(calls()[0]?.attributes.to).not.toContain('abc123')
})

test('popstate dan hashchange juga memancarkan page_view, tanpa duplikat', () => {
  rawPush.call(history, null, '', '/back')
  window.dispatchEvent(new PopStateEvent('popstate'))
  expect(calls()).toHaveLength(1)
  expect(calls()[0]?.attributes.to).toContain('/back')
  rawPush.call(history, null, '', '/back#/tab')
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  window.dispatchEvent(new PopStateEvent('popstate')) // hashchange + popstate untuk navigasi yang sama
  expect(calls()).toHaveLength(2)
})

test('pushState asli tetap berfungsi: state dan URL terterapkan, return value dipertahankan', () => {
  const r = history.pushState({ keep: true }, '', '/kept')
  expect(r).toBeUndefined()
  expect(history.state).toEqual({ keep: true })
  expect(location.pathname).toBe('/kept')
})

test('listener yang melempar tidak merusak navigasi aplikasi host', () => {
  emit.mockImplementation(() => {
    throw new Error('boom')
  })
  expect(() => history.pushState(null, '', '/safe')).not.toThrow()
  expect(location.pathname).toBe('/safe')
})

test('pembersih memulihkan pushState/replaceState asli dan melepas listener', () => {
  const patched = history.pushState
  off()
  expect(history.pushState).not.toBe(patched)
  history.pushState(null, '', '/after')
  window.dispatchEvent(new PopStateEvent('popstate'))
  expect(emit).not.toHaveBeenCalled()
  off = install()
})

test('pembersih tidak menimpa patch milik library lain yang dipasang belakangan', () => {
  const orig = history.pushState
  const theirs = function (this: History, ...a: Parameters<History['pushState']>) {
    return orig.apply(this, a)
  }
  history.pushState = theirs
  off()
  expect(history.pushState).toBe(theirs)
  history.pushState = orig
  off = install()
})
