import { ARTrackerConfigError, resolveConfig } from '../config'
import { safeCall } from '../safe'

const VALID_KEY = 'art_live_' + '0'.repeat(32)
const base = { appKey: VALID_KEY, endpoint: 'https://a.example/api/v1/ingest' }

test('menolak appKey dengan prefix art_sec_', () => {
  expect(() =>
    resolveConfig({ appKey: 'art_sec_x'.padEnd(40, '0'), endpoint: base.endpoint }),
  ).toThrow(ARTrackerConfigError)
})

test('menolak appKey atau endpoint yang hilang', () => {
  expect(() => resolveConfig({ endpoint: base.endpoint } as never)).toThrow(ARTrackerConfigError)
  expect(() => resolveConfig({ appKey: VALID_KEY } as never)).toThrow(ARTrackerConfigError)
})

test('menolak appKey di luar panjang 32-128 dan endpoint bukan URL absolut', () => {
  expect(() => resolveConfig({ appKey: 'art_live_short', endpoint: base.endpoint })).toThrow(
    ARTrackerConfigError,
  )
  expect(() => resolveConfig({ appKey: VALID_KEY, endpoint: '/relative' })).toThrow(
    ARTrackerConfigError,
  )
})

test('mengisi default sesuai ARCHITECTURE §3.1', () => {
  const c = resolveConfig(base)
  expect(c.replay.enabled).toBe(false)
  expect(c.replay.sampleRate).toBe(0.1)
  expect(c.batch).toEqual({ maxItems: 50, maxBytes: 131072, flushIntervalMs: 5000 })
  expect(c.environment).toBe('production')
  expect(c.privacy.maskAllInputs).toBe(true)
  expect(c.offline).toEqual({ maxQueueBytes: 5 * 1024 * 1024, maxAgeMs: 7 * 24 * 3600 * 1000 })
  expect(c.respectDoNotTrack).toBe(false)
})

test('menjepit nilai di luar rentang', () => {
  expect(resolveConfig({ ...base, sampleRate: 5 }).sampleRate).toBe(1)
  expect(resolveConfig({ ...base, sampleRate: -1 }).sampleRate).toBe(0)
  expect(resolveConfig({ ...base, batch: { maxItems: 9999 } }).batch.maxItems).toBe(50)
  expect(resolveConfig({ ...base, batch: { maxBytes: 10 } }).batch.maxBytes).toBe(1024)
})

test('safeCall menelan error dan mengembalikan undefined', () => {
  expect(
    safeCall(
      () => {
        throw new Error('x')
      },
      false,
      'test',
    ),
  ).toBeUndefined()
})

test('safeCall mencetak peringatan hanya saat debug aktif', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  safeCall(() => { throw new Error('x') }, false, 'quiet')
  expect(warn).not.toHaveBeenCalled()
  safeCall(() => { throw new Error('x') }, true, 'loud')
  expect(warn).toHaveBeenCalledTimes(1)
  expect(String(warn.mock.calls[0]?.[0])).toContain('[artracker] loud')
  warn.mockRestore()
})

test('safeCall mengembalikan nilai fungsi saat sukses', () => {
  expect(safeCall(() => 42, false, 'ok')).toBe(42)
})
