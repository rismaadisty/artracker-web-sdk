import type { ARTrackerOptions, ResolvedConfig } from '../types'

export class ARTrackerConfigError extends Error {
  constructor(message: string) {
    super(`[artracker] ${message}`)
    this.name = 'ARTrackerConfigError'
  }
}

const KEY_PREFIX = 'art_live_'

function clamp(n: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function validateKey(appKey: unknown): string {
  if (typeof appKey !== 'string' || appKey === '') {
    throw new ARTrackerConfigError('`appKey` is required')
  }
  if (!appKey.startsWith(KEY_PREFIX)) {
    throw new ARTrackerConfigError('`appKey` must be a public client key starting with "art_live_"')
  }
  if (appKey.length < 32 || appKey.length > 128) {
    throw new ARTrackerConfigError('`appKey` must be between 32 and 128 characters')
  }
  return appKey
}

function validateEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== 'string' || endpoint === '') {
    throw new ARTrackerConfigError('`endpoint` is required')
  }
  try {
    new URL(endpoint)
  } catch {
    throw new ARTrackerConfigError('`endpoint` must be an absolute URL')
  }
  return endpoint
}

export function resolveConfig(options: ARTrackerOptions): ResolvedConfig {
  const o = (options ?? {}) as Partial<ARTrackerOptions>
  const appKey = validateKey(o.appKey)
  const endpoint = validateEndpoint(o.endpoint)

  return {
    appKey,
    endpoint,
    environment: o.environment || 'production',
    appVersion: o.appVersion ?? '',
    sampleRate: clamp(o.sampleRate, 0, 1, 1),
    replay: {
      enabled: o.replay?.enabled ?? false,
      sampleRate: clamp(o.replay?.sampleRate, 0, 1, 0.1),
      driver: o.replay?.driver,
    },
    privacy: {
      maskAllInputs: o.privacy?.maskAllInputs ?? true,
      blockClass: o.privacy?.blockClass ?? 'ar-block',
      maskTextClass: o.privacy?.maskTextClass ?? 'ar-mask',
      hashEmails: o.privacy?.hashEmails ?? false,
      maskUrlPathIds: o.privacy?.maskUrlPathIds ?? false,
      redactors: o.privacy?.redactors ?? [],
    },
    network: {
      enabled: o.network?.enabled ?? true,
      ignoreUrls: o.network?.ignoreUrls ?? [],
      captureBodies: o.network?.captureBodies ?? false,
    },
    batch: {
      maxItems: clamp(o.batch?.maxItems, 1, 50, 50),
      maxBytes: clamp(o.batch?.maxBytes, 1024, 131072, 131072),
      flushIntervalMs: clamp(o.batch?.flushIntervalMs, 250, 60000, 5000),
    },
    offline: {
      maxQueueBytes: o.offline?.maxQueueBytes ?? 5 * 1024 * 1024,
      maxAgeMs: o.offline?.maxAgeMs ?? 7 * 24 * 3600 * 1000,
    },
    breadcrumbs: { limit: clamp(o.breadcrumbs?.limit, 1, 200, 30) },
    crossTabSession: o.crossTabSession ?? false,
    respectDoNotTrack: o.respectDoNotTrack ?? false,
    workerUrl: o.workerUrl,
    beforeSend: o.beforeSend,
    debug: o.debug ?? false,
  }
}
