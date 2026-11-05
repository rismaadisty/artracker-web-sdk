# `@artracker/browser` Web SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membangun SDK browser TypeScript yang merekam event, error, jaringan, dan opsional session replay, lalu mengirimkannya ke `POST /api/v1/ingest` milik `artracker` dengan redaksi PII, antrean offline, dan entry bundle ≤18 kB gzip.

**Architecture:** Pipeline satu arah `listener → envelope builder → redactor → queue → IndexedDB → Web Worker (gzip) → POST`. Setiap lapis adalah modul berdiri sendiri dengan interface eksplisit sehingga dapat diuji tanpa browser nyata (Vitest + jsdom + fake-indexeddb). Session replay (`rrweb`) berada di entry terpisah yang dimuat dinamis agar tidak membebani entry utama.

**Tech Stack:** TypeScript 5 (strict), tsup/esbuild, Vitest + jsdom + fake-indexeddb, `size-limit`, `rrweb` (optional peer dependency), pnpm.

**Spec:** [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) dan [`CONTRACT.md`](../../../CONTRACT.md) di root `artracker-web-sdk/`. Keduanya wajib dibaca sebelum mengerjakan task mana pun.

## Global Constraints

Setiap task secara implisit tunduk pada daftar ini.

- Runtime target `es2020`; TypeScript `strict: true`; tidak ada `any` implisit.
- Entry `@artracker/browser` ≤ **18 kB** min+gzip; entry `@artracker/browser/replay` ≤ **4 kB** (tanpa `rrweb`). Gate `size-limit` wajib hijau sebelum commit task mana pun yang menambah kode ke entry.
- **Nol dependency runtime** pada entry utama. `rrweb` adalah optional peer dependency dan hanya boleh diimpor dari `src/replay/`.
- SDK **tidak boleh pernah melempar error** ke aplikasi host. Semua method publik dan semua listener dibungkus `safeCall`. Satu-satunya pengecualian: `resolveConfig()` melempar `ARTrackerConfigError` saat opsi wajib hilang, dan `init()` menangkapnya.
- SSR-safe: setiap modul yang menyentuh `window`/`document`/`navigator` harus menjadi no-op bila `typeof window === 'undefined'`.
- `sdk.name` selalu `"artracker-web"`; `sdk.version` dari `__AR_VERSION__` yang di-define saat build.
- Hanya key berawalan `art_live_` yang diterima; `art_sec_` ditolak di `resolveConfig()`.
- Setiap item membawa `id` UUIDv7 yang dibuat sekali di SDK dan dipakai ulang pada setiap retry.
- Envelope selalu menyertakan `sent_at`, dan setiap item selalu menyertakan `timestamp` (CONTRACT §8).
- Batas yang tidak boleh dilanggar (CONTRACT §5): ≤50 item dan ≤128 KB uncompressed per request; ≤24 KB per `attributes` item.
- Commit setiap akhir task dengan prefix Conventional Commits (`feat:`, `test:`, `chore:`).

## Review Focus

Lima kelas input yang tersirat di spec namun mudah terlewat; masing-masing sudah ditugaskan tesnya ke task pemilik kode.

1. **Storage diblokir** (Safari private mode, cookie policy, kuota penuh) — `sessionStorage`/`localStorage`/IndexedDB melempar pada akses pertama. SDK harus terus berjalan dengan fallback in-memory, bukan mati. → Task 3, Task 7.
2. **`fetch` dipanggil dengan `Request` object atau `URL`, bukan string** — interceptor yang hanya menangani string akan merusak aplikasi host. → Task 15.
3. **Satu item tunggal melebihi batas** (developer memanggil `track()` dengan objek raksasa) — harus dipangkas di SDK, bukan dibiarkan backend mengganti seluruh `attributes` dengan `{"_truncated":true}`. → Task 5.
4. **Respons `401`** — key dicabut saat aplikasi berjalan. Retry tanpa henti akan membanjiri backend; SDK harus mematikan diri untuk sesi itu. → Task 8.
5. **Jam klien meleset jauh** (mundur berhari-hari atau maju) — tanpa `sent_at` + `timestamp` berpasangan, seluruh timeline pengguna itu rusak. → Task 5.

---

## File Structure

| File | Tanggung jawab |
| --- | --- |
| `src/types.ts` | Tipe bersama: `RawItem`, `Envelope`, `ItemType`, `LogLevel`, `ARTrackerOptions`, `ResolvedConfig`, `SendOutcome` |
| `src/core/config.ts` | Validasi + normalisasi opsi |
| `src/core/session.ts` | `SessionManager` |
| `src/core/user.ts` | `UserStore` |
| `src/core/context.ts` | Envelope context + metadata perangkat |
| `src/core/envelope.ts` | `createItem`, `buildEnvelope`, pemangkasan ukuran |
| `src/core/bus.ts` | Emitter internal |
| `src/core/safe.ts` | `safeCall`, logger debug |
| `src/core/storage.ts` | Pembungkus storage aman-gagal |
| `src/core/uuid.ts` | UUIDv7 |
| `src/transport/queue.ts` | `BatchQueue` |
| `src/transport/persistence.ts` | `BatchStore` (IndexedDB + fallback) |
| `src/transport/backoff.ts` | Klasifikasi respons + penjadwalan retry |
| `src/transport/sender.ts` | `Sender` (fetch keepalive + beacon) |
| `src/transport/compressor.ts` | Pemilih strategi gzip + fallback |
| `src/transport/worker/gzip.worker.ts` | Worker inline |
| `src/privacy/redactor.ts` | Redaksi PII pada nilai & item |
| `src/privacy/urlScrubber.ts` | Scrubbing URL |
| `src/privacy/masking.ts` | Opsi masking DOM untuk rrweb |
| `src/telemetry/errors.ts` | Error & rejection listener |
| `src/telemetry/network.ts` | Interceptor fetch & XHR |
| `src/telemetry/breadcrumbs.ts` | Ring buffer + click/input listener |
| `src/telemetry/navigation.ts` | Route change listener |
| `src/replay/recorder.ts` | Wrapper `rrweb.record` |
| `src/replay/chunker.ts` | Pemecah event rrweb |
| `src/core/client.ts` | `ARTrackerClient` — perakitan seluruh lapis |
| `src/index.ts` | Entry publik (singleton `ARTracker`) |
| `src/replay/index.ts` | Entry `./replay` |

---

