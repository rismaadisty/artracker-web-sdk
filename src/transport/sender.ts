import type { Envelope, ResolvedConfig, SendOutcome } from '../types'
import { classifyResponse, nextDelayMs } from './backoff'
import { createCompressor } from './compressor'

/** Batas keepalive fetch di browser adalah 64 KB; beri margin. */
const KEEPALIVE_MAX_BYTES = 60_000
const BEACON_MAX_BYTES = 60_000

const byteLength = (body: BodyInit): number =>
  typeof body === 'string' ? new Blob([body]).size : (body as Uint8Array).byteLength

export class Sender {
  private readonly compressor
  /** Referensi fetch asli saat konstruksi: tidak ikut ter-patch oleh interceptor telemetri. */
  private readonly rawFetch: typeof fetch
  private attempt = 0

  constructor(private readonly cfg: ResolvedConfig) {
    this.compressor = createCompressor(cfg)
    this.rawFetch = globalThis.fetch.bind(globalThis)
  }

  async send(envelope: Envelope): Promise<SendOutcome> {
    try {
      const { body, encoding } = await this.compressor.compress(JSON.stringify(envelope))
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Artracker-Key': this.cfg.appKey,
      }
      if (encoding) headers['Content-Encoding'] = encoding

      const res = await this.rawFetch(this.cfg.endpoint, {
        method: 'POST',
        headers,
        body,
        keepalive: byteLength(body) <= KEEPALIVE_MAX_BYTES,
        credentials: 'omit',
        mode: 'cors',
      })
      const outcome = classifyResponse(res.status, res.headers.get('Retry-After'), this.attempt)
      if (outcome.kind === 'accepted') this.attempt = 0
      else if (outcome.kind === 'retry') this.attempt++
      return outcome
    } catch {
      const afterMs = nextDelayMs(this.attempt)
      this.attempt++
      return { kind: 'retry', afterMs }
    }
  }

  /**
   * Jalur unload: sendBeacon tidak dapat mengirim header, jadi key lewat query dan body text/plain
   * (simple request, tanpa preflight). Tidak di-gzip. Mengembalikan false bila tidak terkirim.
   */
  sendOnUnload(envelope: Envelope): boolean {
    try {
      if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false
      const json = JSON.stringify(envelope)
      const blob = new Blob([json], { type: 'text/plain' })
      if (blob.size > BEACON_MAX_BYTES) return false
      const sep = this.cfg.endpoint.includes('?') ? '&' : '?'
      return navigator.sendBeacon(`${this.cfg.endpoint}${sep}api_key=${encodeURIComponent(this.cfg.appKey)}`, blob)
    } catch {
      return false
    }
  }

  dispose(): void {
    this.compressor.dispose()
  }
}
