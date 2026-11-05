import type { RawItem } from '../types'

export interface PendingBatch {
  id: string
  createdAt: number
  bytes: number
  items: RawItem[]
}

export interface BatchStore {
  put(b: PendingBatch): Promise<void>
  /** Tertua lebih dulu. */
  listPending(limit?: number): Promise<PendingBatch[]>
  delete(id: string): Promise<void>
  /** Membuang batch kedaluwarsa lalu batch berprioritas rendah sampai total <= maxBytes. Mengembalikan jumlah yang dibuang. */
  prune(opts: { maxBytes: number; maxAgeMs: number }): Promise<number>
}

interface Backend {
  all(): Promise<PendingBatch[]>
  put(b: PendingBatch): Promise<void>
  del(id: string): Promise<void>
}

const DB_NAME = 'artracker'
const STORE = 'batches'
const LS_PREFIX = 'ar_q_'
const LS_CAP_BYTES = 1024 * 1024

/**
 * 0 = replay (dibuang lebih dulu), 1 = event/log biasa, 2 = error aplikasi (dipertahankan paling akhir).
 * Log `http_request` level error (mis. polling saat offline) BUKAN error aplikasi: tidak boleh mengusir yang penting.
 */
function tier(b: PendingBatch): 0 | 1 | 2 {
  if (b.items.some((i) => i.type === 'log' && (i.level === 'error' || i.level === 'fatal') && i.name !== 'http_request')) return 2
  if (b.items.length > 0 && b.items.every((i) => i.name === 'replay_chunk')) return 0
  return 1
}

function evictionOrder(batches: PendingBatch[]): PendingBatch[] {
  return batches.slice().sort((a, b) => tier(a) - tier(b) || a.createdAt - b.createdAt)
}

async function enforceBytes(backend: Backend, maxBytes: number): Promise<{ removed: number; total: number }> {
  const all = await backend.all()
  let total = all.reduce((n, b) => n + b.bytes, 0)
  let removed = 0
  for (const b of evictionOrder(all)) {
    if (total <= maxBytes) break
    await backend.del(b.id)
    total -= b.bytes
    removed++
  }
  return { removed, total }
}

function memoryBackend(): Backend {
  const m = new Map<string, PendingBatch>()
  return {
    all: async () => [...m.values()],
    put: async (b) => void m.set(b.id, b),
    del: async (id) => void m.delete(id),
  }
}

/**
 * `primary` + cadangan memori: put yang gagal di tengah sesi (kuota, storage dicabut) jatuh ke memori alih-alih
 * membuang batch. `capBytes` ditegakkan SAAT put memakai total berjalan (getAll penuh hanya bila terlampaui), bukan hanya saat init.
 */
function createStore(primary: Backend, capBytes?: number): BatchStore {
  const mem = memoryBackend()
  const backend: Backend = {
    all: async () => {
      let p: PendingBatch[] = []
      try {
        p = await primary.all()
      } catch {
        /* hanya memori */
      }
      return [...p, ...(await mem.all())]
    },
    put: async (b) => {
      try {
        await primary.put(b)
      } catch {
        await mem.put(b)
      }
    },
    del: async (id) => {
      try {
        await primary.del(id)
      } catch {
        /* diabaikan */
      }
      await mem.del(id)
    },
  }
  let approx: number | undefined // total byte perkiraan; delete() tidak mengurangi => melebih-lebihkan, lalu dikoreksi saat enforce

  return {
    async put(b) {
      try {
        await backend.put(b)
        if (capBytes !== undefined) {
          approx = approx === undefined ? (await backend.all()).reduce((n, x) => n + x.bytes, 0) : approx + b.bytes
          if (approx > capBytes) approx = (await enforceBytes(backend, capBytes)).total
        }
      } catch {
        /* penyimpanan gagal total: telemetri hilang lebih baik daripada merusak aplikasi host */
      }
    },
    async listPending(limit) {
      try {
        const sorted = (await backend.all()).sort((a, b) => a.createdAt - b.createdAt)
        return limit === undefined ? sorted : sorted.slice(0, limit)
      } catch {
        return []
      }
    },
    async delete(id) {
      try {
        await backend.del(id)
      } catch {
        /* diabaikan */
      }
    },
    async prune({ maxBytes, maxAgeMs }) {
      try {
        const cutoff = Date.now() - maxAgeMs
        let removed = 0
        for (const b of await backend.all()) {
          if (b.createdAt < cutoff) {
            await backend.del(b.id)
            removed++
          }
        }
        approx = undefined
        return removed + (await enforceBytes(backend, maxBytes)).removed
      } catch {
        return 0
      }
    },
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB
      if (!factory) throw new Error('indexedDB unavailable')
      const req = factory.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('indexedDB blocked'))
    } catch (err) {
      reject(err)
    }
  })
}

function idbBackend(db: IDBDatabase): Backend {
  const tx = <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> =>
    new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode)
      const req = run(t.objectStore(STORE))
      t.oncomplete = () => resolve(req ? req.result : undefined)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  return {
    all: async () => ((await tx('readonly', (s) => s.getAll())) as PendingBatch[] | undefined) ?? [],
    put: async (b) => void (await tx('readwrite', (s) => s.put(b))),
    del: async (id) => void (await tx('readwrite', (s) => s.delete(id))),
  }
}

function localBackend(): Backend {
  const ls = (): Storage => window.localStorage
  return {
    async all() {
      const out: PendingBatch[] = []
      const s = ls()
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i)
        if (!k || !k.startsWith(LS_PREFIX)) continue
        try {
          out.push(JSON.parse(s.getItem(k) ?? '') as PendingBatch)
        } catch {
          /* entri rusak dilewati */
        }
      }
      return out
    },
    async put(b) {
      ls().setItem(LS_PREFIX + b.id, JSON.stringify(b))
    },
    async del(id) {
      ls().removeItem(LS_PREFIX + id)
    },
  }
}

function localStorageUsable(): boolean {
  try {
    const s = window.localStorage
    s.setItem('ar_probe', '1')
    s.removeItem('ar_probe')
    return true
  } catch {
    return false
  }
}

/**
 * IndexedDB -> localStorage (cap 1 MB) -> memori. Tier terakhir menjamin SDK tetap mengirim saat semua storage diblokir
 * (Safari ITP, iframe lintas-situs). `capBytes` = offline.maxQueueBytes. Tidak pernah reject.
 */
export async function createBatchStore(opts: { capBytes?: number } = {}): Promise<BatchStore> {
  try {
    return createStore(idbBackend(await openDb()), opts.capBytes)
  } catch {
    /* IndexedDB tidak dapat dipakai */
  }
  if (localStorageUsable()) return createStore(localBackend(), Math.min(opts.capBytes ?? LS_CAP_BYTES, LS_CAP_BYTES))
  return createStore(memoryBackend(), opts.capBytes ?? LS_CAP_BYTES)
}