## Task 1: Scaffold paket, build pipeline, dan size gate

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.size-limit.json`, `eslint.config.js`, `.gitignore`, `src/index.ts`, `src/types.ts`
- Create: `.github/workflows/sdk-web.yml`
- Test: `src/__tests__/smoke.test.ts`

**Interfaces:**
- Consumes: —
- Produces: tipe publik di `src/types.ts` yang dipakai seluruh task berikutnya:
  `ItemType = 'event' | 'log' | 'session'`;
  `LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'`;
  `RawItem { id: string; type: ItemType; name?: string; level?: LogLevel; message?: string; timestamp: string; session_id?: string; user_id?: string; attributes?: Record<string, unknown> }`;
  `Envelope { sent_at: string; sdk: { name: string; version: string }; context: Record<string, unknown>; items: RawItem[] }`;
  `ARTrackerOptions` dan `ResolvedConfig` (bentuk mengikuti ARCHITECTURE §3.1).

- [ ] **Step 1: Inisialisasi paket**

`package.json` bernama `@artracker/browser`, `type: "module"`, `sideEffects: false`, `exports` map untuk `"."` dan `"./replay"`, `rrweb` sebagai `peerDependencies` + `peerDependenciesMeta.rrweb.optional = true`. Script: `build`, `test`, `lint`, `typecheck`, `size`.

- [ ] **Step 2: Konfigurasi build**

`tsup.config.ts`: dua entry (`src/index.ts`, `src/replay/index.ts`), format `['esm','cjs','iife']` untuk entry utama dan `['esm','cjs']` untuk replay, `globalName: 'ARTracker'`, `target: 'es2020'`, `dts`, `treeshake`, `sourcemap`, `define: { __AR_VERSION__: JSON.stringify(pkg.version) }`.

- [ ] **Step 3: Tulis tipe bersama di `src/types.ts`**

Isi persis seperti blok Produces di atas. Tidak ada logika.

- [ ] **Step 4: Tulis smoke test**

```ts
test('entry mengekspor ARTracker dengan method publik', async () => {
  const { ARTracker } = await import('../index')
  expect(typeof ARTracker.init).toBe('function')
  expect(typeof ARTracker.track).toBe('function')
})
```

- [ ] **Step 5: Jalankan test — harus GAGAL**

Run: `pnpm test` → Expected: FAIL, `ARTracker` belum diekspor.

- [ ] **Step 6: Buat stub `src/index.ts`**

Ekspor objek `ARTracker` dengan method dari ARCHITECTURE §3.1 yang seluruhnya masih no-op. Stub ini akan digantikan di Task 12.

- [ ] **Step 7: Verifikasi test, build, dan size gate**

Run: `pnpm test && pnpm build && pnpm size`
Expected: test PASS; build menghasilkan `dist/index.{js,cjs,global.js}` + `.d.ts`; `size` melaporkan jauh di bawah 18 kB.

- [ ] **Step 8: Workflow CI**

`.github/workflows/sdk-web.yml` menjalankan `lint → typecheck → test → size → build` pada push dan PR yang menyentuh `artracker-web-sdk/**`. Gate `size` memakai limit dari `.size-limit.json` (18 kB entry utama, 4 kB replay).

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "chore: scaffold @artracker/browser package with build and size gate"
```

---

## Task 2: Konfigurasi aman-gagal (`config.ts`)

**Files:**
- Create: `src/core/config.ts`, `src/core/safe.ts`
- Test: `src/core/__tests__/config.test.ts`

**Interfaces:**
- Consumes: `ARTrackerOptions`, `ResolvedConfig` (Task 1).
- Produces: `resolveConfig(options: ARTrackerOptions): ResolvedConfig`; `class ARTrackerConfigError extends Error`; `safeCall<T>(fn: () => T, debug: boolean, label: string): T | undefined`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('menolak appKey dengan prefix art_sec_', () => {
  expect(() => resolveConfig({ appKey: 'art_sec_x'.padEnd(40,'0'), endpoint: 'https://a/api/v1/ingest' }))
    .toThrow(ARTrackerConfigError)
})
test('menolak appKey atau endpoint yang hilang', () => {
  expect(() => resolveConfig({ endpoint: 'https://a' } as never)).toThrow(ARTrackerConfigError)
})
test('mengisi default sesuai ARCHITECTURE §3.1', () => {
  const c = resolveConfig({ appKey: VALID_KEY, endpoint: 'https://a/api/v1/ingest' })
  expect(c.replay.enabled).toBe(false)
  expect(c.replay.sampleRate).toBe(0.1)
  expect(c.batch).toEqual({ maxItems: 50, maxBytes: 131072, flushIntervalMs: 5000 })
  expect(c.environment).toBe('production')
  expect(c.privacy.maskAllInputs).toBe(true)
})
test('menjepit nilai di luar rentang', () => {
  expect(resolveConfig({ ...base, sampleRate: 5 }).sampleRate).toBe(1)
  expect(resolveConfig({ ...base, batch: { maxItems: 9999 } }).batch.maxItems).toBe(50)
})
test('safeCall menelan error dan mengembalikan undefined', () => {
  expect(safeCall(() => { throw new Error('x') }, false, 'test')).toBeUndefined()
})
```

- [ ] **Step 2: Jalankan — harus GAGAL**

Run: `pnpm vitest run src/core/__tests__/config.test.ts` → FAIL, modul belum ada.

- [ ] **Step 3: Implementasi `resolveConfig` dan `safeCall`**

`resolveConfig` memvalidasi `appKey` (prefix `art_live_`, panjang 32–128 sesuai CONTRACT §2) dan `endpoint` (URL absolut), lalu menggabungkan opsi pengguna di atas default, menjepit `sampleRate`/`replay.sampleRate` ke `[0,1]` dan `batch.maxItems` ke `[1,50]`, `batch.maxBytes` ke `[1024, 131072]`.
`safeCall` membungkus `try/catch`; saat `debug` aktif, mencetak `[artracker] <label>` beserta error ke `console.warn`.

- [ ] **Step 4: Jalankan — harus LULUS**

Run: `pnpm vitest run src/core/__tests__/config.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts src/core/safe.ts src/core/__tests__/config.test.ts
git commit -m "feat(core): add config resolution and safeCall guard"
```

---

## Task 3: Storage aman-gagal dan Session Manager

**Files:**
- Create: `src/core/storage.ts`, `src/core/uuid.ts`, `src/core/session.ts`
- Test: `src/core/__tests__/storage.test.ts`, `src/core/__tests__/session.test.ts`

