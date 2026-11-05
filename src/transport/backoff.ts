import type { SendOutcome } from '../types'

export type { SendOutcome }

const BASE_MS = 30_000
const MAX_MS = 5 * 60 * 1000
/** Retry-After dari server selalu menang, tetapi dibatasi agar header ngawur tidak membekukan SDK. */
const MAX_RETRY_AFTER_SEC = 3600

/** min(30s * 2^attempt, 5 menit) dengan jitter ±20%; Retry-After (detik) menang bila ada. */
export function nextDelayMs(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec !== undefined) return retryAfterSec * 1000
  const base = Math.min(BASE_MS * 2 ** Math.max(0, attempt), MAX_MS)
  return Math.min(Math.round(base * (0.8 + Math.random() * 0.4)), MAX_MS)
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined
  const n = Number(header)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.min(n, MAX_RETRY_AFTER_SEC)
}

/** Peta status HTTP -> reaksi SDK (CONTRACT §10). */
export function classifyResponse(status: number, retryAfter: string | null, attempt: number): SendOutcome {
  if (status >= 200 && status < 300) return { kind: 'accepted' }
  if (status === 401) return { kind: 'kill', reason: 'invalid or revoked api key' }
  if (status === 413) return { kind: 'split' }
  if (status === 429 || status === 503 || status === 408) {
    return { kind: 'retry', afterMs: nextDelayMs(attempt, parseRetryAfter(retryAfter)) }
  }
  if (status >= 500) return { kind: 'retry', afterMs: nextDelayMs(attempt, parseRetryAfter(retryAfter)) }
  return { kind: 'drop', reason: `http ${status}` }
}
