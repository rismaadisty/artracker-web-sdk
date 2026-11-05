import { scrubUrl } from '../urlScrubber'

const o = { maskUrlPathIds: false }

test('meredaksi query param sensitif dan mempertahankan yang lain', () => {
  expect(scrubUrl('https://a/x?token=abc&page=2', o)).toBe('https://a/x?token=[redacted]&page=2')
  expect(scrubUrl('https://a/x?page=2&email=budi@example.com&sig=zz', o)).toBe(
    'https://a/x?page=2&email=[redacted]&sig=[redacted]',
  )
})

test('nama param tidak peka huruf besar-kecil', () => {
  expect(scrubUrl('/x?Access_Token=abc', o)).toBe('/x?Access_Token=[redacted]')
})

test('fragment dengan param sensitif (OAuth implicit) diredaksi, route hash dipertahankan', () => {
  expect(scrubUrl('https://a/cb#access_token=abc&state=1', o)).toBe('https://a/cb#access_token=[redacted]&state=1')
  expect(scrubUrl('https://a/#/dashboard', o)).toBe('https://a/#/dashboard')
})

test('URL tanpa data sensitif tidak berubah', () => {
  expect(scrubUrl('https://a.example:8080/api/v1/items?limit=50', o)).toBe('https://a.example:8080/api/v1/items?limit=50')
})

test('maskUrlPathIds mengganti segmen uuid dan angka panjang dengan :id', () => {
  expect(
    scrubUrl('https://a/users/12345/orders/3fa85f64-5717-4562-b3fc-2c963f66afa6?x=1', { maskUrlPathIds: true }),
  ).toBe('https://a/users/:id/orders/:id?x=1')
})

test('maskUrlPathIds tidak menyentuh host, port, atau segmen kata', () => {
  expect(scrubUrl('http://127.0.0.1:8080/v1/items', { maskUrlPathIds: true })).toBe('http://127.0.0.1:8080/v1/items')
})

test('input bukan URL tidak melempar', () => {
  expect(() => scrubUrl('', o)).not.toThrow()
  expect(() => scrubUrl('::::', o)).not.toThrow()
  expect(scrubUrl(undefined as never, o)).toBe('')
})