**Interfaces:**
- Consumes: `ResolvedConfig` (Task 2).
- Produces:
  `safeStorage(kind: 'session' | 'local'): KeyValueStore` dengan `KeyValueStore { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void }`;
  `uuidv7(): string`;
  `class SessionManager { constructor(cfg: ResolvedConfig, now?: () => number); get id(): string; touch(): void; reset(): string; onRotate(cb: (id: string, previous: string | null) => void): void }`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// storage.test.ts — Review Focus #1
test('fallback ke memori saat storage melempar', () => {
  vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new Error('blocked') })
  const s = safeStorage('session')
  expect(() => s.set('k', 'v')).not.toThrow()
  expect(s.get('k')).toBe('v')      // nilai tetap bertahan in-memory
})

// session.test.ts
test('membuat dan mempertahankan id di sessionStorage', () => { /* id sama pada instance kedua */ })
test('id berawalan ses_ dan panjang <= 128', () => {
  expect(new SessionManager(cfg).id).toMatch(/^ses_[0-9a-f]{32}$/)
})
test('rotasi setelah idle 30 menit', () => { /* clock palsu +30m, touch(), id berubah */ })
test('rotasi setelah durasi maksimum 4 jam meski aktif', () => { /* touch tiap 10m selama 4j1m */ })
test('reset() menghasilkan id baru dan memanggil onRotate', () => {})
```

- [ ] **Step 2: Jalankan — harus GAGAL**

Run: `pnpm vitest run src/core/__tests__/` → FAIL.

- [ ] **Step 3: Implementasi ketiga modul**

`safeStorage` mengakses `window.sessionStorage`/`localStorage` di dalam `try/catch` **pada setiap operasi** (bukan sekali saat konstruksi — Safari dapat mencabut izin di tengah jalan) dan menulis ke `Map` in-memory sebagai cadangan.
`uuidv7()` menyusun 48 bit timestamp milidetik + versi 7 + sisanya dari `crypto.getRandomValues`, dikembalikan tanpa tanda hubung.
`SessionManager` menyimpan `{ id, startedAt, lastSeenAt }` sebagai JSON di key `ar_ses`; `touch()` memperbarui `lastSeenAt` dan merotasi bila `now - lastSeenAt > 30 menit` atau `now - startedAt > 4 jam`.

- [ ] **Step 4: Jalankan — harus LULUS**

Run: `pnpm vitest run src/core/__tests__/` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/{storage,uuid,session}.ts src/core/__tests__
git commit -m "feat(core): add fail-safe storage, uuidv7, and session manager"
```

---

## Task 4: Identitas pengguna dan envelope context

**Files:**
- Create: `src/core/user.ts`, `src/core/context.ts`
- Test: `src/core/__tests__/user.test.ts`, `src/core/__tests__/context.test.ts`

**Interfaces:**
- Consumes: `safeStorage` (Task 3), `ResolvedConfig` (Task 2).
- Produces:
  `class UserStore { get userId(): string | undefined; get traits(): Record<string, unknown> | undefined; identify(userId: string, traits?: Record<string, unknown>): void; reset(): void }`;
  `buildContext(cfg: ResolvedConfig): Record<string, unknown>`;
  `collectDeviceMeta(): Record<string, unknown>`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('userId bertahan di localStorage antar instance', () => {})
test('userId dipotong ke 128 karakter', () => {
  u.identify('x'.repeat(300)); expect(u.userId).toHaveLength(128)
})
test('reset() menghapus userId dan traits', () => {})
test('buildContext memuat environment, app_version, dan sdk_platform web', () => {
  expect(buildContext(cfg)).toMatchObject({ environment: 'production', sdk_platform: 'web' })
})
test('collectDeviceMeta tidak melempar saat navigator minim', () => {})
```

- [ ] **Step 2: Jalankan — harus GAGAL.** Run: `pnpm vitest run src/core/__tests__/user.test.ts src/core/__tests__/context.test.ts`

- [ ] **Step 3: Implementasi**

`UserStore` memakai key `ar_uid` dan `ar_traits` pada `safeStorage('local')`, memotong `userId` ke 128 karakter (CONTRACT §7).
`buildContext` mengembalikan `{ environment, app_version, page, referrer, screen, ua, lang, tz, sdk_platform: 'web' }`; seluruh pengambilan properti `navigator`/`screen` dibungkus guard karena hanya `environment` dan `app_version` yang disimpan backend (CONTRACT §6) — sisanya tetap dibawa untuk disalin ke `session_start`.

- [ ] **Step 4: Jalankan — harus LULUS.**

- [ ] **Step 5: Commit**

```bash
git add src/core/{user,context}.ts src/core/__tests__
git commit -m "feat(core): add user identity store and envelope context"
```

---

## Task 5: Envelope builder dan bus internal

**Files:**
- Create: `src/core/envelope.ts`, `src/core/bus.ts`
- Test: `src/core/__tests__/envelope.test.ts`

**Interfaces:**
- Consumes: `uuidv7` (Task 3), tipe dari Task 1.
- Produces:
  `createItem(input: { type: ItemType; name?: string; level?: LogLevel; message?: string; attributes?: Record<string, unknown>; sessionId?: string; userId?: string; at?: number }): RawItem`;
  `buildEnvelope(items: RawItem[], cfg: ResolvedConfig, context: Record<string, unknown>, now: number): Envelope`;
  `MAX_ATTRIBUTE_BYTES = 24576`;
  `class Bus { on(fn: (item: RawItem) => void): () => void; emit(item: RawItem): void }`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('setiap item memiliki id uuidv7 dan timestamp RFC3339', () => {
  const i = createItem({ type: 'event', name: 'x' })
  expect(i.id).toMatch(/^[0-9a-f]{8}-/); expect(i.timestamp).toMatch(/Z$/)
})
test('name dipotong ke 255 dan message ke 4096', () => {})
test('level dikosongkan untuk tipe selain log', () => {
  expect(createItem({ type: 'event', name: 'x', level: 'error' }).level).toBeUndefined()
})
// Review Focus #3
test('attributes di atas 24 KB dipangkas dan ditandai', () => {
  const i = createItem({ type: 'event', name: 'x', attributes: { blob: 'a'.repeat(40_000) } })
  expect(JSON.stringify(i.attributes).length).toBeLessThanOrEqual(24576)
  expect(i.attributes!._artracker_truncated).toBe(true)
})
// Review Focus #5
test('envelope selalu memuat sent_at berpasangan dengan timestamp item', () => {
  const e = buildEnvelope([createItem({ type: 'event', name: 'x', at: 1000 })], cfg, {}, 5000)
  expect(e.sent_at).toBe(new Date(5000).toISOString())
  expect(e.items[0].timestamp).toBe(new Date(1000).toISOString())
})
test('sdk meta memakai nama artracker-web', () => {
  expect(buildEnvelope([], cfg, {}, 0).sdk.name).toBe('artracker-web')
})
```

