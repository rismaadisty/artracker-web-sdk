import type { TelemetryContext } from '../core/client'
import { hash32 } from '../core/sampling'
import { scrubUrl } from '../privacy/urlScrubber'
import type { BreadcrumbBuffer } from './breadcrumbs'

const MAX_STACK = 16 * 1024
const DEDUP_MS = 10_000
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 20
const RESOURCE_TAGS = new Set(['IMG', 'SCRIPT', 'LINK'])

const V8_FRAME = /^at\s/
const GECKO_FRAME = /^\S*@\S+:\d+(?::\d+)?$/

/** Frame pertama dari stack (V8 "at ..." atau Firefox/Safari "fn@file:l:c"), tanpa query string (cache buster). */
function topFrame(stack: string | undefined): string {
  if (!stack) return ''
  for (const line of stack.split('\n')) {
    const t = line.trim()
    if (V8_FRAME.test(t) || GECKO_FRAME.test(t)) return t.replace(/\?[^\s:)]*/g, '')
  }
  return ''
}

/** Sidik jari untuk pengelompokan/dedup: nama + frame teratas; `fallback` dipakai bila stack tak punya frame. */
export function fingerprintError(name: string, stack: string | undefined, fallback = ''): string {
  const frame = topFrame(stack)
  return hash32(`${name}|${frame || fallback}`).toString(16).padStart(8, '0')
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, 500)
  } catch {
    return String(value)
  }
}

export interface ErrorReport {
  message: string
  attributes: Record<string, unknown>
}

/** Satu-satunya pembentuk item error: dipakai listener otomatis dan ARTracker.captureException. */
export function buildErrorReport(
  error: unknown,
  breadcrumbs: BreadcrumbBuffer,
  extra?: Record<string, unknown>,
  kind = 'captured',
  defaultName = 'Error',
): ErrorReport {
  const e = error instanceof Error ? error : undefined
  const name = e?.name || defaultName
  const text = e ? e.message : describe(error)
  const message = `${name}: ${text}`
  const stack = e?.stack ?? ''
  return {
    message,
    attributes: {
      ...extra,
      kind,
      stack: stack.slice(0, MAX_STACK),
      fingerprint: fingerprintError(name, stack, message),
      breadcrumbs: breadcrumbs.snapshot(),
    },
  }
}

export function installErrorListeners(ctx: TelemetryContext): () => void {
  const lastSent = new Map<string, number>()
  let windowStart = 0
  let count = 0

  /** Dedup 10 detik per fingerprint + circuit breaker 20 error/menit (melindungi kuota event project). */
  const allow = (fingerprint: string): boolean => {
    const now = Date.now()
    const last = lastSent.get(fingerprint)
    if (last !== undefined && now - last < DEDUP_MS) return false
    if (now - windowStart >= WINDOW_MS) {
      windowStart = now
      count = 0
    }
    if (count >= MAX_PER_WINDOW) return false
    count++
    lastSent.set(fingerprint, now)
    if (lastSent.size > 200) {
      for (const [k, t] of lastSent) if (now - t >= DEDUP_MS) lastSent.delete(k)
    }
    return true
  }

  const onError = (ev: Event): void => {
    try {
      const target = ev.target
      if (target instanceof Element) {
        if (!RESOURCE_TAGS.has(target.tagName)) return
        const tag = target.tagName.toLowerCase()
        const raw = (target as HTMLImageElement).src || (target as HTMLLinkElement).href || ''
        const url = scrubUrl(raw, { maskUrlPathIds: ctx.cfg.privacy.maskUrlPathIds })
        if (!allow(`res|${tag}|${raw.split(/[?#]/)[0]}`)) return
        ctx.emit({ type: 'log', level: 'warn', name: 'resource_error', message: `Failed to load ${tag}`, attributes: { kind: 'resource', tag, url } })
        return
      }
      const e = ev as ErrorEvent
      const extra = { filename: e.filename, lineno: e.lineno, colno: e.colno }
      const report =
        e.error instanceof Error
          ? buildErrorReport(e.error, ctx.breadcrumbs, extra, 'error')
          : buildErrorReport(e.message || 'Unknown error', ctx.breadcrumbs, extra, 'error')
      if (!allow(String(report.attributes.fingerprint))) return
      ctx.emit({ type: 'log', level: 'error', message: e.error instanceof Error ? report.message : e.message || report.message, attributes: report.attributes })
    } catch {
      /* listener tidak boleh melempar ke aplikasi host */
    }
  }

  const onRejection = (ev: Event): void => {
    try {
      const reason = (ev as PromiseRejectionEvent).reason
      const report = buildErrorReport(reason, ctx.breadcrumbs, undefined, 'unhandledrejection', 'UnhandledRejection')
      if (!allow(String(report.attributes.fingerprint))) return
      ctx.emit({ type: 'log', level: 'error', message: report.message, attributes: report.attributes })
    } catch {
      /* diabaikan */
    }
  }

  // Capture agar error resource (yang tidak bubbling) tertangkap; aditif, tidak menimpa window.onerror milik host.
  window.addEventListener('error', onError, true)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError, true)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
