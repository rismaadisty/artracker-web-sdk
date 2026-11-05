import type { Envelope, ItemType, LogLevel, RawItem, ResolvedConfig } from '../types'
import { utf8Length } from './bytes'
import { SDK_NAME, SDK_VERSION } from './context'
import { uuidv7 } from './uuid'

/** Soft cap per item (CONTRACT §5): di bawah batas keras backend 32 KB. */
export const MAX_ATTRIBUTE_BYTES = 24 * 1024
const MAX_NAME = 255
const MAX_MESSAGE = 4096
const MAX_ID = 128

export interface ItemInput {
  type: ItemType
  name?: string
  level?: LogLevel
  message?: string
  attributes?: Record<string, unknown>
  sessionId?: string
  userId?: string
  /** epoch ms; default Date.now() */
  at?: number
  /** Internal: lewati walker redaksi atribut (replay sudah di-mask di level rrweb). beforeSend tetap berjalan. */
  skipRedaction?: boolean
}

/**
 * Memangkas attributes agar muat di MAX_ATTRIBUTE_BYTES dengan membuang key terbesar satu per satu.
 * Berbeda dari backend yang membuang seluruh objek, field kecil yang berguna tetap terjaga.
 */
export function fitAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  let json: string
  try {
    json = JSON.stringify(attrs)
  } catch {
    return { _artracker_unserializable: true }
  }
  const originalBytes = utf8Length(json)
  if (originalBytes <= MAX_ATTRIBUTE_BYTES) return attrs

  const sized = Object.entries(attrs)
    .map(([k, v]) => {
      let len: number
      try {
        len = (JSON.stringify(v) ?? '').length
      } catch {
        len = Number.MAX_SAFE_INTEGER
      }
      return { k, v, len }
    })
    .sort((a, b) => b.len - a.len)

  const kept = new Map(sized.map((e) => [e.k, e.v]))
  const marker = (): Record<string, unknown> => ({
    ...Object.fromEntries(kept),
    _artracker_truncated: true,
    _original_bytes: originalBytes,
  })

  for (const e of sized) {
    let size: number
    try {
      size = utf8Length(JSON.stringify(marker()))
    } catch {
      size = Number.MAX_SAFE_INTEGER
    }
    if (size <= MAX_ATTRIBUTE_BYTES) return marker()
    kept.delete(e.k)
  }
  return { _artracker_truncated: true, _original_bytes: originalBytes }
}

export function createItem(input: ItemInput): RawItem {
  const item: RawItem = {
    id: uuidv7(),
    type: input.type,
    timestamp: new Date(input.at ?? Date.now()).toISOString(),
  }
  if (input.name !== undefined) item.name = input.name.slice(0, MAX_NAME)
  if (input.type === 'log' && input.level) item.level = input.level
  if (input.message !== undefined) item.message = input.message.slice(0, MAX_MESSAGE)
  if (input.sessionId) item.session_id = input.sessionId.slice(0, MAX_ID)
  if (input.userId) item.user_id = input.userId.slice(0, MAX_ID)
  if (input.attributes) item.attributes = fitAttributes(input.attributes)
  return item
}

export function buildEnvelope(
  items: RawItem[],
  _cfg: ResolvedConfig,
  context: Record<string, unknown>,
  now: number,
): Envelope {
  return {
    sent_at: new Date(now).toISOString(),
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    context,
    items,
  }
}