- [ ] **Step 2: Jalankan — harus GAGAL.**

- [ ] **Step 3: Implementasi**

Pemangkasan `attributes`: serialisasi, bila melebihi `MAX_ATTRIBUTE_BYTES` buang key terbesar satu per satu sampai muat, lalu tambahkan `_artracker_truncated: true` dan `_original_bytes`. Pendekatan ini mempertahankan field kecil yang biasanya paling berguna, berbeda dari backend yang membuang seluruh objek (CONTRACT §5).
`Bus` adalah emitter satu-tipe tanpa dependency.

- [ ] **Step 4: Jalankan — harus LULUS.**

- [ ] **Step 5: Commit**

```bash
git add src/core/{envelope,bus}.ts src/core/__tests__/envelope.test.ts
git commit -m "feat(core): add envelope builder with contract-safe truncation"
```

---

## Task 6: Batch queue

**Files:**
- Create: `src/transport/queue.ts`
- Test: `src/transport/__tests__/queue.test.ts`

**Interfaces:**
- Consumes: `RawItem` (Task 1), `ResolvedConfig` (Task 2).
- Produces: `class BatchQueue { constructor(cfg: ResolvedConfig, onFlush: (items: RawItem[], reason: FlushReason) => void); add(item: RawItem): void; flush(reason: FlushReason): void; get size(): number; stop(): void }`; `type FlushReason = 'count' | 'bytes' | 'timer' | 'lifecycle' | 'manual' | 'online'`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('flush saat mencapai maxItems', () => { /* 50 item → onFlush sekali dengan reason 'count' */ })
test('flush saat melewati maxBytes', () => {})
test('flush saat timer flushIntervalMs berjalan', () => { /* fake timers */ })
test('flush tidak memanggil onFlush saat antrean kosong', () => {})
test('item yang di-flush dikeluarkan dari antrean', () => {})
```

- [ ] **Step 2: Jalankan — harus GAGAL.**

- [ ] **Step 3: Implementasi `BatchQueue`**

Menyimpan item di array plus akumulator ukuran (panjang JSON per item dihitung sekali saat `add`, jangan menyerialisasi ulang seluruh antrean tiap penambahan). Timer dibuat dengan `setInterval` dan dibersihkan oleh `stop()`.

- [ ] **Step 4: Jalankan — harus LULUS.**

- [ ] **Step 5: Commit**

```bash
git add src/transport/queue.ts src/transport/__tests__/queue.test.ts
git commit -m "feat(transport): add batch queue with count, byte, and timer triggers"
```

---

## Task 7: Penyimpanan batch persisten

**Files:**
- Create: `src/transport/persistence.ts`
- Test: `src/transport/__tests__/persistence.test.ts`

**Interfaces:**
- Consumes: `RawItem` (Task 1), `safeStorage` (Task 3).
- Produces:
  `interface PendingBatch { id: string; createdAt: number; bytes: number; items: RawItem[] }`;
  `interface BatchStore { put(b: PendingBatch): Promise<void>; listPending(limit?: number): Promise<PendingBatch[]>; delete(id: string): Promise<void>; prune(opts: { maxBytes: number; maxAgeMs: number }): Promise<number> }`;
  `createBatchStore(): Promise<BatchStore>`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('batch bertahan dan terbaca kembali', async () => {})
test('delete menghapus batch', async () => {})
test('prune membuang batch melewati maxAgeMs', async () => {})
test('prune membuang replay_chunk lebih dulu saat kuota penuh', async () => {
  // isi dengan replay_chunk + log error, prune ke kuota kecil
  const left = await store.listPending()
  expect(left.every(b => b.items.every(i => i.name !== 'replay_chunk'))).toBe(true)
})
// Review Focus #1
test('jatuh ke localStorage saat indexedDB tidak tersedia', async () => {
  vi.stubGlobal('indexedDB', undefined)
  const s = await createBatchStore()
  await s.put(batch); expect(await s.listPending()).toHaveLength(1)
})
```

- [ ] **Step 2: Jalankan — harus GAGAL.** Test memakai `fake-indexeddb/auto`.

- [ ] **Step 3: Implementasi**

IndexedDB: database `artracker`, object store `batches`, `keyPath: 'id'`, indeks `createdAt`. Fallback `localStorage` dengan prefix `ar_q_` dan cap 1 MB.
`prune` mengurutkan kandidat buang berdasarkan prioritas — pertama batch yang seluruh itemnya `name === 'replay_chunk'`, lalu `type === 'event'`, terakhir `type === 'log'` dengan `level` `error`/`fatal` — dan di dalam tiap tingkat memakai FIFO `createdAt`.

- [ ] **Step 4: Jalankan — harus LULUS.**

- [ ] **Step 5: Commit**

```bash
git add src/transport/persistence.ts src/transport/__tests__/persistence.test.ts
git commit -m "feat(transport): add IndexedDB batch store with priority eviction"
```

---

## Task 8: Kebijakan respons dan backoff

**Files:**
- Create: `src/transport/backoff.ts`
- Test: `src/transport/__tests__/backoff.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  `type SendOutcome = { kind: 'accepted' } | { kind: 'retry'; afterMs: number } | { kind: 'drop'; reason: string } | { kind: 'split' } | { kind: 'kill'; reason: string }`;
  `classifyResponse(status: number, retryAfter: string | null, attempt: number): SendOutcome`;
  `nextDelayMs(attempt: number, retryAfterSec?: number): number`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('202 => accepted', () => expect(classifyResponse(202,null,0).kind).toBe('accepted'))
test('400 => drop permanen', () => expect(classifyResponse(400,null,0).kind).toBe('drop'))
// Review Focus #4
test('401 => kill switch', () => expect(classifyResponse(401,null,0).kind).toBe('kill'))
test('413 => split', () => expect(classifyResponse(413,null,0).kind).toBe('split'))
test('429 menghormati Retry-After di atas perhitungan lokal', () => {
  expect(classifyResponse(429,'120',0)).toEqual({ kind: 'retry', afterMs: 120_000 })
})
test('503 tanpa Retry-After memakai backoff eksponensial', () => {})
test('nextDelayMs naik eksponensial dan dibatasi 5 menit', () => {
  expect(nextDelayMs(0)).toBeGreaterThanOrEqual(24_000)   // 30s ± 20%
  expect(nextDelayMs(20)).toBeLessThanOrEqual(300_000)
})
```

