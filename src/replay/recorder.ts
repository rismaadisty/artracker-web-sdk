import type { TelemetryContext } from '../core/client'
import { sessionSampled } from '../core/sampling'
import { buildMaskOptions } from '../privacy/masking'
import type { ReplayDriver } from '../types'
import { chunkEvents } from './chunker'
import {
  acknowledgeReplayChunk,
  gzipCompressString,
  requestChunkUploadUrl,
  uploadReplayChunkBinary,
} from './uploader'

const FLUSH_MS = 5000
const MAX_CHUNK_BYTES = 24 * 1024
const CHECKOUT_MS = 120_000
const noop = (): void => {}

type RecordFn = (opts: Record<string, unknown>) => (() => void) | undefined

/** rrweb adalah optional peer dependency: bila tidak terpasang, replay menjadi no-op alih-alih error. */
async function loadRecord(): Promise<RecordFn | undefined> {
  const globalRecord = (globalThis as unknown as { rrweb?: { record?: RecordFn } }).rrweb?.record
  if (typeof globalRecord === 'function') {
    return globalRecord
  }
  try {
    const mod = (await import('rrweb')) as unknown as { record?: RecordFn; default?: { record?: RecordFn } }
    const fn = mod.record ?? mod.default?.record
    return typeof fn === 'function' ? fn : undefined
  } catch {
    return undefined
  }
}

function idle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
  if (typeof ric === 'function') ric(fn, { timeout: 2000 })
  else setTimeout(fn, 0)
}

/**
 * Merekam DOM dengan rrweb dan mengunggah chunk sesi.
 * Mendukung mode 'direct' (Cloudflare R2 presigned URL + chunk-ack)
 * dengan fallback otomatis ke 'ingest' (telemetry_events) bila direct storage tidak dikonfigurasi.
 */
export async function startRecording(ctx: TelemetryContext, opts?: { force?: boolean }): Promise<() => void> {
  const { cfg, session } = ctx
  if (!opts?.force && (!cfg.replay.enabled || !sessionSampled(session.id, cfg.replay.sampleRate))) return noop

  const record = await loadRecord()
  if (!record) {
    if (cfg.debug) console.warn('[artracker] replay requires the optional peer dependency "rrweb"')
    return noop
  }

  let buffer: unknown[] = []
  let seq = 0
  let stopped = false
  let chunkHasError = false
  let chunkStartTime = Date.now()

  // Hook unhandled errors during recording
  const onSessionError = () => {
    chunkHasError = true
  }
  if (ctx.onSessionError) {
    ctx.onSessionError(onSessionError)
  }

  const flushDirect = async (events: unknown[], currentSeq: number): Promise<boolean> => {
    try {
      const jsonStr = JSON.stringify(events)
      const gzippedBytes = await gzipCompressString(jsonStr)
      const durationMs = Math.max(1000, Date.now() - chunkStartTime)
      chunkStartTime = Date.now()

      const frustrationFlags = ctx.getFrustrationFlags ? ctx.getFrustrationFlags() : { hasRageClick: false, hasDeadClick: false }
      const hasError = chunkHasError
      chunkHasError = false

      // 1. Request Presigned URL
      const urlRes = await requestChunkUploadUrl(cfg.endpoint, cfg.appKey, {
        session_id: session.id,
        chunk_seq: currentSeq,
        size_bytes: gzippedBytes.byteLength,
        user_id: ctx.user?.userId || undefined,
        environment: cfg.environment,
      })

      if (!urlRes || !urlRes.upload_url) {
        return false // Direct upload unavailable on backend, fallback to ingest
      }

      // 2. PUT to presigned URL
      const uploadOk = await uploadReplayChunkBinary(urlRes.upload_url, gzippedBytes)
      if (!uploadOk) {
        return false
      }

      // 3. Acknowledge chunk
      await acknowledgeReplayChunk(cfg.endpoint, cfg.appKey, {
        session_id: session.id,
        chunk_seq: currentSeq,
        size_bytes: gzippedBytes.byteLength,
        duration_ms: durationMs,
        event_count: events.length,
        has_error: hasError,
        has_rage_click: frustrationFlags.hasRageClick,
        has_dead_click: frustrationFlags.hasDeadClick,
      })

      return true
    } catch {
      return false
    }
  }

  const flush = (): void => {
    if (buffer.length === 0) return
    const events = buffer
    buffer = []

    const currentSeq = seq
    for (const chunk of chunkEvents(events, MAX_CHUNK_BYTES, currentSeq)) {
      seq = chunk.seq + 1
      ctx.emit({
        type: 'session',
        name: 'replay_chunk',
        at: chunk.start,
        attributes: { ...chunk },
        skipRedaction: true,
      })
    }

    const uploadMode = cfg.replay.uploadMode ?? 'direct'
    if (uploadMode === 'direct') {
      void flushDirect(events, currentSeq)
    }
  }

  const stopRrweb = record({
    emit: (event: unknown) => {
      if (!stopped) buffer.push(event)
    },
    checkoutEveryNms: CHECKOUT_MS,
    sampling: { mousemove: 50, scroll: 150, input: 'last', media: 800 },
    recordCanvas: false,
    collectFonts: false,
    ...buildMaskOptions(cfg),
  })

  const timer = setInterval(() => idle(() => void flush()), FLUSH_MS)

  const onHide = (): void => {
    void flush()
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') void flush()
  }
  window.addEventListener('pagehide', onHide, true)
  document.addEventListener('visibilitychange', onVisibility, true)

  return () => {
    if (stopped) return
    clearInterval(timer)
    window.removeEventListener('pagehide', onHide, true)
    document.removeEventListener('visibilitychange', onVisibility, true)
    try {
      stopRrweb?.()
    } catch {
      /* diabaikan */
    }
    void flush()
    stopped = true
  }
}

export const replayDriver: ReplayDriver = { start: startRecording }
