import type { TelemetryContext } from '../core/client'
import { redactString } from '../privacy/redactor'

export type RageClickSignal = {
  kind: 'rage_click'
  selector: string
  count: number
  windowMs: number
  x: number
  y: number
  timestamp: number
}

export type DeadClickSignal = {
  kind: 'dead_click'
  selector: string
  waitedMs: number
  x: number
  y: number
  timestamp: number
}

export type FrustrationOptions = {
  /** Sliding window in ms to detect rapid repeated clicks (default: 500ms) */
  rageWindowMs?: number
  /** Minimum clicks within rageWindowMs to flag a rage click (default: 3) */
  rageMinClicks?: number
  /** Max pointer distance in CSS pixels to treat clicks as targeting same spot (default: 30px) */
  rageRadiusPx?: number
  /** Observation window in ms after an interactive click to wait for DOM/network/nav (default: 1500ms) */
  deadClickWindowMs?: number
  onRageClick?: (signal: RageClickSignal) => void
  onDeadClick?: (signal: DeadClickSignal) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export type ClickInput = {
  x: number
  y: number
  selector: string
  isInteractive: boolean
  timestamp?: number
}

type RecordedClick = {
  x: number
  y: number
  selector: string
  timestamp: number
}

type PendingDeadClick = {
  id: number
  selector: string
  x: number
  y: number
  timestamp: number
  timer: unknown
}

const INTERACTIVE_SELECTOR = 'a,button,[role="button"],input[type="button"],input[type="submit"],summary,select'

export function isInteractiveElement(el: Element | null): boolean {
  if (!el) return false
  return Boolean(el.closest(INTERACTIVE_SELECTOR))
}

export function computeSelector(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  for (let i = 0; cur && i < 3 && cur !== document.documentElement; i++) {
    let p = cur.tagName.toLowerCase()
    if (cur.id) {
      parts.unshift(`${p}#${cur.id}`)
      break
    }
    const cls =
      typeof cur.className === 'string'
        ? cur.className
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
        : []
    if (cls.length) p += '.' + cls.join('.')
    parts.unshift(p)
    cur = cur.parentElement
  }
  return redactString(parts.join(' > '))
}

/**
 * Stateful frustration detector implementing:
 * 1. Rage Click: 3+ clicks within 500ms on the same element selector or within 30px radius.
 * 2. Dead Click: Interactive button/trigger click with no DOM mutation, network call,
 *    or URL navigation within 1500ms.
 */
export class FrustrationEngine {
  private readonly rageWindowMs: number
  private readonly rageMinClicks: number
  private readonly rageRadiusPx: number
  private readonly deadClickWindowMs: number
  private readonly onRageClick?: (signal: RageClickSignal) => void
  private readonly onDeadClick?: (signal: DeadClickSignal) => void
  private readonly nowFn: () => number
  private readonly setTimerFn: (fn: () => void, ms: number) => unknown
  private readonly clearTimerFn: (handle: unknown) => void

  private recentClicks: RecordedClick[] = []
  private pendingDeadClicks = new Map<number, PendingDeadClick>()
  private nextDeadId = 1

  private chunkRageFlag = false
  private chunkDeadFlag = false

  constructor(opts: FrustrationOptions = {}) {
    this.rageWindowMs = opts.rageWindowMs ?? 500
    this.rageMinClicks = opts.rageMinClicks ?? 3
    this.rageRadiusPx = opts.rageRadiusPx ?? 30
    this.deadClickWindowMs = opts.deadClickWindowMs ?? 1500
    this.onRageClick = opts.onRageClick
    this.onDeadClick = opts.onDeadClick
    this.nowFn = opts.now ?? (() => Date.now())
    this.setTimerFn = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimerFn = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  registerClick(input: ClickInput): { rage: boolean; deadPending: boolean } {
    const now = input.timestamp ?? this.nowFn()
    const x = Math.round(input.x)
    const y = Math.round(input.y)
    const selector = input.selector

    // 1. Check for Rage Click
    this.recentClicks = this.recentClicks.filter((c) => now - c.timestamp <= this.rageWindowMs)

    const nearbyMatches = this.recentClicks.filter((c) => {
      const sameSelector = Boolean(c.selector && c.selector === selector)
      const dx = c.x - x
      const dy = c.y - y
      const inRadius = dx * dx + dy * dy <= this.rageRadiusPx * this.rageRadiusPx
      return sameSelector || inRadius
    })

    this.recentClicks.push({ x, y, selector, timestamp: now })

    let isRage = false
    if (nearbyMatches.length + 1 >= this.rageMinClicks) {
      isRage = true
      this.chunkRageFlag = true
      this.onRageClick?.({
        kind: 'rage_click',
        selector,
        count: nearbyMatches.length + 1,
        windowMs: this.rageWindowMs,
        x,
        y,
        timestamp: now,
      })
      // Clear recent clicks on this cluster so it does not re-trigger every single extra click
      this.recentClicks = this.recentClicks.filter(
        (c) => c.selector !== selector && Math.hypot(c.x - x, c.y - y) > this.rageRadiusPx,
      )
    }

    // 2. Schedule Dead Click observation if interactive
    let deadPending = false
    if (input.isInteractive) {
      deadPending = true
      const id = this.nextDeadId++
      const timer = this.setTimerFn(() => {
        this.triggerDeadClick(id)
      }, this.deadClickWindowMs)

      this.pendingDeadClicks.set(id, {
        id,
        selector,
        x,
        y,
        timestamp: now,
        timer,
      })
    }

    return { rage: isRage, deadPending }
  }

  notifyActivity(): void {
    if (this.pendingDeadClicks.size === 0) return
    for (const pending of this.pendingDeadClicks.values()) {
      this.clearTimerFn(pending.timer)
    }
    this.pendingDeadClicks.clear()
  }

  private triggerDeadClick(id: number): void {
    const pending = this.pendingDeadClicks.get(id)
    if (!pending) return
    this.pendingDeadClicks.delete(id)

    this.chunkDeadFlag = true
    this.onDeadClick?.({
      kind: 'dead_click',
      selector: pending.selector,
      waitedMs: this.deadClickWindowMs,
      x: pending.x,
      y: pending.y,
      timestamp: pending.timestamp,
    })
  }

  getAndResetChunkFlags(): { hasRageClick: boolean; hasDeadClick: boolean } {
    const flags = {
      hasRageClick: this.chunkRageFlag,
      hasDeadClick: this.chunkDeadFlag,
    }
    this.chunkRageFlag = false
    this.chunkDeadFlag = false
    return flags
  }

  peekFlags(): { hasRageClick: boolean; hasDeadClick: boolean } {
    return {
      hasRageClick: this.chunkRageFlag,
      hasDeadClick: this.chunkDeadFlag,
    }
  }

  destroy(): void {
    this.notifyActivity()
    this.recentClicks = []
  }
}

/**
 * Attaches DOM and network mutation listeners to automatically feed the FrustrationEngine.
 */
export function installFrustrationListeners(
  ctx: TelemetryContext,
  engine?: FrustrationEngine,
): { engine: FrustrationEngine; cleanup: () => void } {
  const activeEngine =
    engine ??
    new FrustrationEngine({
      rageWindowMs: ctx.cfg.frustration?.rageClickWindowMs ?? 500,
      rageMinClicks: ctx.cfg.frustration?.rageMinClicks ?? 3,
      deadClickWindowMs: ctx.cfg.frustration?.deadClickWindowMs ?? 1500,
      onRageClick: (signal) => {
        ctx.breadcrumbs.add({
          type: 'rage_click',
          at: signal.timestamp,
          data: { selector: signal.selector, count: signal.count, x: signal.x, y: signal.y },
        })
        ctx.emit({
          type: 'event',
          name: 'rage_click',
          at: signal.timestamp,
          attributes: {
            selector: signal.selector,
            count: signal.count,
            x: signal.x,
            y: signal.y,
            window_ms: signal.windowMs,
          },
        })
      },
      onDeadClick: (signal) => {
        ctx.breadcrumbs.add({
          type: 'dead_click',
          at: signal.timestamp,
          data: { selector: signal.selector, waited_ms: signal.waitedMs, x: signal.x, y: signal.y },
        })
        ctx.emit({
          type: 'event',
          name: 'dead_click',
          at: signal.timestamp,
          attributes: {
            selector: signal.selector,
            waited_ms: signal.waitedMs,
            x: signal.x,
            y: signal.y,
          },
        })
      },
    })

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { engine: activeEngine, cleanup: () => {} }
  }

  const handleClick = (e: MouseEvent) => {
    try {
      const target = (e.target as Element) || null
      const isInteractive = isInteractiveElement(target)
      const selector = target ? computeSelector(target) : 'unknown'
      activeEngine.registerClick({
        x: e.clientX,
        y: e.clientY,
        selector,
        isInteractive,
      })
    } catch {
      // safe fallback
    }
  }

  // Observe DOM mutations to cancel dead clicks when the UI updates
  let observer: MutationObserver | null = null
  if (typeof MutationObserver !== 'undefined' && document.body) {
    try {
      observer = new MutationObserver(() => {
        activeEngine.notifyActivity()
      })
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      })
    } catch {
      // MutationObserver not supported or blocked
    }
  }

  // Listen to popstate / hashchange to cancel dead clicks
  const handleNav = () => activeEngine.notifyActivity()

  document.addEventListener('click', handleClick, { capture: true, passive: true })
  window.addEventListener('popstate', handleNav)
  window.addEventListener('hashchange', handleNav)

  const cleanup = () => {
    document.removeEventListener('click', handleClick, { capture: true })
    window.removeEventListener('popstate', handleNav)
    window.removeEventListener('hashchange', handleNav)
    observer?.disconnect()
    activeEngine.destroy()
  }

  return { engine: activeEngine, cleanup }
}