- [ ] **Step 2: Jalankan — harus GAGAL.**

- [ ] **Step 3: Implementasi**

Peta status mengikuti CONTRACT §10. `nextDelayMs = min(30_000 * 2^attempt, 300_000)` dikalikan jitter `0.8–1.2`; `retryAfterSec` bila ada selalu menang.

- [ ] **Step 4: Jalankan — harus LULUS.**

- [ ] **Step 5: Commit**

```bash
git add src/transport/backoff.ts src/transport/__tests__/backoff.test.ts
git commit -m "feat(transport): add response policy and exponential backoff"
```

---

## Task 9: Kompresor dengan fallback berjenjang

**Files:**
- Create: `src/transport/compressor.ts`, `src/transport/worker/gzip.worker.ts`
- Test: `src/transport/__tests__/compressor.test.ts`

**Interfaces:**
- Consumes: `ResolvedConfig` (Task 2).
- Produces:
  `interface CompressedBody { body: BodyInit; encoding: 'gzip' | null }`;
  `createCompressor(cfg: ResolvedConfig): { compress(json: string): Promise<CompressedBody>; dispose(): void }`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('memakai CompressionStream dan menandai encoding gzip', async () => {
  const r = await createCompressor(cfg).compress('{"a":1}')
  expect(r.encoding).toBe('gzip')
})
test('fallback ke JSON polos saat CompressionStream tidak ada', async () => {
  vi.stubGlobal('CompressionStream', undefined)
  const r = await createCompressor(cfg).compress('{"a":1}')
  expect(r).toEqual({ body: '{"a":1}', encoding: null })
})
test('fallback ke main thread saat Worker tidak tersedia', async () => {})
test('compress tidak pernah melempar', async () => {})
```

- [ ] **Step 2: Jalankan — harus GAGAL.**

- [ ] **Step 3: Implementasi**

Urutan percobaan: Worker inline (Blob URL, atau `cfg.workerUrl` bila disetel) → `CompressionStream('gzip')` di main thread dalam `requestIdleCallback` → JSON polos. Kegagalan pada satu tingkat menurunkan tingkat secara permanen untuk sesi itu agar tidak membayar biaya percobaan berulang. Worker hanya berisi gzip + `postMessage` balik; pengiriman HTTP tetap di main thread agar penanganan respons terpusat di Task 10.

- [ ] **Step 4: Jalankan — harus LULUS.**

- [ ] **Step 5: Commit**

```bash
git add src/transport/compressor.ts src/transport/worker src/transport/__tests__/compressor.test.ts
git commit -m "feat(transport): add gzip compressor with worker and plain-JSON fallbacks"
```

---

## Task 10: Sender

**Files:**
- Create: `src/transport/sender.ts`
- Test: `src/transport/__tests__/sender.test.ts`

**Interfaces:**
- Consumes: `classifyResponse` (Task 8), `createCompressor` (Task 9), `Envelope` (Task 1).
- Produces: `class Sender { constructor(cfg: ResolvedConfig); send(envelope: Envelope): Promise<SendOutcome>; sendOnUnload(envelope: Envelope): boolean }`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('POST memakai header X-Artracker-Key dan keepalive', async () => {
  await sender.send(env)
  const [url, init] = fetchMock.mock.calls[0]
  expect(init.headers['X-Artracker-Key']).toBe(cfg.appKey)
  expect(init.keepalive).toBe(true)
})
test('menyetel Content-Encoding gzip hanya saat terkompresi', async () => {})
test('error jaringan menghasilkan outcome retry, bukan lemparan', async () => {
  fetchMock.mockRejectedValue(new TypeError('failed'))
  expect((await sender.send(env)).kind).toBe('retry')
})
test('sendOnUnload memakai sendBeacon dengan api_key di query dan Blob text/plain', () => {
  sender.sendOnUnload(env)
  const [url, blob] = beaconMock.mock.calls[0]
  expect(url).toContain('api_key=' + cfg.appKey)
  expect(blob.type).toBe('text/plain')
})
test('sendOnUnload mengembalikan false saat payload melebihi 60 KB', () => {})
```

- [ ] **Step 2: Jalankan — harus GAGAL.**

- [ ] **Step 3: Implementasi `Sender`**

`send` menyerialisasi, mengompresi, lalu `fetch(cfg.endpoint, { method:'POST', keepalive:true, headers, body })` dan menyerahkan `status` + header `Retry-After` ke `classifyResponse`. Kegagalan jaringan (promise reject) dipetakan ke `{ kind:'retry', afterMs: nextDelayMs(attempt) }`.
`sendOnUnload` mengirim JSON tanpa kompresi via `navigator.sendBeacon` ke `endpoint + '?api_key=' + appKey` dengan `Blob` bertipe `text/plain` (CONTRACT §3), dan menolak payload di atas 60 KB.

- [ ] **Step 4: Jalankan — harus LULUS.**

- [ ] **Step 5: Commit**

```bash
git add src/transport/sender.ts src/transport/__tests__/sender.test.ts
git commit -m "feat(transport): add sender with keepalive fetch and beacon unload path"
```

---

## Task 11: Mesin redaksi PII

**Files:**
- Create: `src/privacy/redactor.ts`, `src/privacy/urlScrubber.ts`
- Test: `src/privacy/__tests__/redactor.test.ts`, `src/privacy/__tests__/urlScrubber.test.ts`

**Interfaces:**
- Consumes: `RawItem`, `ResolvedConfig`.
- Produces:
  `redactString(input: string): string`;
  `redactValue(value: unknown, depth?: number): unknown`;
  `redactItem(item: RawItem, cfg: ResolvedConfig): RawItem | null`;
  `scrubUrl(url: string, opts: { maskUrlPathIds: boolean }): string`.

- [ ] **Step 1: Tulis test yang gagal (corpus PII)**

