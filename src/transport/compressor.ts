import type { ResolvedConfig } from '../types'
import { workerSource } from './worker/gzip.worker'

export interface CompressedBody {
  body: BodyInit
  encoding: 'gzip' | null
}

const WORKER_TIMEOUT_MS = 5000

type Tier = 'worker' | 'main' | 'plain'

function idle<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = (): void => void fn().then(resolve, reject)
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback
    if (typeof ric === 'function') ric(run, { timeout: 2000 })
    else setTimeout(run, 0)
  })
}

async function gzipMain(json: string): Promise<Uint8Array<ArrayBuffer>> {
  const cs = new CompressionStream('gzip')
  const w = cs.writable.getWriter()
  // Tidak di-await: menunggu write sebelum membaca readable akan deadlock pada backpressure.
  void w.write(new TextEncoder().encode(json)).catch(() => {})
  void w.close().catch(() => {})
  return new Uint8Array(await new Response(cs.readable).arrayBuffer())
}

/**
 * Gzip dengan fallback berjenjang: Web Worker -> CompressionStream di main thread (idle) -> JSON polos.
 * Kegagalan menurunkan tingkat secara permanen agar biaya percobaan tidak dibayar berulang. Tidak pernah melempar.
 */
export function createCompressor(cfg: ResolvedConfig): {
  compress(json: string): Promise<CompressedBody>
  dispose(): void
} {
  let tier: Tier = typeof Worker === 'undefined' ? 'main' : 'worker'
  let worker: Worker | undefined
  let blobUrl: string | undefined
  let seq = 0
  const pending = new Map<number, (buf: ArrayBuffer | null) => void>()

  const stopWorker = (): void => {
    try {
      worker?.terminate()
    } catch {
      /* diabaikan */
    }
    worker = undefined
    if (blobUrl) {
      try {
        URL.revokeObjectURL(blobUrl)
      } catch {
        /* diabaikan */
      }
      blobUrl = undefined
    }
  }

  const downgrade = (): void => {
    if (tier === 'worker') tier = 'main'
    stopWorker()
    for (const resolve of pending.values()) resolve(null)
    pending.clear()
  }

  const ensureWorker = (): Worker | undefined => {
    if (worker) return worker
    try {
      let url = cfg.workerUrl
      if (!url) {
        blobUrl = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }))
        url = blobUrl
      }
      const w = new Worker(url)
      w.onmessage = (e: MessageEvent<{ id: number; buf?: ArrayBuffer; error?: string }>) => {
        const resolve = pending.get(e.data.id)
        if (!resolve) return
        pending.delete(e.data.id)
        if (e.data.buf) resolve(e.data.buf)
        else {
          resolve(null)
          downgrade()
        }
      }
      w.onerror = () => downgrade()
      worker = w
      return w
    } catch {
      downgrade()
      return undefined
    }
  }

  const viaWorker = (w: Worker, json: string): Promise<ArrayBuffer | null> =>
    new Promise((resolve) => {
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(null)
        downgrade()
      }, WORKER_TIMEOUT_MS)
      pending.set(id, (buf) => {
        clearTimeout(timer)
        resolve(buf)
      })
      try {
        w.postMessage({ id, json })
      } catch {
        clearTimeout(timer)
        pending.delete(id)
        resolve(null)
        downgrade()
      }
    })

  return {
    async compress(json) {
      const plain: CompressedBody = { body: json, encoding: null }
      try {
        if (tier === 'plain' || typeof CompressionStream === 'undefined') return plain
        if (tier === 'worker') {
          const w = ensureWorker()
          if (w) {
            const buf = await viaWorker(w, json)
            if (buf) return { body: new Uint8Array(buf), encoding: 'gzip' }
          }
        }
        return { body: await idle(() => gzipMain(json)), encoding: 'gzip' }
      } catch {
        tier = 'plain'
        return plain
      }
    },
    dispose() {
      pending.forEach((resolve) => resolve(null))
      pending.clear()
      stopWorker()
    },
  }
}
