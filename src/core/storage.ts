export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

function realStorage(kind: 'session' | 'local'): Storage | undefined {
  try {
    if (typeof window === 'undefined') return undefined
    return kind === 'session' ? window.sessionStorage : window.localStorage
  } catch {
    return undefined
  }
}

/**
 * Storage yang tidak pernah melempar. Akses dibungkus try/catch pada SETIAP operasi
 * (Safari dapat mencabut izin di tengah jalan) dengan Map in-memory sebagai cadangan.
 */
export function safeStorage(kind: 'session' | 'local'): KeyValueStore {
  const memory = new Map<string, string>()

  return {
    get(key) {
      try {
        const v = realStorage(kind)?.getItem(key)
        if (v !== null && v !== undefined) return v
      } catch {
        /* fall through ke memori */
      }
      return memory.get(key) ?? null
    },
    set(key, value) {
      try {
        const s = realStorage(kind)
        if (s) {
          s.setItem(key, value)
          memory.delete(key)
          return
        }
      } catch {
        /* fall through ke memori */
      }
      memory.set(key, value)
    },
    remove(key) {
      memory.delete(key)
      try {
        realStorage(kind)?.removeItem(key)
      } catch {
        /* diabaikan */
      }
    },
  }
}