```ts
test.each([
  ['budi@example.com',                    /b\*+@example\.com/],
  ['4539 1488 0343 6467',                 /\*{4} \*{4} \*{4} 6467/],   // Luhn valid
  ['+628123456789',                       /\*+6789/],
  ['3201234567890123',                    /\[redacted\]/],              // NIK 16 digit
  ['eyJhbGciOiJIUzI1NiJ9.e30.x',          /\[redacted\]/],              // JWT
  ['Bearer abcdef123456',                 /\[redacted\]/],
])('meredaksi %s', (input, expected) => expect(redactString(input)).toMatch(expected))

test('angka 16 digit yang gagal Luhn tidak diredaksi sebagai kartu', () => {
  expect(redactString('1234567812345678')).toContain('1234567812345678')
})
test('deny-list berbasis key meredaksi nilai apa pun', () => {
  expect(redactValue({ password: 'hunter2', note: 'ok' })).toEqual({ password: '[redacted]', note: 'ok' })
})
test('traversal berhenti di kedalaman 6', () => {})
test('beforeSend mengembalikan null membuang item', () => {
  expect(redactItem(item, { ...cfg, beforeSend: () => null })).toBeNull()
})
test('beforeSend yang melempar tidak menjatuhkan pipeline', () => {
  expect(redactItem(item, { ...cfg, beforeSend: () => { throw new Error('x') } })).not.toBeUndefined()
})
// urlScrubber
test('meredaksi query param sensitif', () => {
  expect(scrubUrl('https://a/x?token=abc&page=2', o)).toBe('https://a/x?token=[redacted]&page=2')
})
test('maskUrlPathIds mengganti segmen uuid dan angka panjang dengan :id', () => {})
```

- [ ] **Step 2: Jalankan — harus GAGAL.**

- [ ] **Step 3: Implementasi**

Urutan pencocokan penting: JWT dan `Bearer` lebih dulu, lalu kartu kredit (kandidat 13–19 digit divalidasi Luhn sebelum diredaksi agar nomor pesanan tidak ikut tersamar), lalu NIK, telepon, dan terakhir email. Deny-list key dievaluasi sebelum isi nilai diperiksa. `redactItem` menjalankan redaksi pada `message`, `name`, dan `attributes`, lalu memanggil `cfg.beforeSend` di dalam `safeCall` sebagai langkah terakhir.

- [ ] **Step 4: Jalankan — harus LULUS.**

- [ ] **Step 5: Commit**

```bash
git add src/privacy src/privacy/__tests__
git commit -m "feat(privacy): add PII redactor and URL scrubber"
```

---

## Task 12: Client — perakitan pipeline dan API publik

**Files:**
- Create: `src/core/client.ts`, `src/telemetry/breadcrumbs.ts` (hanya kelas `BreadcrumbBuffer`)
- Modify: `src/index.ts` (ganti stub Task 1)
- Test: `src/core/__tests__/client.test.ts`, `src/telemetry/__tests__/breadcrumbs.test.ts`, `src/__tests__/pipeline.integration.test.ts`

**Interfaces:**
- Consumes: Task 2–11 seluruhnya.
- Produces:
  `class ARTrackerClient` dengan method sesuai ARCHITECTURE §3.1;
  `interface Breadcrumb { type: string; at: number; data: Record<string, unknown> }`;
  `class BreadcrumbBuffer { constructor(limit: number); add(b: Breadcrumb): void; snapshot(): Breadcrumb[] }` (ring buffer murni; listener yang mengisinya datang di Task 14);
  `interface TelemetryContext { emit(input: Parameters<typeof createItem>[0]): void; cfg: ResolvedConfig; breadcrumbs: BreadcrumbBuffer; session: SessionManager }` — dipakai oleh seluruh listener di Task 13–15 dan recorder di Task 16.

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('track sebelum init ditampung lalu dialirkan setelah init', () => {
  ARTracker.track('early'); ARTracker.init(opts)
  expect(sentItems().map(i => i.name)).toContain('early')
})
test('buffer pre-init dibatasi 100 item', () => {})
test('init kedua tidak membuat instance baru', () => {})
test('init dengan opsi invalid tidak melempar ke pemanggil', () => {
  expect(() => ARTracker.init({} as never)).not.toThrow()
})
test('identify menyetel user_id pada item berikutnya', () => {})
test('sesi baru memancarkan item session_start bertipe session', () => {})
test('setiap item melewati redactor sebelum masuk store', async () => {
  ARTracker.track('x', { email: 'budi@example.com' })
  await ARTracker.flush()
  expect(JSON.stringify(await store.listPending())).not.toContain('budi@example.com')
})
test('outcome kill menghentikan pengiriman berikutnya', () => {})
test('shutdown melepas listener dan menghentikan timer', () => {})

// breadcrumbs.test.ts
test('ring buffer membuang entri terlama di atas limit', () => {})
```

- [ ] **Step 2: Jalankan — harus GAGAL.**

- [ ] **Step 3: Implementasi `ARTrackerClient` dan ganti stub `src/index.ts`**

Perakitan: `resolveConfig → SessionManager + UserStore + buildContext → Bus → redactItem → BatchQueue → BatchStore.put → Sender.send → outcome handling`. `flush()` mengembalikan promise yang selesai setelah batch terkirim atau tersimpan. Pada `init()`, batch pending dibaca dari store dan dikirim ulang dengan throttle maksimum 5 batch per detik (CONTRACT §9). Listener `pagehide`/`visibilitychange: hidden` memanggil `sendOnUnload`; listener `online` memicu `flush('online')`.

- [ ] **Step 4: Tulis integration test terhadap backend nyata**

`src/__tests__/pipeline.integration.test.ts` dilewati (`describe.skipIf`) kecuali `ARTRACKER_E2E_ENDPOINT` dan `ARTRACKER_E2E_KEY` tersedia. Isi: kirim satu batch berisi `event` + `log`, assert respons `202` dengan `queued: 2`, lalu ulangi dengan `Content-Encoding: gzip` dan assert `202` juga.

- [ ] **Step 5: Jalankan — harus LULUS**

Run: `pnpm test` (unit) lalu, dengan backend lokal hidup (`make api` + key `art_live_`):
`ARTRACKER_E2E_ENDPOINT=http://localhost:8080/api/v1/ingest ARTRACKER_E2E_KEY=art_live_... pnpm vitest run src/__tests__/pipeline.integration.test.ts`
Expected: keduanya PASS; data terlihat di `GET /api/v1/projects/:id/events`.

- [ ] **Step 6: Verifikasi size gate**

Run: `pnpm build && pnpm size` → entry utama masih ≤18 kB.

- [ ] **Step 7: Commit**

```bash
git add src/core/client.ts src/index.ts src/core/__tests__/client.test.ts src/__tests__
git commit -m "feat(core): wire ARTracker client pipeline end to end"
```

---

## Task 13: Listener error

**Files:**
- Create: `src/telemetry/errors.ts`
- Test: `src/telemetry/__tests__/errors.test.ts`

