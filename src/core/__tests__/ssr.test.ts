// @vitest-environment node
import { ARTracker } from '../../index'

// Environment node sungguhan: window/document/localStorage tidak ada. Mengimpor modul pun tidak boleh melempar.
const opts = { appKey: 'art_live_' + '0'.repeat(32), endpoint: 'https://a.example/api/v1/ingest' }

test('tidak ada window di environment ini', () => {
  expect(typeof window).toBe('undefined')
})

test('seluruh method publik menjadi no-op tanpa melempar di server', async () => {
  expect(() => {
    ARTracker.init(opts)
    ARTracker.identify('u', { a: 1 })
    ARTracker.track('x', { a: 1 })
    ARTracker.log('info', 'm')
    ARTracker.captureException(new Error('x'))
    ARTracker.setContext('k', 'v')
    ARTracker.addBreadcrumb({ type: 't' })
    ARTracker.startReplay()
    ARTracker.stopReplay()
    ARTracker.reset()
    ARTracker.disable()
    ARTracker.enable()
    ARTracker.shutdown()
  }).not.toThrow()
  await expect(ARTracker.flush()).resolves.toBeUndefined()
})
