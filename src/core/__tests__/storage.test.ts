import { safeStorage } from '../storage'
import { uuidv7 } from '../uuid'

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
  localStorage.clear()
})

test('menulis dan membaca lewat storage nyata saat tersedia', () => {
  const s = safeStorage('local')
  s.set('k', 'v')
  expect(localStorage.getItem('k')).toBe('v')
  expect(s.get('k')).toBe('v')
  s.remove('k')
  expect(s.get('k')).toBeNull()
})

// Review Focus #1
test('fallback ke memori saat storage melempar', () => {
  vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
    throw new Error('blocked')
  })
  const s = safeStorage('session')
  expect(() => s.set('k', 'v')).not.toThrow()
  expect(s.get('k')).toBe('v')
  expect(() => s.remove('k')).not.toThrow()
  expect(s.get('k')).toBeNull()
})

test('fallback ke memori saat setItem melempar (kuota penuh)', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('quota', 'QuotaExceededError')
  })
  const s = safeStorage('local')
  expect(() => s.set('k', 'v')).not.toThrow()
  expect(s.get('k')).toBe('v')
})

test('uuidv7 berformat versi 7 dan variant RFC 4122', () => {
  expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('uuidv7 mengurut menurut waktu pembuatan', () => {
  const spy = vi.spyOn(Date, 'now')
  spy.mockReturnValue(1_700_000_000_000)
  const a = uuidv7()
  spy.mockReturnValue(1_700_000_000_001)
  const b = uuidv7()
  expect(a.slice(0, 13) < b.slice(0, 13)).toBe(true)
})

test('uuidv7 unik pada 1000 pemanggilan', () => {
  expect(new Set(Array.from({ length: 1000 }, uuidv7)).size).toBe(1000)
})
