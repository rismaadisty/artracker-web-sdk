import type { RawItem, ResolvedConfig } from '../types'

export type FlushReason = 'count' | 'bytes' | 'timer' | 'lifecycle' | 'manual' | 'online'

/** Batcher in-memory. Trigger: jumlah item, total byte, atau interval waktu. */
export class BatchQueue {
  private items: RawItem[] = []
  private bytes = 0
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly onFlush: (items: RawItem[], reason: FlushReason) => void,
  ) {
    this.timer = setInterval(() => this.flush('timer'), cfg.batch.flushIntervalMs)
  }

  get size(): number {
    return this.items.length
  }

  add(item: RawItem): void {
    if (this.timer === undefined) return // sudah stop()
    this.items.push(item)
    // Ukuran dihitung sekali per item agar antrean tidak diserialisasi ulang tiap penambahan.
    try {
      this.bytes += JSON.stringify(item).length
    } catch {
      this.bytes += 1024
    }
    if (this.items.length >= this.cfg.batch.maxItems) this.flush('count')
    else if (this.bytes >= this.cfg.batch.maxBytes) this.flush('bytes')
  }

  flush(reason: FlushReason): void {
    if (this.items.length === 0) return
    const batch = this.items
    this.items = []
    this.bytes = 0
    try {
      this.onFlush(batch, reason)
    } catch {
      /* consumer tidak boleh merusak antrean */
    }
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }
}
