import type { ReplayDriver } from '../types'
import { replayDriver } from './recorder'

export type { ReplayDriver }
export { replayDriver }

/**
 * Mengaktifkan session replay. Dipasang lewat opsi `replay` agar rrweb tidak ikut ke entry utama:
 *
 *   import { ARTracker } from '@artracker/browser'
 *   import { replay } from '@artracker/browser/replay'
 *   ARTracker.init({ appKey, endpoint, replay: replay({ sampleRate: 0.1 }) })
 *
 * Membutuhkan `rrweb` (optional peer dependency) pada aplikasi.
 */
export function replay(options: { sampleRate?: number; uploadMode?: 'direct' | 'ingest' } = {}): {
  enabled: true
  sampleRate: number | undefined
  driver: ReplayDriver
  uploadMode?: 'direct' | 'ingest'
} {
  const result: {
    enabled: true
    sampleRate: number | undefined
    driver: ReplayDriver
    uploadMode?: 'direct' | 'ingest'
  } = {
    enabled: true,
    sampleRate: options.sampleRate,
    driver: replayDriver,
  }
  if (options.uploadMode !== undefined) {
    result.uploadMode = options.uploadMode
  }
  return result
}