**Interfaces:**
- Consumes: `TelemetryContext` (Task 12).
- Produces: `installErrorListeners(ctx: TelemetryContext): () => void`; `fingerprintError(name: string, stack?: string): string`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('window error menghasilkan item log level error', () => {})
test('unhandledrejection ditandai attributes.kind', () => {})
test('error pada img/script menghasilkan resource_error level warn', () => {})
test('stack dipotong ke 16 KB', () => {})
test('error identik dalam 10 detik hanya dikirim sekali', () => {})
test('circuit breaker berhenti setelah 20 error dalam satu menit', () => {})
test('listener dilepas setelah fungsi pembersih dipanggil', () => {})
```

- [ ] **Step 2: Jalankan — harus GAGAL.**

- [ ] **Step 3: Implementasi**

Memakai `addEventListener('error', …, true)` dan `addEventListener('unhandledrejection', …)` — aditif, tidak menimpa `window.onerror` milik aplikasi host. Dedup memakai `Map<fingerprint, lastSentAt>`; breadcrumb terkini dilampirkan ke `attributes.breadcrumbs`.

- [ ] **Step 4: Jalankan — harus LULUS.**

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/errors.ts src/telemetry/__tests__/errors.test.ts
git commit -m "feat(telemetry): capture errors and rejections with dedup and circuit breaker"
```

---

## Task 14: Breadcrumbs dan navigasi

**Files:**
- Modify: `src/telemetry/breadcrumbs.ts` (tambah listener di samping `BreadcrumbBuffer` dari Task 12)
- Create: `src/telemetry/navigation.ts`
- Test: `src/telemetry/__tests__/breadcrumbs.test.ts` (tambah), `src/telemetry/__tests__/navigation.test.ts`

**Interfaces:**
- Consumes: `TelemetryContext`, `BreadcrumbBuffer`, `Breadcrumb` (Task 12); `redactString` (Task 11).
- Produces:
  `installBreadcrumbListeners(ctx: TelemetryContext): () => void`;
  `installNavigationListeners(ctx: TelemetryContext): () => void`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('klik mencatat selector dan teks ≤64 karakter yang sudah diredaksi', () => {})
test('input hanya mencatat status filled/cleared, tidak pernah nilainya', () => {
  typeInto(input, 'rahasia')
  expect(JSON.stringify(buf.snapshot())).not.toContain('rahasia')
})
test('pushState memancarkan event page_view dengan from dan to', () => {})
test('popstate dan hashchange juga memancarkan page_view', () => {})
test('pushState asli tetap berfungsi setelah dipatch dan setelah dilepas', () => {})
```

- [ ] **Step 2: Jalankan — harus GAGAL.**

- [ ] **Step 3: Implementasi**

Listener klik/input dipasang di `document` dengan `{ capture: true, passive: true }`. Patch `history.pushState`/`replaceState` menyimpan referensi asli dan mengembalikannya pada pembersihan.

- [ ] **Step 4: Jalankan — harus LULUS.**

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/{breadcrumbs,navigation}.ts src/telemetry/__tests__
git commit -m "feat(telemetry): add breadcrumb buffer and SPA navigation tracking"
```

---

## Task 15: Interceptor jaringan

**Files:**
- Create: `src/telemetry/network.ts`
- Test: `src/telemetry/__tests__/network.test.ts`

**Interfaces:**
- Consumes: `TelemetryContext` (Task 12), `scrubUrl` (Task 11).
- Produces: `installNetworkInterceptors(ctx: TelemetryContext): () => void`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('fetch menghasilkan item http_request dengan status dan duration_ms', async () => {})
test('level mengikuti status: <400 info, 4xx warn, 5xx error', async () => {})
// Review Focus #2
test('menerima Request object dan URL, bukan hanya string', async () => {
  await fetch(new Request('https://a/x', { method: 'POST' }))
  await fetch(new URL('https://a/y'))
  expect(emitted().map(i => i.attributes.method)).toEqual(['POST', 'GET'])
})
test('body Response tetap dapat dibaca pemanggil', async () => {
  expect(await (await fetch('https://a/x')).json()).toEqual({ ok: true })
})
test('fetch yang reject tetap reject ke pemanggil dan tercatat sebagai error', async () => {})
test('request ke endpoint ingest tidak dicatat', async () => {})
test('url dicatat dalam bentuk ter-scrub', async () => {})
test('XHR mencatat status dan latency via loadend', () => {})
test('fetch asli dipulihkan setelah pembersihan', () => {})
```

- [ ] **Step 2: Jalankan — harus GAGAL.**

- [ ] **Step 3: Implementasi**

Normalisasi argumen pertama `fetch` lewat `new Request(input, init)` untuk menangani string, `URL`, dan `Request` secara seragam — tetapi teruskan argumen **asli** ke `fetch` bawaan agar semantik tidak berubah. Jangan pernah membaca atau mengkloning body response (default `captureBodies: false`). Patch bersifat aditif: simpan `originalFetch` dan panggil itu, sehingga SDK lain yang sudah memasang patch tetap berjalan (R6).

- [ ] **Step 4: Jalankan — harus LULUS.**

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/network.ts src/telemetry/__tests__/network.test.ts
git commit -m "feat(telemetry): intercept fetch and XHR without altering host semantics"
```

---

## Task 16: Session replay — recorder, masking, chunker

**Files:**
- Create: `src/replay/index.ts`, `src/replay/recorder.ts`, `src/replay/chunker.ts`, `src/privacy/masking.ts`
- Modify: `src/core/client.ts` (implementasi `startReplay`/`stopReplay`)
- Test: `src/replay/__tests__/chunker.test.ts`, `src/replay/__tests__/recorder.test.ts`, `src/privacy/__tests__/masking.test.ts`

**Interfaces:**
- Consumes: `TelemetryContext` (Task 12), `redactString` (Task 11).
- Produces:
  `chunkEvents(events: unknown[], maxBytes: number, seqStart: number): Array<{ seq: number; start: number; end: number; full_snapshot: boolean; events: unknown[] }>`;
  `startRecording(ctx: TelemetryContext): Promise<() => void>`;
  `buildMaskOptions(cfg: ResolvedConfig): Record<string, unknown>`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// chunker
