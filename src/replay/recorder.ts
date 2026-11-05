import type { TelemetryContext } from '../core/client'
import { sessionSampled } from '../core/sampling'
import { buildMaskOptions } from '../privacy/masking'
import type { ReplayDriver } from '../types'
import { chunkEvents } from './chunker'

const FLUSH_MS = 5000
const MAX_CHUNK_BYTES = 24 * 1024
const CHECKOUT_MS = 120_000
const noop = (): void => {}

type RecordFn = (opts: Record<string, unknown>) => (() => void) | undefined

/** rrweb adalah optional peer dependency: bila tidak terpasang, replay menjadi no-op alih-alih error. */
async function loadRecord(): Promise<RecordFn | undefined> {
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
 * Merekam DOM dengan rrweb dan memancarkan chunk <=24 KB sebagai item session/replay_chunk.
 * Pemecahan chunk dijadwalkan saat idle; pagehide/visibilitychange membuang buffer secara sinkron.
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

  const flush = (): void => {
    if (buffer.length === 0) return
    const events = buffer
    buffer = []
    for (const chunk of chunkEvents(events, MAX_CHUNK_BYTES, seq)) {
      seq = chunk.seq + 1
      ctx.emit({ type: 'session', name: 'replay_chunk', at: chunk.start, attributes: { ...chunk }, skipRedaction: true })
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

  const timer = setInterval(() => idle(flush), FLUSH_MS)
  // Capture: berjalan sebelum handler pagehide client, sehingga chunk terakhir ikut terkirim lewat beacon.
  const onHide = (): void => flush()
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') flush()
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
    flush()
    stopped = true
  }
}

export const replayDriver: ReplayDriver = { start: startRecording }
