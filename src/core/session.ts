import type { ResolvedConfig } from '../types'
import { safeStorage, type KeyValueStore } from './storage'
import { uuidv7 } from './uuid'

const STORAGE_KEY = 'ar_ses'
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000
export const MAX_DURATION_MS = 4 * 60 * 60 * 1000

interface SessionState {
  id: string
  startedAt: number
  lastSeenAt: number
}

type RotateListener = (id: string, previous: string | null) => void

export class SessionManager {
  private state: SessionState
  private readonly store: KeyValueStore
  private readonly listeners: RotateListener[] = []
  /** true bila sesi dibuat saat konstruksi (bukan dipulihkan dari storage, mis. muat ulang halaman). */
  readonly startedNew: boolean

  constructor(
    cfg: ResolvedConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.store = safeStorage(cfg.crossTabSession ? 'local' : 'session')
    const restored = this.read()
    const reuse = restored !== null && !this.expired(restored)
    this.state = reuse ? restored : this.create()
    this.startedNew = !reuse
    this.persist()
  }

  get id(): string {
    return this.state.id
  }

  /** Dipanggil pada setiap aktivitas; merotasi sesi bila idle/durasi melewati batas. */
  touch(): void {
    if (this.expired(this.state)) {
      this.rotate()
      return
    }
    this.state.lastSeenAt = this.now()
    this.persist()
  }

  /** Memulai sesi baru secara paksa (logout/reset) dan mengembalikan id barunya. */
  reset(): string {
    return this.rotate()
  }

  onRotate(cb: RotateListener): void {
    this.listeners.push(cb)
  }

  private rotate(): string {
    const previous = this.state.id
    this.state = this.create()
    this.persist()
    for (const cb of this.listeners) {
      try {
        cb(this.state.id, previous)
      } catch {
        /* listener tidak boleh merusak SDK */
      }
    }
    return this.state.id
  }

  private create(): SessionState {
    const t = this.now()
    return { id: 'ses_' + uuidv7().replace(/-/g, ''), startedAt: t, lastSeenAt: t }
  }

  private expired(s: SessionState): boolean {
    const t = this.now()
    return t - s.lastSeenAt > IDLE_TIMEOUT_MS || t - s.startedAt > MAX_DURATION_MS
  }

  private read(): SessionState | null {
    try {
      const raw = this.store.get(STORAGE_KEY)
      if (!raw) return null
      const p = JSON.parse(raw) as Partial<SessionState>
      if (typeof p.id === 'string' && typeof p.startedAt === 'number' && typeof p.lastSeenAt === 'number') {
        return { id: p.id, startedAt: p.startedAt, lastSeenAt: p.lastSeenAt }
      }
    } catch {
      /* state rusak -> buat baru */
    }
    return null
  }

  private persist(): void {
    this.store.set(STORAGE_KEY, JSON.stringify(this.state))
  }
}
