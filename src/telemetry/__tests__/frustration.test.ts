import { describe, expect, it, vi } from 'vitest'
import { FrustrationEngine, type DeadClickSignal, type RageClickSignal } from '../frustration'

describe('FrustrationEngine', () => {
  it('detects a rage click after 3 rapid clicks within 500ms', () => {
    let now = 1000
    const rageSignals: RageClickSignal[] = []
    const engine = new FrustrationEngine({
      rageWindowMs: 500,
      rageMinClicks: 3,
      rageRadiusPx: 30,
      now: () => now,
      onRageClick: (s) => rageSignals.push(s),
    })

    // Click 1 at 1000ms
    const c1 = engine.registerClick({ x: 100, y: 100, selector: 'button.checkout', isInteractive: true })
    expect(c1.rage).toBe(false)
    expect(rageSignals.length).toBe(0)

    // Click 2 at 1200ms (+200ms)
    now += 200
    const c2 = engine.registerClick({ x: 105, y: 102, selector: 'button.checkout', isInteractive: true })
    expect(c2.rage).toBe(false)
    expect(rageSignals.length).toBe(0)

    // Click 3 at 1350ms (+150ms) -> triggers Rage Click!
    now += 150
    const c3 = engine.registerClick({ x: 102, y: 101, selector: 'button.checkout', isInteractive: true })
    expect(c3.rage).toBe(true)
    expect(rageSignals.length).toBe(1)
    expect(rageSignals[0]!.count).toBe(3)
    expect(rageSignals[0]!.selector).toBe('button.checkout')

    const flags = engine.getAndResetChunkFlags()
    expect(flags.hasRageClick).toBe(true)
    expect(flags.hasDeadClick).toBe(false)
  })

  it('does NOT trigger rage click if clicks are spaced out > 500ms', () => {
    let now = 1000
    const rageSignals: RageClickSignal[] = []
    const engine = new FrustrationEngine({
      rageWindowMs: 500,
      rageMinClicks: 3,
      now: () => now,
      onRageClick: (s) => rageSignals.push(s),
    })

    engine.registerClick({ x: 10, y: 10, selector: 'a.tab', isInteractive: true })
    now += 600 // Exceeds window
    engine.registerClick({ x: 10, y: 10, selector: 'a.tab', isInteractive: true })
    now += 600 // Exceeds window
    engine.registerClick({ x: 10, y: 10, selector: 'a.tab', isInteractive: true })

    expect(rageSignals.length).toBe(0)
    expect(engine.getAndResetChunkFlags().hasRageClick).toBe(false)
  })

  it('triggers dead click if no activity occurs within window', () => {
    let timerCallback: (() => void) | null = null
    const deadSignals: DeadClickSignal[] = []

    const engine = new FrustrationEngine({
      deadClickWindowMs: 1500,
      setTimer: (fn) => {
        timerCallback = fn
        return 999
      },
      clearTimer: () => {
        timerCallback = null
      },
      onDeadClick: (s) => deadSignals.push(s),
    })

    const res = engine.registerClick({
      x: 50,
      y: 50,
      selector: 'button#submit-order',
      isInteractive: true,
      timestamp: 5000,
    })

    expect(res.deadPending).toBe(true)
    expect(deadSignals.length).toBe(0)

    // Fire the timeout
    expect(timerCallback).not.toBeNull()
    timerCallback!()

    expect(deadSignals.length).toBe(1)
    expect(deadSignals[0]!.selector).toBe('button#submit-order')
    expect(deadSignals[0]!.waitedMs).toBe(1500)

    const flags = engine.getAndResetChunkFlags()
    expect(flags.hasDeadClick).toBe(true)
  })

  it('cancels dead click when DOM or network activity occurs before timeout', () => {
    let timerCallback: (() => void) | null = null
    const deadSignals: DeadClickSignal[] = []
    const clearTimerSpy = vi.fn()

    const engine = new FrustrationEngine({
      deadClickWindowMs: 1500,
      setTimer: (fn) => {
        timerCallback = fn
        return 123
      },
      clearTimer: clearTimerSpy,
      onDeadClick: (s) => deadSignals.push(s),
    })

    engine.registerClick({
      x: 50,
      y: 50,
      selector: 'button#btn',
      isInteractive: true,
    })

    // Activity arrives (e.g. DOM mutation or network response)
    engine.notifyActivity()

    expect(clearTimerSpy).toHaveBeenCalled()
    expect(deadSignals.length).toBe(0)
  })
})
