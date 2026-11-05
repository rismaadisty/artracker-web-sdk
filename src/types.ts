import type { TelemetryContext } from './core/client'

export type ItemType = 'event' | 'log' | 'session'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface RawItem {
  id: string
  type: ItemType
  name?: string
  level?: LogLevel
  message?: string
  timestamp: string
  session_id?: string
  user_id?: string
  attributes?: Record<string, unknown>
}

export interface Envelope {
  sent_at: string
  sdk: { name: string; version: string }
  context: Record<string, unknown>
  items: RawItem[]
}

export type SendOutcome =
  | { kind: 'accepted' }
  | { kind: 'retry'; afterMs: number }
  | { kind: 'drop'; reason: string }
  | { kind: 'split' }
  | { kind: 'kill'; reason: string }

/** Penggerak perekaman sesi. Disuntikkan dari `@artracker/browser/replay` agar rrweb tidak ikut ke entry utama. */
export interface ReplayDriver {
  /** Mengembalikan fungsi stop. `force` mengabaikan `enabled` dan sampling (dipakai startReplay() manual). */
  start(ctx: TelemetryContext, opts?: { force?: boolean }): Promise<() => void>
}

export interface ARTrackerOptions {
  appKey: string
  endpoint: string
  environment?: string
  appVersion?: string
  sampleRate?: number
  replay?: { enabled?: boolean; sampleRate?: number; driver?: ReplayDriver }
  privacy?: {
    maskAllInputs?: boolean
    blockClass?: string
    maskTextClass?: string
    hashEmails?: boolean
    maskUrlPathIds?: boolean
    redactors?: Array<(s: string) => string>
  }
  network?: { enabled?: boolean; ignoreUrls?: Array<string | RegExp>; captureBodies?: boolean }
  batch?: { maxItems?: number; maxBytes?: number; flushIntervalMs?: number }
  offline?: { maxQueueBytes?: number; maxAgeMs?: number }
  breadcrumbs?: { limit?: number }
  crossTabSession?: boolean
  respectDoNotTrack?: boolean
  workerUrl?: string
  beforeSend?: (item: RawItem) => RawItem | null
  debug?: boolean
}

export interface ResolvedConfig {
  appKey: string
  endpoint: string
  environment: string
  appVersion: string
  sampleRate: number
  replay: { enabled: boolean; sampleRate: number; driver: ReplayDriver | undefined }
  privacy: {
    maskAllInputs: boolean
    blockClass: string
    maskTextClass: string
    hashEmails: boolean
    maskUrlPathIds: boolean
    redactors: Array<(s: string) => string>
  }
  network: { enabled: boolean; ignoreUrls: Array<string | RegExp>; captureBodies: boolean }
  batch: { maxItems: number; maxBytes: number; flushIntervalMs: number }
  offline: { maxQueueBytes: number; maxAgeMs: number }
  breadcrumbs: { limit: number }
  crossTabSession: boolean
  respectDoNotTrack: boolean
  workerUrl: string | undefined
  beforeSend: ((item: RawItem) => RawItem | null) | undefined
  debug: boolean
}
