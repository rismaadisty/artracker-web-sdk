import { classifyResponse, nextDelayMs } from '../backoff'

test('202 => accepted', () => {
  expect(classifyResponse(202, null, 0)).toEqual({ kind: 'accepted' })
})

test('2xx lain juga dianggap accepted', () => {
  expect(classifyResponse(200, null, 0).kind).toBe('accepted')
})

test('400 => drop permanen', () => {
  expect(classifyResponse(400, null, 0).kind).toBe('drop')
})

// Review Focus #4
test('401 => kill switch', () => {
  expect(classifyResponse(401, null, 0).kind).toBe('kill')
})

test('413 => split', () => {
  expect(classifyResponse(413, null, 0)).toEqual({ kind: 'split' })
})

test('429 menghormati Retry-After di atas perhitungan lokal', () => {
  expect(classifyResponse(429, '120', 0)).toEqual({ kind: 'retry', afterMs: 120_000 })
})

test('503 tanpa Retry-After memakai backoff eksponensial', () => {
  const o = classifyResponse(503, null, 2)
  expect(o.kind).toBe('retry')
  if (o.kind === 'retry') {
    expect(o.afterMs).toBeGreaterThanOrEqual(96_000) // 30s * 4 * 0.8
    expect(o.afterMs).toBeLessThanOrEqual(144_000)
  }
})

test('Retry-After tidak valid diabaikan', () => {
  const o = classifyResponse(429, 'soon', 0)
  expect(o.kind).toBe('retry')
  if (o.kind === 'retry') expect(o.afterMs).toBeLessThanOrEqual(36_000)
})

test('4xx lain (403, 404) => drop', () => {
  expect(classifyResponse(403, null, 0).kind).toBe('drop')
  expect(classifyResponse(404, null, 0).kind).toBe('drop')
})

test('5xx lain => retry', () => {
  expect(classifyResponse(500, null, 0).kind).toBe('retry')
  expect(classifyResponse(502, null, 0).kind).toBe('retry')
})

test('nextDelayMs naik eksponensial dan dibatasi 5 menit', () => {
  expect(nextDelayMs(0)).toBeGreaterThanOrEqual(24_000) // 30s ± 20%
  expect(nextDelayMs(0)).toBeLessThanOrEqual(36_000)
  expect(nextDelayMs(20)).toBeLessThanOrEqual(300_000)
  expect(nextDelayMs(20)).toBeGreaterThanOrEqual(240_000)
})

test('nextDelayMs: Retry-After selalu menang', () => {
  expect(nextDelayMs(5, 7)).toBe(7000)
})
