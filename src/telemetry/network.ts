import type { TelemetryContext } from '../core/client'
import { scrubUrl } from '../privacy/urlScrubber'
import type { LogLevel } from '../types'

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function resolveUrl(raw: string): string {
  try {
    return new URL(raw, globalThis.location?.href).href
  } catch {
    return raw
  }
}

const withoutQuery = (u: string): string => u.split(/[?#]/)[0] ?? u

function bodyBytes(body: unknown): number | undefined {
  if (typeof body === 'string') return body.length
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength
  return undefined
}

function levelFor(status: number): LogLevel {
  if (status === 0 || status >= 500) return 'error'
  if (status >= 400) return 'warn'
  return 'info'
}

/** Interceptor fetch & XHR. Aditif: memanggil fungsi yang sudah ada (SDK lain tetap berjalan), tidak membaca body. */
export function installNetworkInterceptors(ctx: TelemetryContext): () => void {
  const { cfg } = ctx
  const ownEndpoint = withoutQuery(resolveUrl(cfg.endpoint))
  let active = true

  /** Anti-rekursi: request ke endpoint ingest sendiri tidak boleh menghasilkan telemetri lagi. */
  const ignored = (url: string): boolean => {
    if (withoutQuery(url) === ownEndpoint) return true
    return cfg.network.ignoreUrls.some((p) => (typeof p === 'string' ? url.includes(p) : p.test(url)))
  }

  const report = (method: string, rawUrl: string, status: number, startedAt: number, extra: Record<string, unknown>): void => {
    try {
      if (!active) return
      const url = scrubUrl(rawUrl, { maskUrlPathIds: cfg.privacy.maskUrlPathIds })
      const attributes = { method, url, status, duration_ms: Math.round(now() - startedAt), ...extra }
      ctx.breadcrumbs.add({ type: 'http', at: Date.now(), data: { method, url, status } })
      const message = extra.error ? `${method} ${url} failed: ${String(extra.error)}` : `${method} ${url} → ${status}`
      ctx.emit({ type: 'log', level: levelFor(status), name: 'http_request', message, attributes })
    } catch {
      /* tidak boleh mengganggu aplikasi host */
    }
  }

  // ---- fetch ----
  const g = globalThis as { fetch?: typeof fetch }
  const origFetch = g.fetch
  let patchedFetch: typeof fetch | undefined
  if (typeof origFetch === 'function') {
    patchedFetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const promise = origFetch.apply(this, args)
      try {
        const [input, init] = args
        // Properti, bukan `new Request(input)`: itu akan mengonsumsi body Request milik aplikasi host.
        const isReq = typeof Request !== 'undefined' && input instanceof Request
        const rawUrl = resolveUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : isReq ? input.url : String(input))
        if (!ignored(rawUrl)) {
          const method = (init?.method ?? (isReq ? input.method : 'GET')).toUpperCase()
          const startedAt = now()
          const reqBytes = bodyBytes(init?.body)
          promise.then(
            (res) => {
              const len = Number(res.headers?.get('content-length'))
              report(method, rawUrl, res.status, startedAt, {
                ...(reqBytes !== undefined && { req_bytes: reqBytes }),
                ...(Number.isFinite(len) && res.headers?.get('content-length') !== null && { res_bytes: len }),
              })
            },
            (err: unknown) => report(method, rawUrl, 0, startedAt, { error: err instanceof Error ? err.message : String(err) }),
          )
        }
      } catch {
        /* diabaikan */
      }
      return promise
    } as typeof fetch
    g.fetch = patchedFetch
  }

  // ---- XMLHttpRequest ----
  const Xhr = (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest
  const proto = Xhr?.prototype
  const origOpen = proto?.open
  const origSend = proto?.send
  const meta = new WeakMap<object, { method: string; url: string }>()
  let patchedOpen: typeof XMLHttpRequest.prototype.open | undefined
  let patchedSend: typeof XMLHttpRequest.prototype.send | undefined
  if (proto && origOpen && origSend) {
    patchedOpen = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['open']>) {
      try {
        meta.set(this, { method: String(args[0]).toUpperCase(), url: resolveUrl(String(args[1])) })
      } catch {
        /* diabaikan */
      }
      return (origOpen as (...a: unknown[]) => void).apply(this, args)
    } as typeof XMLHttpRequest.prototype.open
    patchedSend = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>) {
      try {
        const m = meta.get(this)
        if (m && !ignored(m.url)) {
          const startedAt = now()
          const reqBytes = bodyBytes(args[0])
          this.addEventListener('loadend', () => report(m.method, m.url, this.status, startedAt, reqBytes !== undefined ? { req_bytes: reqBytes } : {}), { once: true })
        }
      } catch {
        /* diabaikan */
      }
      return (origSend as (...a: unknown[]) => void).apply(this, args)
    } as typeof XMLHttpRequest.prototype.send
    proto.open = patchedOpen
    proto.send = patchedSend
  }

  return () => {
    active = false
    // Pulihkan hanya bila patch kita masih yang teratas; jika library lain sudah membungkus, wrapper kita pass-through.
    if (patchedFetch && g.fetch === patchedFetch) g.fetch = origFetch
    if (proto && patchedOpen && proto.open === patchedOpen && origOpen) proto.open = origOpen
    if (proto && patchedSend && proto.send === patchedSend && origSend) proto.send = origSend
  }
}