test('setiap chunk <= 24 KB setelah serialisasi', () => {})
test('seq berurutan dan start/end mengikuti timestamp event', () => {})
test('event tunggal >24 KB dipotong dan ditandai oversized', () => {
  const [c] = chunkEvents([hugeEvent], 24576, 0)
  expect(c.events[0].oversized).toBe(true)
  expect(JSON.stringify(c).length).toBeLessThanOrEqual(24576)
})
// masking
test('maskAllInputs aktif secara default', () => {})
test('input password dan autocomplete cc-* selalu di-mask meski maskAllInputs false', () => {})
test('data-artracker-block menghasilkan blockSelector', () => {})
test('maskTextFn menjalankan redactString', () => {
  expect(buildMaskOptions(cfg).maskTextFn('budi@example.com')).not.toContain('budi@example')
})
// recorder
test('tidak merekam saat replay.enabled false', async () => {})
test('keputusan sampling deterministik untuk session_id yang sama', async () => {})
test('chunk dipancarkan sebagai item type session name replay_chunk', async () => {})
```

- [ ] **Step 2: Jalankan — harus GAGAL.** Modul `rrweb` di-mock di test recorder.

- [ ] **Step 3: Implementasi**

`recorder.ts` memanggil `import('rrweb')` secara dinamis dan menolak dengan tenang bila paket tidak terpasang (optional peer). Opsi perekaman: `sampling: { mousemove: 50, scroll: 150, input: 'last', media: 800 }`, `recordCanvas: false`, `collectFonts: false`, `checkoutEveryNms: 120000`. Pembuatan chunk dijadwalkan lewat `requestIdleCallback` (fallback `setTimeout(…,0)`).
`client.ts` memuat `./replay` secara dinamis hanya bila `cfg.replay.enabled` dan sesi lolos sampling `hash(session_id) < replay.sampleRate`.

- [ ] **Step 4: Jalankan — harus LULUS.**

- [ ] **Step 5: Verifikasi size gate kedua entry**

Run: `pnpm build && pnpm size`
Expected: entry utama ≤18 kB **dan** tidak mengandung `rrweb` (`grep -c rrweb dist/index.js` bernilai 0); entry replay ≤4 kB.

- [ ] **Step 6: Commit**

```bash
git add src/replay src/privacy/masking.ts src/core/client.ts src/replay/__tests__ src/privacy/__tests__/masking.test.ts
git commit -m "feat(replay): add lazy rrweb recorder with masking and 24KB chunking"
```

---

## Task 17: Pengerasan — kill switch, DNT, SSR

**Files:**
- Modify: `src/core/client.ts`, `src/index.ts`, `src/core/config.ts`
- Test: `src/core/__tests__/hardening.test.ts`

**Interfaces:**
- Consumes: Task 12.
- Produces: `ARTracker.disable(): void`, `ARTracker.enable(): void`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('disable() menghentikan pengumpulan dan bertahan di localStorage', () => {})
test('localStorage ar_disabled=1 membuat init menjadi no-op', () => {})
test('respectDoNotTrack mematikan SDK saat navigator.doNotTrack = "1"', () => {})
test('seluruh method menjadi no-op saat window tidak ada', async () => {
  vi.stubGlobal('window', undefined)
  expect(() => ARTracker.init(opts)).not.toThrow()
  expect(() => ARTracker.track('x')).not.toThrow()
})
```

- [ ] **Step 2: Jalankan — harus GAGAL.**

- [ ] **Step 3: Implementasi**

Kill switch dibaca di awal `init()` sebelum lapis lain dibangun. `respectDoNotTrack` default `false` (opt-in) agar tidak mengubah perilaku pengguna lama secara diam-diam.

- [ ] **Step 4: Jalankan — harus LULUS.**

- [ ] **Step 5: Commit**

```bash
git add src/core src/index.ts src/core/__tests__/hardening.test.ts
git commit -m "feat(core): add kill switch, Do Not Track option, and SSR no-op guards"
```

---

## Task 18: Dokumentasi, contoh, dan rilis 0.1.0

**Files:**
- Create: `README.md` (ganti isi lama), `examples/vanilla/index.html`, `examples/next/README.md`, `CHANGELOG.md`
- Modify: `package.json` (version `0.1.0`), `ARCHITECTURE.md` (isi tabel hasil ukuran akhir)

**Interfaces:**
- Consumes: API publik final (Task 12, 16, 17).
- Produces: —

- [ ] **Step 1: Tulis README**

Memuat: quickstart tiga baris, tabel seluruh opsi `init()` beserta default, bagian privasi (apa yang di-mask otomatis dan cara `data-artracker-mask`), catatan eksplisit bahwa mengaktifkan replay menambah `rrweb` ke bundle aplikasi (R1), dan matriks dukungan browser.

- [ ] **Step 2: Buat contoh**

`examples/vanilla/index.html` memakai build IIFE dari `dist/`. `examples/next/README.md` menunjukkan pemasangan di `app/providers.tsx` dengan `'use client'`.

- [ ] **Step 3: Verifikasi akhir menyeluruh**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm size`
Expected: semuanya PASS. Catat angka ukuran aktual kedua entry.

- [ ] **Step 4: Catat hasil ukuran di `ARCHITECTURE.md` §7**

Tambahkan kolom "Aktual" di tabel budget dengan angka dari Step 3.

- [ ] **Step 5: Commit dan tag**

```bash
git add -A && git commit -m "docs: add README, examples, and record final bundle sizes"
git tag @artracker/browser@0.1.0
```

---

## Di Luar Cakupan Plan Ini

- **Web Vitals** (ARCHITECTURE §5, opsi `vitals`, default `false`) — tidak memiliki task. Fitur opsional yang tidak termasuk Acceptance Criteria issue #11; tambahkan sebagai follow-up setelah `0.1.0` agar tidak menggerus budget 18 kB sebelum angka aktual diketahui.
- **Pemutaran replay di dashboard** — tidak ada endpoint pembacaannya di backend (CONTRACT §11); scope issue lain.
- **Adapter React/Vue sebagai paket terpisah** — pada `0.1.0` hanya didokumentasikan di README (Task 18), bukan kode.

## Catatan Eksekusi

- **Task 1–12 berurutan ketat** — setiap task memakai interface task sebelumnya. Task 13, 14, 15 saling independen setelah Task 12 selesai dan boleh dikerjakan paralel. Task 16 bergantung pada Task 12 dan 14.
- **Gate `pnpm size` dijalankan pada setiap task** yang menambah kode ke `src/` di luar `src/replay/`. Melewati 18 kB berarti task itu belum selesai.
- **Integration test (Task 12 Step 4)** butuh backend lokal hidup dan API key `art_live_` nyata; di CI test ini dilewati otomatis karena variabel lingkungannya tidak ada.
