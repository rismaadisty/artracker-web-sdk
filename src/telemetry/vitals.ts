import type { TelemetryContext } from '../core/client'

export type VitalMetric = 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB'
export type VitalRating = 'good' | 'needs-improvement' | 'poor'

export type VitalPayload = {
  metric: VitalMetric
  value: number
  rating: VitalRating
  path: string
}

export function rateVital(metric: VitalMetric, value: number): VitalRating {
  switch (metric) {
    case 'LCP':
      return value <= 2500 ? 'good' : value <= 4000 ? 'needs-improvement' : 'poor'
    case 'CLS':
      return value <= 0.1 ? 'good' : value <= 0.25 ? 'needs-improvement' : 'poor'
    case 'INP':
      return value <= 200 ? 'good' : value <= 500 ? 'needs-improvement' : 'poor'
    case 'FCP':
      return value <= 1800 ? 'good' : value <= 3000 ? 'needs-improvement' : 'poor'
    case 'TTFB':
      return value <= 800 ? 'good' : value <= 1800 ? 'needs-improvement' : 'poor'
    default:
      return 'good'
  }
}

/**
 * Attaches PerformanceObservers to capture Google Core Web Vitals (LCP, CLS, INP, FCP, TTFB).
 */
export function installVitalsListeners(ctx: TelemetryContext): () => void {
  if (typeof window === 'undefined' || typeof performance === 'undefined' || typeof PerformanceObserver === 'undefined') {
    return () => {}
  }

  const observers: PerformanceObserver[] = []
  const emittedMetrics = new Set<string>()

  const emitVital = (metric: VitalMetric, value: number) => {
    const roundedValue = metric === 'CLS' ? Math.round(value * 1000) / 1000 : Math.round(value)
    const rating = rateVital(metric, value)
    const path = typeof location !== 'undefined' ? location.pathname : '/'

    // Deduplicate non-cumulative vitals per navigation
    const key = `${metric}_${path}`
    if (emittedMetrics.has(key) && metric !== 'CLS') {
      return
    }
    emittedMetrics.add(key)

    ctx.breadcrumbs.add({
      type: 'vital',
      at: Date.now(),
      data: { metric, value: roundedValue, rating },
    })

    ctx.emit({
      type: 'event',
      name: 'web_vital',
      attributes: {
        metric,
        value: roundedValue,
        rating,
        path,
      },
    })
  }

  // 1. TTFB (Navigation Timing)
  try {
    const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
    if (navEntries && navEntries.length > 0 && navEntries[0]) {
      const ttfb = navEntries[0].responseStart
      if (ttfb > 0) {
        emitVital('TTFB', ttfb)
      }
    }
  } catch {
    // Navigation timing not supported
  }

  // Helper to safely observe supported entry types
  const safeObserve = (type: string, callback: (entryList: PerformanceObserverEntryList) => void) => {
    try {
      if (PerformanceObserver.supportedEntryTypes && !PerformanceObserver.supportedEntryTypes.includes(type)) {
        return
      }
      const po = new PerformanceObserver((list) => {
        try {
          callback(list)
        } catch {
          // ignore callback error
        }
      })
      po.observe({ type, buffered: true })
      observers.push(po)
    } catch {
      // Browser doesn't support this entry type
    }
  }

  // 2. FCP (Paint Timing)
  safeObserve('paint', (list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === 'first-contentful-paint') {
        emitVital('FCP', entry.startTime)
      }
    }
  })

  // 3. LCP (Largest Contentful Paint)
  let latestLcp = 0
  safeObserve('largest-contentful-paint', (list) => {
    const entries = list.getEntries()
    const lastEntry = entries[entries.length - 1]
    if (lastEntry) {
      latestLcp = lastEntry.startTime
    }
  })

  // 4. CLS (Layout Shift)
  let clsValue = 0
  safeObserve('layout-shift', (list) => {
    for (const entry of list.getEntries()) {
      const ls = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number }
      if (!ls.hadRecentInput && typeof ls.value === 'number') {
        clsValue += ls.value
      }
    }
  })

  // 5. INP / First Input Delay
  safeObserve('first-input', (list) => {
    const entries = list.getEntries()
    if (entries.length > 0) {
      const entry = entries[0] as PerformanceEntry & { processingStart?: number }
      if (entry.processingStart) {
        const fid = entry.processingStart - entry.startTime
        emitVital('INP', fid)
      }
    }
  })

  // Flush cumulative metrics (LCP, CLS) on visibilitychange (when page becomes hidden)
  const onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      if (latestLcp > 0) {
        emitVital('LCP', latestLcp)
      }
      if (clsValue > 0) {
        emitVital('CLS', clsValue)
      }
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  return () => {
    for (const po of observers) {
      try {
        po.disconnect()
      } catch {
        // ignore
      }
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }
}
