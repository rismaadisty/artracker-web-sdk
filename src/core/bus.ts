import type { RawItem } from '../types'

type Listener = (item: RawItem) => void

/** Emitter internal: listener telemetri -> pipeline, tanpa coupling langsung. */
export class Bus {
  private listeners: Listener[] = []

  on(fn: Listener): () => void {
    this.listeners.push(fn)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn)
    }
  }

  emit(item: RawItem): void {
    for (const fn of this.listeners.slice()) {
      try {
        fn(item)
      } catch {
        /* satu listener rusak tidak boleh menghentikan yang lain */
      }
    }
  }
}
