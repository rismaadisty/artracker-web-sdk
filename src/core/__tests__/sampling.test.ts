import { hashFraction, sessionSampled } from '../sampling'

test('hashFraction deterministik dan berada di [0,1)', () => {
  const a = hashFraction('ses_abc')
  expect(a).toBe(hashFraction('ses_abc'))
  expect(a).toBeGreaterThanOrEqual(0)
  expect(a).toBeLessThan(1)
})

test('sessionSampled: rate 1 selalu true, rate 0 selalu false', () => {
  expect(sessionSampled('x', 1)).toBe(true)
  expect(sessionSampled('x', 0)).toBe(false)
})

test('sessionSampled mendekati rate pada banyak sesi', () => {
  let hit = 0
  for (let i = 0; i < 5000; i++) if (sessionSampled('ses_' + i * 7919, 0.1)) hit++
  expect(hit / 5000).toBeGreaterThan(0.07)
  expect(hit / 5000).toBeLessThan(0.13)
})
