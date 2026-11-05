import { buildContext, collectDeviceMeta } from '../context'
import { resolveConfig } from '../config'

const cfg = resolveConfig({
  appKey: 'art_live_' + '0'.repeat(32),
  endpoint: 'https://a.example/i',
  appVersion: '2.4.1',
})

test('buildContext memuat environment, app_version, dan sdk_platform web', () => {
  expect(buildContext(cfg)).toMatchObject({
    environment: 'production',
    app_version: '2.4.1',
    sdk_platform: 'web',
  })
})

test('buildContext tidak memuat query string atau hash pada page (hindari PII)', () => {
  window.history.replaceState({}, '', '/checkout?email=budi@example.com#token=abc')
  const ctx = buildContext(cfg)
  expect(String(ctx.page)).not.toContain('budi@example.com')
  expect(String(ctx.page)).not.toContain('token=abc')
  expect(String(ctx.page)).toContain('/checkout')
})

test('collectDeviceMeta mengembalikan field metadata sesi', () => {
  expect(Object.keys(collectDeviceMeta())).toEqual(
    expect.arrayContaining(['referrer', 'entry_url', 'screen', 'viewport', 'ua', 'lang', 'tz']),
  )
})

test('collectDeviceMeta tidak melempar saat navigator dan screen minim', () => {
  vi.stubGlobal('navigator', {})
  vi.stubGlobal('screen', undefined)
  expect(() => collectDeviceMeta()).not.toThrow()
  vi.unstubAllGlobals()
})
