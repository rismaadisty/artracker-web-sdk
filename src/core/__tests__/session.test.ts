import { resolveConfig } from '../config'
import { SessionManager } from '../session'

const cfg = resolveConfig({ appKey: 'art_live_' + '0'.repeat(32), endpoint: 'https://a.example/i' })
const MIN = 60_000

let t = 1_700_000_000_000
const clock = () => t

beforeEach(() => {
  t = 1_700_000_000_000
  sessionStorage.clear()
  localStorage.clear()
})

test('id berawalan ses_ dan panjang <= 128', () => {
  const id = new SessionManager(cfg, clock).id
  expect(id).toMatch(/^ses_[0-9a-f]{32}$/)
  expect(id.length).toBeLessThanOrEqual(128)
})

test('mempertahankan id di sessionStorage pada instance kedua', () => {
  expect(new SessionManager(cfg, clock).id).toBe(new SessionManager(cfg, clock).id)
})

test('rotasi setelah idle 30 menit', () => {
  const m = new SessionManager(cfg, clock)
  const first = m.id
  t += 30 * MIN + 1
  m.touch()
  expect(m.id).not.toBe(first)
})

test('tidak rotasi bila aktivitas berjarak di bawah 30 menit', () => {
  const m = new SessionManager(cfg, clock)
  const first = m.id
  for (let i = 0; i < 5; i++) {
    t += 29 * MIN
    m.touch()
  }
  expect(m.id).toBe(first)
})

test('rotasi setelah durasi maksimum 4 jam meski aktif', () => {
  const m = new SessionManager(cfg, clock)
  const first = m.id
  for (let i = 0; i < 25; i++) {
    t += 10 * MIN
    m.touch()
  }
  expect(m.id).not.toBe(first)
})

test('reset() menghasilkan id baru dan memanggil onRotate dengan id lama', () => {
  const m = new SessionManager(cfg, clock)
  const cb = vi.fn()
  m.onRotate(cb)
  const first = m.id
  const next = m.reset()
  expect(next).not.toBe(first)
  expect(m.id).toBe(next)
  expect(cb).toHaveBeenCalledWith(next, first)
})

test('rotasi otomatis juga memanggil onRotate', () => {
  const m = new SessionManager(cfg, clock)
  const cb = vi.fn()
  m.onRotate(cb)
  const first = m.id
  t += 31 * MIN
  m.touch()
  expect(cb).toHaveBeenCalledTimes(1)
  expect(cb.mock.calls[0]?.[1]).toBe(first)
})

test('tetap berfungsi saat sessionStorage diblokir', () => {
  vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
    throw new Error('blocked')
  })
  const m = new SessionManager(cfg, clock)
  expect(m.id).toMatch(/^ses_/)
  expect(() => m.touch()).not.toThrow()
  vi.restoreAllMocks()
})

test('startedNew true untuk sesi baru dan false saat sesi dipulihkan dari storage', () => {
  expect(new SessionManager(cfg, clock).startedNew).toBe(true)
  expect(new SessionManager(cfg, clock).startedNew).toBe(false)
})

test('startedNew true lagi bila sesi tersimpan sudah kedaluwarsa', () => {
  new SessionManager(cfg, clock)
  t += 31 * MIN
  expect(new SessionManager(cfg, clock).startedNew).toBe(true)
})
