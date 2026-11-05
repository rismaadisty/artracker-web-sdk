import { utf8Length } from '../core/bytes'
import { redactString } from '../privacy/redactor'
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

const MAX_ATTR_VALUE = 2000

/**
 * Meredaksi PII pada nilai atribut elemen (title, alt, placeholder, data-*, ...) di salinan event. rrweb 2.x tak punya
 * hook atribut, dan event aslinya dipakai bersama mirror internal rrweb sehingga TIDAK boleh dimutasi. Iteratif agar DOM
 * yang dalam tidak menjebol stack. `_cssText`/`rr_*`/nilai >2000 karakter dilewati (CSS, data URI: mahal dan rawan rusak).
 */
function redactAttributes(root: unknown): void {
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const v = stack.pop()
    if (Array.isArray(v)) {
      for (const x of v) if (x && typeof x === 'object') stack.push(x)
    } else if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>
      for (const k of Object.keys(obj)) {
        const val = obj[k]
        if (k === 'attributes' && val && typeof val === 'object' && !Array.isArray(val)) {
          const attrs = val as Record<string, unknown>
          for (const a of Object.keys(attrs)) {
            const av = attrs[a]
            if (typeof av === 'string' && av.length <= MAX_ATTR_VALUE && a !== '_cssText' && !a.startsWith('rr_')) attrs[a] = redactString(av)
          }
        }
        if (val && typeof val === 'object') stack.push(val)
      }
    }
  }
}

const FULL_SNAPSHOT_TYPE = 2
const INCREMENTAL_TYPE = 3
const MUTATION_SOURCE = 0
const carriesAttributes = (e: unknown): boolean => {
  const ev = e as { type?: unknown; data?: { source?: unknown } } | null
  return ev?.type === FULL_SNAPSHOT_TYPE || (ev?.type === INCREMENTAL_TYPE && ev.data?.source === MUTATION_SOURCE)
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
      if (carriesAttributes(raw)) {
        ev = JSON.parse(json) // salinan: event asli milik rrweb tidak boleh berubah
        redactAttributes(ev)
        json = JSON.stringify(ev)
      } else if (SENSITIVE_PARAM_HINT.test(json)) {
        json = redactQueryParams(json)
        ev = JSON.parse(json)
      }
    } catch {
      continue // tidak dapat diserialisasi (sirkular dsb.)
    }

    const size = utf8Length(json) // backend menghitung byte, bukan karakter JS
    if (size + OVERHEAD > maxBytes) {
      close()
      const e = raw as { type?: unknown } | null
      out.push(makeChunk(seq++, [{ type: e?.type, timestamp: tsOf(raw) ?? Date.now(), oversized: true, original_bytes: size }]))
      continue
    }
    if (curBytes + size + 1 > maxBytes) close()
    cur.push(ev)
    curBytes += size + 1
  }
  close()
  return out
}
