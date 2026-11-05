import { UserStore } from '../user'

beforeEach(() => {
  localStorage.clear()
})

test('userId bertahan di localStorage antar instance', () => {
  new UserStore().identify('usr_42', { plan: 'pro' })
  expect(new UserStore().userId).toBe('usr_42')
})

test('traits hanya di memori: tidak pernah ditulis ke localStorage (bisa berisi PII)', () => {
  const u = new UserStore()
  u.identify('usr_42', { email: 'budi@example.com', plan: 'pro' })
  expect(u.traits).toEqual({ email: 'budi@example.com', plan: 'pro' })
  const everything = JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])))
  expect(everything).not.toContain('budi@example.com')
  expect(new UserStore().traits).toBeUndefined()
})

test('userId dipotong ke 128 karakter', () => {
  const u = new UserStore()
  u.identify('x'.repeat(300))
  expect(u.userId).toHaveLength(128)
})

test('identify mengabaikan userId kosong atau bukan string', () => {
  const u = new UserStore()
  u.identify('')
  u.identify(undefined as never)
  expect(u.userId).toBeUndefined()
})

test('reset() menghapus userId dan traits termasuk dari storage', () => {
  const u = new UserStore()
  u.identify('usr_1', { a: 1 })
  u.reset()
  expect(u.userId).toBeUndefined()
  expect(u.traits).toBeUndefined()
  expect(new UserStore().userId).toBeUndefined()
})

test('tetap berfungsi saat localStorage diblokir', () => {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new Error('blocked')
  })
  const u = new UserStore()
  expect(() => u.identify('usr_9')).not.toThrow()
  expect(u.userId).toBe('usr_9')
  vi.restoreAllMocks()
})
