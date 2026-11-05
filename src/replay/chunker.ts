import { redactQueryParams, SENSITIVE_PARAM_HINT } from '../privacy/urlScrubber'

export interface ReplayChunk {
  seq: number
  start: number
  end: number
  full_snapshot: boolean
  events: unknown[]
}

/** Ruang untuk pembungkus {"seq":..,"start":..,"end":..,"full_snapshot":false,"events":[]} (~100 byte). */
const OVERHEAD = 128

const FULL_SNAPSHOT = 2
const tsOf = (e: unknown): number | undefined => {
  const t = (e as { timestamp?: unknown } | null)?.timestamp
  return typeof t === 'number' ? t : undefined
}

function makeChunk(seq: number, events: unknown[]): ReplayChunk {
  return {
    seq,
    start: tsOf(events[0]) ?? Date.now(),
    end: tsOf(events[events.length - 1]) ?? Date.now(),
    full_snapshot: events.some((e) => (e as { type?: unknown } | null)?.type === FULL_SNAPSHOT),
    events,
  }
}

/**
 * Memecah event rrweb menjadi chunk yang masing-masing <= maxBytes setelah serialisasi (di bawah batas 32 KB backend,
 * yang jika dilanggar mengganti SELURUH attributes dengan {"_truncated":true}). Event tunggal yang terlalu besar
 * diganti stub {oversized:true}. Param URL sensitif di dalam event diredaksi (rrweb 2.x tak punya hook atribut).
 */
export function chunkEvents(events: unknown[], maxBytes: number, seqStart: number): ReplayChunk[] {
  const out: ReplayChunk[] = []
  let cur: unknown[] = []
  let curBytes = OVERHEAD
  let seq = seqStart

  const close = (): void => {
    if (cur.length === 0) return
    out.push(makeChunk(seq++, cur))
    cur = []
    curBytes = OVERHEAD
  }

  for (const raw of events) {
    let json: string
    let ev = raw
    try {
      json = JSON.stringify(raw)
      if (json === undefined) continue
      if (SENSITIVE_PARAM_HINT.test(json)) {
        json = redactQueryParams(json)
        ev = JSON.parse(json)
      }
    } catch {
      continue // tidak dapat diserialisasi (sirkular dsb.)
    }

    if (json.length + OVERHEAD > maxBytes) {
      close()
      const e = raw as { type?: unknown } | null
      out.push(makeChunk(seq++, [{ type: e?.type, timestamp: tsOf(raw) ?? Date.now(), oversized: true, original_bytes: json.length }]))
      continue
    }
    if (curBytes + json.length + 1 > maxBytes) close()
    cur.push(ev)
    curBytes += json.length + 1
  }
  close()
  return out
}
