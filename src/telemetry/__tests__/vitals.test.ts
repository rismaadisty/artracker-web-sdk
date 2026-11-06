import { describe, expect, it } from 'vitest'
import { rateVital } from '../vitals'

describe('rateVital', () => {
  it('correctly rates LCP', () => {
    expect(rateVital('LCP', 1500)).toBe('good')
    expect(rateVital('LCP', 3000)).toBe('needs-improvement')
    expect(rateVital('LCP', 5000)).toBe('poor')
  })

  it('correctly rates CLS', () => {
    expect(rateVital('CLS', 0.05)).toBe('good')
    expect(rateVital('CLS', 0.15)).toBe('needs-improvement')
    expect(rateVital('CLS', 0.35)).toBe('poor')
  })

  it('correctly rates INP', () => {
    expect(rateVital('INP', 100)).toBe('good')
    expect(rateVital('INP', 350)).toBe('needs-improvement')
    expect(rateVital('INP', 600)).toBe('poor')
  })

  it('correctly rates TTFB', () => {
    expect(rateVital('TTFB', 500)).toBe('good')
    expect(rateVital('TTFB', 1200)).toBe('needs-improvement')
    expect(rateVital('TTFB', 2500)).toBe('poor')
  })
})
