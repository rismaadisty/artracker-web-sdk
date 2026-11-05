import type { ARTrackerOptions, Envelope, LogLevel, RawItem, ResolvedConfig } from '../types'
import { BreadcrumbBuffer } from '../telemetry/breadcrumbs'
import { buildErrorReport, installErrorListeners } from '../telemetry/errors'
import { redactItem } from '../privacy/redactor'
import { BatchQueue, type FlushReason } from '../transport/queue'
import { createBatchStore, type BatchStore, type PendingBatch } from '../transport/persistence'
import { Sender } from '../transport/sender'
import { Bus } from './bus'
import { resolveConfig } from './config'
import { buildContext, collectDeviceMeta } from './context'
import { buildEnvelope, createItem, type ItemInput } from './envelope'
import { sessionSampled } from './sampling'
import { safeCall } from './safe'
import { SessionManager } from './session'
import { UserStore } from './user'
import { uuidv7 } from './uuid'

const PRE_INIT_LIMIT = 100
const DRAIN_GAP_MS = 200 // maks 5 batch/detik (CONTRACT §9)
const MAX_CONSECUTIVE_FAILURES = 8

export interface TelemetryContext {
  emit(input: ItemInput): void
  cfg: ResolvedConfig
  breadcrumbs: BreadcrumbBuffer
  session: SessionManager
}

interface Runtime {
  cfg: ResolvedConfig
  session: SessionManager
  user: UserStore
  bus: Bus
  queue: BatchQueue
  sender: Sender
  breadcrumbs: BreadcrumbBuffer
  ctx: TelemetryContext
  store: Promise<BatchStore>
  extraContext: Record<string, unknown>
  cleanups: Array<() => void>
  puts: Set<Promise<void>>
  drainPromise: Promise<void> | undefined
  dirty: boolean
  pauseUntil: number
  failures: number
  retryTimer: ReturnType<typeof setTimeout> | undefined
  killed: boolean
}

const isBrowser = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class ARTrackerClient {
  private rt: Runtime | undefined
  private pre: Array<() => void> = []

  // ---------- API publik ----------

  init(options: ARTrackerOptions): void {
    if (!isBrowser()) return
    if (this.rt) {
      if (this.rt.cfg.debug) console.warn('[artracker] init() called twice; ignored')
      return
    }
    let cfg: ResolvedConfig
    try {
      cfg = resolveConfig(options)
    } catch (err) {
      // Kesalahan pemanggil, bukan kegagalan internal: tetap terlihat walau debug=false.
      console.warn(err instanceof Error ? err.message : String(err))
      return
    }
    safeCall(() => this.start(cfg), cfg.debug, 'init')
  }

  identify(userId: string, traits?: Record<string, unknown>): void {
    this.run((rt) => {
      rt.user.identify(userId, traits)
      this.emit(rt, { type: 'event', name: '$identify', attributes: traits ? { ...traits } : undefined })
    })
  }

  track(name: string, properties?: Record<string, unknown>): void {
    this.run((rt) => this.emit(rt, { type: 'event', name, attributes: properties }))
  }

  log(level: LogLevel, message: string, attributes?: Record<string, unknown>): void {
    this.run((rt) => this.emit(rt, { type: 'log', level, message, attributes }))
  }

  captureException(error: unknown, context?: Record<string, unknown>): void {
    this.run((rt) => {
      const report = buildErrorReport(error, rt.breadcrumbs, context)
      this.emit(rt, { type: 'log', level: 'error', message: report.message, attributes: report.attributes })
    })
  }

  setContext(key: string, value: unknown): void {
    this.run((rt) => {
      rt.extraContext[key === 'release_version' ? 'app_version' : key] = value
    })
  }

  addBreadcrumb(b: { type: string; data?: Record<string, unknown> }): void {
    this.run((rt) => rt.breadcrumbs.add({ type: b.type, at: Date.now(), data: b.data ?? {} }))
  }

  async flush(): Promise<void> {
    const rt = this.rt
    if (!rt || rt.killed) return
    try {
      rt.queue.flush('manual')
      await Promise.all([...rt.puts])
      await this.startDrain(rt)
    } catch {
      /* flush tidak boleh melempar */
    }
  }

  startReplay(): void {
    // Diimplementasikan di Task 16.
  }

  stopReplay(): void {
    // Diimplementasikan di Task 16.
  }

  /** Logout: identitas dan sesi baru. Item yang tertunda tetap membawa user lama. */
  reset(): void {
    this.run((rt) => {
      rt.queue.flush('manual')
      rt.user.reset()
      rt.session.reset()
    })
  }

  shutdown(): void {
    const rt = this.rt
    this.pre = []
    if (!rt) return
    safeCall(() => {
      rt.queue.flush('lifecycle')
      this.teardown(rt)
    }, rt.cfg.debug, 'shutdown')
    this.rt = undefined
  }

  // ---------- internal ----------

  /** Menjalankan fn bila sudah init; sebelum itu ditampung (maks 100) dan dialirkan saat init. */
  private run(fn: (rt: Runtime) => void): void {
    if (!isBrowser()) return
    const rt = this.rt
    if (!rt) {
      if (this.pre.length < PRE_INIT_LIMIT) this.pre.push(() => this.run(fn))
      return
    }
    safeCall(() => fn(rt), rt.cfg.debug, 'api')
  }

  private start(cfg: ResolvedConfig): void {
    const session = new SessionManager(cfg)
    const breadcrumbs = new BreadcrumbBuffer(cfg.breadcrumbs.limit)
    const bus = new Bus()
    const rt = {
      cfg,
      session,
      user: new UserStore(),
      bus,
      sender: new Sender(cfg),
      breadcrumbs,
      store: createBatchStore(),
      extraContext: {},
      cleanups: [],
      puts: new Set(),
      drainPromise: undefined,
      dirty: false,
      pauseUntil: 0,
      failures: 0,
      retryTimer: undefined,
      killed: false,
    } as unknown as Runtime
    rt.queue = new BatchQueue(cfg, (items, reason) => this.onFlush(rt, items, reason))
    rt.ctx = {
      cfg,
      session,
      breadcrumbs,
      emit: (input) => safeCall(() => this.emit(rt, input), cfg.debug, 'emit'),
    }
    bus.on((item) => rt.queue.add(item))

    session.onRotate((id, previous) => {
      if (previous) {
        this.emit(rt, { type: 'session', name: 'session_end', sessionId: previous, attributes: { breadcrumbs: breadcrumbs.snapshot() } })
      }
      this.emit(rt, { type: 'session', name: 'session_start', sessionId: id, attributes: collectDeviceMeta() })
    })

    this.listen(rt, window, 'pagehide', () => rt.queue.flush('lifecycle'))
    this.listen(rt, document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') rt.queue.flush('lifecycle')
    })
    this.listen(rt, window, 'online', () => {
      rt.pauseUntil = 0
      rt.failures = 0
      if (rt.retryTimer) clearTimeout(rt.retryTimer)
      rt.queue.flush('online')
      void this.startDrain(rt)
    })

    rt.cleanups.push(installErrorListeners(rt.ctx))

    this.rt = rt
    this.emit(rt, { type: 'session', name: 'session_start', attributes: collectDeviceMeta() })

    const buffered = this.pre
    this.pre = []
    for (const fn of buffered) fn()

    // Kirim ulang batch sisa sesi sebelumnya (throttled oleh drain loop).
    void rt.store
      .then((s) => s.prune({ maxBytes: cfg.offline.maxQueueBytes, maxAgeMs: cfg.offline.maxAgeMs }))
      .then(() => this.startDrain(rt))
      .catch(() => {})
  }

  private listen(rt: Runtime, target: EventTarget, type: string, fn: () => void): void {
    const handler = (): void => void safeCall(fn, rt.cfg.debug, type)
    target.addEventListener(type, handler, { passive: true })
    rt.cleanups.push(() => target.removeEventListener(type, handler))
  }

  private emit(rt: Runtime, input: ItemInput): void {
    if (rt.killed) return
    rt.session.touch()
    const sessionId = input.sessionId ?? rt.session.id
    // Sampling per sesi hanya untuk event biasa; log/error dan item sesi tidak pernah dibuang.
    if (input.type === 'event' && !input.name?.startsWith('$') && !sessionSampled(rt.session.id, rt.cfg.sampleRate)) return
    const item = createItem({ ...input, sessionId, userId: rt.user.userId })
    const out = redactItem(item, rt.cfg)
    if (out) rt.bus.emit(out)
  }

  private context(rt: Runtime): Record<string, unknown> {
    return { ...buildContext(rt.cfg), ...rt.extraContext }
  }

  private envelope(rt: Runtime, items: RawItem[]): Envelope {
    return buildEnvelope(items, rt.cfg, this.context(rt), Date.now())
  }

  private onFlush(rt: Runtime, items: RawItem[], reason: FlushReason): void {
    if (rt.killed) return
    // Saat unload tidak ada waktu menulis ke IndexedDB dulu: coba beacon, jatuh ke penyimpanan bila gagal.
    if (reason === 'lifecycle' && rt.sender.sendOnUnload(this.envelope(rt, items))) return

    const env = this.envelope(rt, items)
    const batch: PendingBatch = {
      id: uuidv7(),
      createdAt: Date.now(),
      bytes: JSON.stringify(env).length,
      items,
    }
    const p: Promise<void> = rt.store
      .then((s) => s.put(batch))
      .then(() => (reason === 'lifecycle' ? undefined : this.startDrain(rt)))
      .catch(() => {})
      .finally(() => void rt.puts.delete(p))
    rt.puts.add(p)
  }

  private startDrain(rt: Runtime): Promise<void> {
    if (rt.drainPromise) {
      rt.dirty = true
      return rt.drainPromise
    }
    const p: Promise<void> = this.drainLoop(rt)
      .catch(() => {})
      .finally(() => {
        rt.drainPromise = undefined
      })
    rt.drainPromise = p
    return p
  }

  /** Satu-satunya pengirim: batch tertua lebih dulu, jeda 200 ms antar-batch. */
  private async drainLoop(rt: Runtime): Promise<void> {
    do {
      rt.dirty = false
      if (rt.killed || Date.now() < rt.pauseUntil) return
      const store = await rt.store
      let first = true
      for (const batch of await store.listPending()) {
        if (rt.killed || Date.now() < rt.pauseUntil) return
        if (!first) await sleep(DRAIN_GAP_MS)
        first = false
        if (!(await this.deliver(rt, store, batch))) return
      }
    } while (rt.dirty && !rt.killed)
  }

  /** Mengembalikan true bila loop boleh lanjut ke batch berikutnya. */
  private async deliver(rt: Runtime, store: BatchStore, batch: PendingBatch): Promise<boolean> {
    const outcome = await rt.sender.send(this.envelope(rt, batch.items))
    switch (outcome.kind) {
      case 'accepted':
        rt.failures = 0
        await store.delete(batch.id)
        return true
      case 'drop':
        if (rt.cfg.debug) console.warn('[artracker] batch dropped:', outcome.reason)
        await store.delete(batch.id)
        return true
      case 'split': {
        // 413: pecah dua dengan id item yang sama (idempoten). Satu item yang masih terlalu besar dibuang.
        if (batch.items.length > 1) {
          const mid = Math.ceil(batch.items.length / 2)
          for (const items of [batch.items.slice(0, mid), batch.items.slice(mid)]) {
            await store.put({ id: uuidv7(), createdAt: batch.createdAt, bytes: Math.ceil(batch.bytes / 2), items })
          }
          rt.dirty = true
        }
        await store.delete(batch.id)
        return true
      }
      case 'retry':
        rt.failures++
        rt.pauseUntil = Date.now() + outcome.afterMs
        if (rt.retryTimer) clearTimeout(rt.retryTimer)
        // Setelah 8 kegagalan beruntun: mode hemat, hanya lanjut saat online/unload/flush manual.
        if (rt.failures < MAX_CONSECUTIVE_FAILURES) {
          rt.retryTimer = setTimeout(() => void this.startDrain(rt), outcome.afterMs)
        }
        return false
      case 'kill':
        this.kill(rt, outcome.reason)
        return false
    }
  }

  /** Mematikan SDK untuk sesi ini (mis. 401): tanpa retry agar backend tidak dibanjiri. */
  private kill(rt: Runtime, reason: string): void {
    if (rt.cfg.debug) console.warn('[artracker] disabled for this session:', reason)
    this.teardown(rt)
  }

  private teardown(rt: Runtime): void {
    rt.killed = true
    rt.queue.stop()
    if (rt.retryTimer) clearTimeout(rt.retryTimer)
    for (const fn of rt.cleanups) safeCall(fn, false, 'cleanup')
    rt.cleanups = []
    rt.sender.dispose()
  }
}
