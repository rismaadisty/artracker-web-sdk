# Technical Architecture Plan — `@artracker/browser`

**Issue:** [P3] feat(sdk-web): Web SDK (@artracker/browser) — tiofani03/artracker#11
**Status:** Diimplementasikan sebagai `0.1.0` (2026-11-05). Deviasi dari dokumen ini dicatat di bagian **12**.
**Prasyarat baca:** [`CONTRACT.md`](./CONTRACT.md) — ringkasan terverifikasi kontrak ingest backend.

---

## 1. Tujuan & Batasan

SDK klien Web/Browser (TypeScript, didistribusikan via NPM) yang dapat dipasang di React, Vue,
Next.js, atau vanilla JS dengan konfigurasi minimal tiga baris, dan mengirim telemetri ke
`POST /api/v1/ingest` milik `artracker`.

### Acceptance Criteria dan cara pemenuhannya

| AC dari issue | Cara dipenuhi | Cara diukur |
| --- | --- | --- |
| Ukuran <45 kB (min+gzip) | Entry bundle ≤18 kB; adapter replay ≤4 kB (lazy); `rrweb` dimuat dinamis dan **tidak** dihitung dalam entry | `size-limit` sebagai gate di CI |
| Tidak memblokir UI thread | Gzip di Web Worker (`JSON.stringify` dan `fetch` tetap di main thread); pemrosesan chunk rrweb di `requestIdleCallback`; semua listener `passive` | Benchmark long-task (`PerformanceObserver` `longtask`), target: tidak ada task >50 ms saat merekam |
| PII otomatis disamarkan sebelum dikirim | Dua lapis: DOM masking (pra-serialisasi rrweb) + payload redaction (semua item, pra-persistence) | Corpus test PII + test "tidak ada data sensitif yang mendarat di IndexedDB" |

### Keputusan yang sudah difinalkan

| # | Keputusan | Alasan |
| --- | --- | --- |
| D1 | **Budget <45 kB diukur pada entry bundle**, bukan total termasuk `rrweb` | `rrweb` record-only saja **≈57 kB gzip** (diukur pada rrweb 2.2.0 dengan esbuild; estimasi awal ~30–40 kB keliru); membundel statis membuat AC mustahil tanpa mengorbankan fitur |
| D2 | **Session replay default OFF** (`replay.enabled: false`) | Privasi (opt-in eksplisit) dan perlindungan kuota 1000 event/s per project |
| D3 | `sdk.name = "artracker-web"` | Konsisten dengan data mock dashboard di `handler/telemetry.go` |
| D4 | Hanya mendukung key `art_live_*` | `art_sec_*` tidak boleh pernah ada di bundle browser |

---

## 2. Peta Modul

```
@artracker/browser
│
├─ core/
│   ├─ client.ts        Facade ARTracker (init/identify/track/flush/shutdown/…)
│   ├─ config.ts        Normalisasi + validasi opsi, defaults, kill-switch
│   ├─ context.ts       Envelope context (env, app_version, page, UA hints)
│   ├─ session.ts       SessionManager (id, idle/max timeout, sessionStorage)
│   ├─ user.ts          Identity store (userId + traits, localStorage)
│   ├─ bus.ts           Emitter internal (listener → pipeline, tanpa coupling)
│   └─ envelope.ts      Builder item → RawItem (type/name/level/attributes/ts)
│
├─ privacy/
│   ├─ redactor.ts      Mesin regex PII (email, kartu, telepon, JWT, NIK, API key)
│   ├─ masking.ts       Aturan DOM masking (selector / attribute / input type)
│   └─ urlScrubber.ts   Scrubbing query param & segmen path
│
├─ replay/              ← lazy chunk, TIDAK masuk entry bundle
│   ├─ recorder.ts      Wrapper rrweb.record + sampling + idle scheduling
│   └─ chunker.ts       Pecah event rrweb menjadi item ≤24 KB
│
├─ telemetry/
│   ├─ errors.ts        window.onerror + unhandledrejection + resource error
│   ├─ network.ts       Interceptor fetch & XMLHttpRequest
│   ├─ breadcrumbs.ts   Ring buffer (click / input / navigation / console / network)
│   └─ navigation.ts    Hook history.pushState/replaceState/popstate/hashchange
│
├─ transport/
│   ├─ queue.ts         Batcher in-memory (trigger: jumlah / byte / waktu)
│   ├─ persistence.ts   IndexedDB store + fallback localStorage
│   ├─ sender.ts        fetch keepalive → sendBeacon (unload) → retry
│   ├─ backoff.ts       Exponential + jitter, menghormati Retry-After
│   └─ worker/          Web Worker: gzip (CompressionStream); POST tetap di main thread
│
└─ index.ts             Public entry (tree-shakeable, side-effect free)
```

### Aliran data

```
Listener / API publik
   → bus
   → envelope builder (RawItem)
   → privacy redactor            ← PII hilang DI SINI, sebelum menyentuh disk
   → queue (memori)
   → [flush trigger]
   → persistence (IndexedDB, status: pending)
   → JSON.stringify (main thread) → Web Worker (gzip)
   → POST /api/v1/ingest
        ├─ 202  → hapus batch dari IndexedDB, reset backoff
        ├─ 429/503 → hormati Retry-After, batch tetap pending
        ├─ 4xx lain → drop permanen (lihat CONTRACT.md §10)
        └─ offline/network error → backoff eksponensial, batch tetap pending
```

---

## 3. Modul Core, Session Manager & Public API

### 3.1 Public API

```ts
ARTracker.init({
  appKey: 'art_live_…',                      // wajib
  endpoint: 'https://api.example.com/api/v1/ingest', // wajib
  environment: 'production',
  appVersion: '2.4.1',
  sampleRate: 1.0,
  replay: { enabled: false, sampleRate: 0.1 },        // D2: default OFF; aktifkan lewat replay() dari '@artracker/browser/replay'
  privacy: { maskAllInputs: true, blockClass: 'ar-block', redactors: [] },
  network: { enabled: true, ignoreUrls: [/\/healthz/], captureBodies: false },
  batch:   { maxItems: 50, maxBytes: 128 * 1024, flushIntervalMs: 5000 },
  offline: { maxQueueBytes: 5 * 1024 * 1024, maxAgeMs: 7 * 24 * 3600 * 1000 },
  beforeSend: (item) => item,                // return null untuk drop
  debug: false,
})

ARTracker.identify(userId, traits?)
ARTracker.track(name, properties?)
ARTracker.log(level, message, attributes?)
ARTracker.captureException(error, context?)
ARTracker.setContext(key, value)
ARTracker.addBreadcrumb(breadcrumb)
ARTracker.flush(): Promise<void>
ARTracker.startReplay() / ARTracker.stopReplay()
ARTracker.reset()        // logout: identitas dan sesi baru
ARTracker.disable() / ARTracker.enable()   // opt-out persisten (menghapus batch tertunda)
ARTracker.shutdown()     // lepas semua patch & listener, flush terakhir
```

**Prinsip desain:**

- `init()` non-blocking dan **idempoten** — panggilan kedua mengembalikan instance yang sama
  dengan peringatan di mode debug.
- Semua API aman dipanggil **sebelum** `init()`: ditampung di pre-init buffer (maks 100 item)
  lalu dialirkan setelah inisialisasi. Ini membuat pemasangan `<script async>` tetap aman.
- Setiap method publik dibungkus `safeCall` — **SDK tidak boleh pernah melempar error ke
  aplikasi host**. Kegagalan internal hanya muncul di console saat `debug: true`.
- SSR-safe: seluruh entry memeriksa `typeof window === 'undefined'` dan menjadi no-op, sehingga
  aman di-import dari komponen server Next.js.

### 3.2 Session Manager

| Aspek | Keputusan |
| --- | --- |
| Format id | `ses_` + UUIDv7 tanpa tanda hubung (≤128 char, sesuai `MaxStringIDLen`) |
| Penyimpanan | `sessionStorage` (per tab, sesuai issue); mirror opsional ke `localStorage` bila `crossTabSession: true` (default `false`) |
| Rotasi | Idle 30 menit **atau** durasi maksimum 4 jam **atau** `reset()` |
| Event sesi | Setiap sesi **baru** (bukan sesi yang dipulihkan saat muat ulang halaman) memancarkan `type:"session"`, `name:"session_start"` dengan attributes `{referrer, entry_url, screen, viewport, ua, lang, tz}` |
| Identitas | `user_id` persisten di `localStorage` (`ar_uid`); traits dikirim pada item `$identify` |
| Ketahanan | Semua akses storage dibungkus try/catch (Safari private mode, storage diblokir) dengan fallback in-memory |

Alasan metadata perangkat ikut di `session_start`: backend hanya menyimpan
`context.environment` dan `context.app_version`; field `context` lain hilang
(lihat `CONTRACT.md` §6).

---

## 4. DOM Recording (rrweb) & Privacy Masking Engine

### 4.1 Recording

- Perekam hidup di entry terpisah `@artracker/browser/replay` dan **disuntikkan** lewat opsi
  `replay: replay({ sampleRate })` (driver). Entry utama tidak pernah memuat atau menyebut `rrweb`
  (terverifikasi: `grep -c rrweb dist/index.js` = 0). Build IIFE/CJS tidak bisa code-splitting, sehingga
  `import()` perekam dari entry utama akan ikut membundel rrweb — itu sebabnya desain `import('./replay/recorder')`
  semula ditinggalkan (lihat bagian 12).
- `rrweb` diimpor dinamis di dalam perekam, hanya bila `replay.enabled` **dan** sesi lolos sampling (atau
  `startReplay()` manual). `rrweb` adalah **optional peer dependency** (`>=2.0.0`); bila tidak terpasang, replay no-op.
- Konfigurasi hemat: `sampling: { mousemove: 50, scroll: 150, input: 'last', media: 800 }`,
  `recordCanvas: false`, `collectFonts: false`.
- `checkoutEveryNms: 120000` — full snapshot ulang tiap 2 menit agar chunk yang hilang tidak
  merusak seluruh rekaman.
- Sampling sesi bersifat deterministik: `hash(session_id) < replay.sampleRate`, diputuskan
  sekali per sesi sehingga rekaman tidak terpotong di tengah.
- Pemrosesan chunk dijadwalkan lewat `requestIdleCallback` (fallback `setTimeout(…, 0)`);
  gzip terjadi di Web Worker; `JSON.stringify` dan `fetch` di main thread.

### 4.2 Pemetaan ke skema backend

```jsonc
{
  "type": "session",
  "name": "replay_chunk",
  "session_id": "ses_…",
  "timestamp": "2026-11-05T09:13:18.050Z",
  "attributes": {
    "seq": 12,
    "start": 1762331598050,
    "end":   1762331603120,
    "full_snapshot": false,
    "events": [ /* event rrweb */ ]
  }
}
```

`chunker.ts` menjaga `JSON.stringify(attributes).length ≤ 24 KB` (soft cap di bawah batas
keras 32 KB). Strategi pemecahan: *split-by-event*. Bila satu event rrweb tunggal tetap >24 KB
(full snapshot DOM yang sangat besar), isinya dipotong dan ditandai `{"oversized": true}` —
lebih baik kehilangan sebagian terkendali daripada seluruh `attributes` diganti
`{"_truncated": true}` oleh backend.

### 4.3 Privacy Masking Engine — dua lapis

**Lapis 1 — DOM masking (sebelum serialisasi rrweb):**

- `maskAllInputs: true` sebagai default: seluruh `<input>`, `<textarea>`, `<select>` menjadi `*`.
  Diimplementasikan lewat `maskInputOptions` serba-true + `maskInputFn(text, el)` sehingga keputusan mask ada di SDK.
- Selalu di-mask tanpa kecuali, mengabaikan konfigurasi:
  - `input[type="password"]`
  - `autocomplete` ∈ `cc-number`, `cc-csc`, `cc-exp`, `current-password`, `new-password`
  - atribut `name`/`id` yang mengandung `card`, `cvv`, `cvc`, `ssn`, `nik`, `pin`, `otp`
- Kontrol developer: `data-artracker-mask` (isi di-mask), `data-artracker-block` (elemen
  diganti placeholder), `data-artracker-unmask` (whitelist eksplisit), plus opsi
  `maskTextClass` dan `blockClass`.
- `maskTextFn` menjalankan redactor lapis 2 pada text node yang tidak di-mask, sehingga PII
  yang muncul sebagai teks biasa (misalnya email di halaman profil) tetap tersamarkan.

**Lapis 2 — Payload redaction (`privacy/redactor.ts`), berlaku untuk SEMUA item:**

| Kategori | Perlakuan |
| --- | --- |
| Email | `a***@domain.com`. (`privacy.hashEmails` **belum diimplementasikan** di 0.1.0: SHA-256 bersifat async, pipeline redaksi sinkron) |
| Kartu kredit | 13–19 digit + validasi Luhn → `**** **** **** 1234` |
| Telepon Indonesia | `+62…` / `08…` → empat digit terakhir saja |
| NIK | 16 digit **dengan struktur valid** (provinsi 11–94, tanggal, bulan) → `[redacted]` |
| JWT | `eyJ…` → `[redacted]` |
| Header otorisasi | `Authorization: Bearer …` → `[redacted]` |
| API key | `sk_…`, `art_sec_…`, pola kunci umum → `[redacted]` |
| Deny-list berbasis key | `password, pass, token, secret, authorization, cookie, otp, pin, cvv, card, ssn, nik` (case-insensitive) → nilai diganti `[redacted]` |

- URL scrubber: query param sensitif (`token`, `code`, `email`, `access_token`, `sig`) →
  `[redacted]`; opsi `maskUrlPathIds` mengganti segmen UUID/angka panjang menjadi `:id`
  untuk mempermudah pengelompokan di dashboard.
- Guard performa: traversal objek dibatasi kedalaman 6 dan 1000 node agar redaksi tidak
  menjadi hot-path.
- `beforeSend(item)` dijalankan **paling akhir**; mengembalikan `null` berarti item dibuang.
- Redaksi berjalan **sebelum** item masuk ke `persistence` — data sensitif tidak pernah
  mendarat di IndexedDB sekalipun perangkat sedang offline.

---

## 5. Telemetry Listeners

| Listener | Teknik | Item yang dihasilkan |
| --- | --- | --- |
| Unhandled error | `window.addEventListener('error', …, true)` — aditif, bukan menimpa `window.onerror` | `log` / `error`, `message` = `"<Name>: <msg>"` (≤4096), attributes `{stack (cap 16 KB), filename, lineno, colno, fingerprint, breadcrumbs}` |
| Promise rejection | `unhandledrejection` | sama, `attributes.kind = "unhandledrejection"` |
| Resource error | event `error` pada `img`/`script`/`link` | `log` / `warn`, `name = "resource_error"` |
| `fetch` | Monkey-patch dengan preservasi `this`; objek `Response` dikembalikan utuh dan **body tidak dibaca** secara default | `log`, level dari status (`<400` → `info`, `4xx` → `warn`, `5xx` → `error`), `name = "http_request"`, attributes `{method, url (scrubbed), status, duration_ms, req_bytes, res_bytes}` |
| `XMLHttpRequest` | Patch `open`/`send` + listener `loadend` | sama |
| Breadcrumbs | Ring buffer 30 entri (configurable) | Tidak dikirim sebagai item tersendiri; dilampirkan ke attributes error dan `session_end` |
| Navigation | Patch `pushState`/`replaceState` + `popstate` + `hashchange` | `event`, `name = "page_view"`, attributes `{from, to, referrer}` |
| Click / input | Delegasi listener di `document` (capture, passive) | Breadcrumb `{tag, text (≤64, sudah diredaksi), selector, aria-label}` — **nilai input tidak pernah dicatat**, hanya status `filled` / `cleared` |
| Web Vitals | **Belum diimplementasikan di 0.1.0** (rencana: opsional, `vitals: false`, via `PerformanceObserver`) | `event`, `name = "web_vital"` |

### Guard rails

- **Anti-recursion:** request menuju `config.endpoint` dikecualikan dari interceptor. Tanpa ini,
  setiap pengiriman telemetri akan menghasilkan telemetri baru — loop tak hingga.
- **Circuit breaker:** maksimum 20 error per menit per sesi, dengan dedup berdasarkan hash
  `fingerprint` dalam jendela 10 detik. Melindungi kuota 1000 event/s yang dibagi seluruh
  pengguna satu project.
- **Reversibilitas:** setiap patch menyimpan referensi fungsi asli dan dikembalikan pada
  `shutdown()`. Penting untuk HMR dan untuk test.
- **Breadcrumb bukan item:** menyimpannya di buffer lokal dan melampirkannya hanya saat error
  menghemat kuota event secara signifikan.

---

## 6. Transport, Worker & Offline Queue

### 6.1 Pemicu flush

| Pemicu | Nilai default |
| --- | --- |
| Jumlah item | ≥ 50 |
| Ukuran | ≥ 128 KB uncompressed |
| Waktu | setiap 5 detik |
| Lifecycle | `visibilitychange` → `hidden`, `pagehide` |
| Konektivitas | event `online` |
| Manual | `ARTracker.flush()` |

### 6.2 Web Worker

- Worker di-inline sebagai Blob URL saat build, sehingga pelanggan tidak perlu meng-host file
  tambahan — aman untuk distribusi NPM maupun CDN.
- Opsi `workerUrl` disediakan untuk aplikasi dengan CSP ketat yang melarang `blob:`.
- Fallback berjenjang:
  1. Web Worker + `CompressionStream('gzip')`
  2. Worker tidak tersedia → gzip di main thread di dalam idle callback
  3. `CompressionStream` tidak tersedia → kirim JSON polos (backend menerimanya, lihat
     `CONTRACT.md` §4)
- Worker juga menangani serialisasi chunk rrweb agar main thread tetap bebas.

### 6.3 Offline Queue

| Aspek | Keputusan |
| --- | --- |
| Primary store | IndexedDB — database `artracker`, object store `batches`, `keyPath: "id"`, indeks `createdAt` |
| Fallback | `localStorage` (`ar_q_`, cap 1 MB) bila IndexedDB diblokir; lalu **memori** bila localStorage juga diblokir. `put` yang gagal di tengah sesi jatuh ke memori |
| Kuota | 5 MB / 7 hari (default, configurable). Kuota ditegakkan saat put (total berjalan) dan saat `init()`; umur hanya saat `init()` |
| Eviction | FIFO **dengan prioritas**: `replay_chunk` dibuang lebih dulu, lalu `event`, dan `log` level `error`/`fatal` dipertahankan paling akhir |
| Replay saat start | `init()` membaca batch pending dan mengirim ulang dengan throttle maks 5 batch/detik agar tidak memicu limit 50 req/s |
| Deteksi konektivitas | `online`/`offline` + `navigator.onLine` hanya sebagai hint; sumber kebenaran tetap hasil `fetch` |
| Idempotensi | `item.id` UUIDv7 dibuat sekali di SDK dan dipakai ulang pada setiap retry, sehingga backend *dapat* men-dedup. **Backend saat ini belum men-dedup** (`pgx.CopyFrom` tanpa `ON CONFLICT`, PK `(received_at, id, project_id)`): retry setelah `202` yang hilang dapat menggandakan baris. Perlu issue backend. |

### 6.4 Jalur unload

Saat `pagehide` / `visibilitychange: hidden`:

```js
navigator.sendBeacon(
  endpoint + '?api_key=' + appKey,
  new Blob([json], { type: 'text/plain' })   // simple request, tanpa preflight
)
```

Beacon tidak dapat mengirim custom header, karena itu memakai fallback `?api_key=` yang
didukung backend (`handler/ingest.go`). Payload beacon tidak di-gzip. Bila payload >60 KB,
batch dipecah atau disimpan ke IndexedDB untuk dikirim pada sesi berikutnya.

### 6.5 Backoff

`delay = min(30s × 2^n, 5 menit)` dengan jitter ±20%, direset setiap kali menerima `202`.
Header `Retry-After` dari server menang atas perhitungan lokal **bila terbaca**. Pada request lintas-origin header ini tidak terbaca kecuali backend mengirim `Access-Control-Expose-Headers: Retry-After` (konfigurasi CORS ingest saat ini tidak), sehingga SDK jatuh ke backoff lokal. Setelah 8 kegagalan
beruntun SDK masuk **mode hemat**: flush hanya dilakukan saat unload atau saat event `online`.

---

## 7. Bundle Size & Bundler Setup

**Toolchain:** `tsup` (esbuild) — dipilih di atas Vite library mode karena dukungan multi-entry
dan inline worker yang lebih ringkas.

| Setting | Nilai |
| --- | --- |
| Format | ESM + CJS + IIFE (global `ARTracker` untuk pemakaian `<script>`) |
| Target | `es2020` |
| Lain-lain | `dts: true`, `treeshake: true`, `sourcemap: true`, `pure: ['console.log']`, `define: { __AR_VERSION__ }`, plugin inline-worker |

### Budget (minified + gzip, D1)

| Entry | Isi | Budget |
| --- | --- | --- |
| `@artracker/browser` | core + privacy + telemetry + transport | **≤ 18 kB** — aktual **11,8 kB** |
| `@artracker/browser/replay` | adapter rrweb + chunker (**tanpa** rrweb) | ≤ 4 kB — aktual **2,9 kB** |
| `rrweb` | optional peer, dimuat lazy | di luar budget entry — terukur **≈57 kB** (record-only) |

Total dengan replay aktif ≈ **71 kB**: target <45 kB dipenuhi oleh **entry**, bukan oleh total (keputusan D1).

`size-limit` dijalankan sebagai **gate di CI**: build gagal bila entry melewati 18 kB.

### Packaging

- `exports` map: `"."` dan `"./replay"`
- `sideEffects: false`, field `browser`, `types`
- `publishConfig.access: public` + npm provenance
- Workflow `.github/workflows/sdk-web.yml`: lint → typecheck → test → size-limit → build →
  publish saat tag

---

## 8. Taksonomi Event → Skema DB

| Aktivitas SDK | `type` | `name` / `level` | Catatan |
| --- | --- | --- | --- |
| `track(name, props)` | `event` | `name` (≤255) | `props` → attributes |
| Page view otomatis | `event` | `page_view` | Selaras dengan data mock dashboard |
| `identify()` | `event` | `$identify` | traits → attributes |
| Sesi mulai / selesai | `session` | `session_start` / `session_end` | attributes: metadata perangkat, breadcrumb ringkas |
| Replay | `session` | `replay_chunk` | Chunk ≤24 KB |
| Error / rejection | `log` | level `error` | `message` ≤4096, stack di attributes |
| Panggilan jaringan | `log` | `info` / `warn` / `error` | `name = "http_request"` |
| `log()` | `log` | sesuai level | Level invalid → `info` oleh backend |

Envelope `context` selalu berisi
`{environment, app_version, page, referrer, screen, ua, lang, tz, sdk_platform: "web"}`.
Karena backend hanya menyimpan `environment` dan `app_version`, field lainnya juga disalin ke
attributes item `session_start`.

---

## 9. Strategi Pengujian

| Lapis | Cakupan | Alat |
| --- | --- | --- |
| Unit | config, session (fake timers), envelope builder, redactor (corpus PII), chunker, backoff, queue | Vitest + jsdom |
| Kontrak | Envelope yang dihasilkan divalidasi terhadap skema di `CONTRACT.md` (batas panjang, tipe yang valid, item >500 ditolak) | Vitest + fixture JSON |
| Integrasi | SDK → backend nyata (`make api` + key `art_live_`): verifikasi `202`, gzip diterima, data muncul di `GET /projects/:id/events` | Vitest + backend lokal |
| Privasi | "Tidak ada data sensitif di IndexedDB": isi form dengan PII, rekam, baca isi IDB, assert bersih | Vitest + fake-indexeddb |
| Performa | Tidak ada long task >50 ms saat merekam halaman berat | Playwright + `PerformanceObserver` |
| Ukuran | Gate `size-limit` | CI |

---

## 10. Checklist Implementasi

### Fase 0 — Fondasi
- [x] Scaffold `artracker-web-sdk/`: pnpm, TypeScript strict, tsup, Vitest + jsdom, ESLint/Prettier, size-limit
- [x] CI: lint → typecheck → test → **size-limit gate** (gagal bila entry >18 kB)

### Fase 1 — Core & Session
- [x] `config.ts` — validasi opsi, default, pesan error yang jelas
- [x] `session.ts` — generate/persist/rotate id, idle + hard timeout
- [x] `user.ts` + `context.ts`
- [x] `bus.ts` + `envelope.ts` — builder RawItem sesuai `CONTRACT.md` §7
- [x] `client.ts` — `init/track/identify/log/reset/shutdown`, pre-init buffer, `safeCall`

### Fase 2 — Transport
> Dibangun sebelum listener agar setiap fitur berikutnya bisa langsung diverifikasi end-to-end
> terhadap backend nyata.
- [x] `queue.ts` — batcher (trigger jumlah / byte / waktu)
- [x] `persistence.ts` — IndexedDB + fallback localStorage + eviction berprioritas
- [x] `backoff.ts` — exponential + jitter + `Retry-After`, tabel reaksi status `CONTRACT.md` §10
- [x] `sender.ts` — fetch keepalive → sendBeacon (`?api_key=`) saat unload
- [x] `worker/` — inline worker, gzip `CompressionStream`, fallback berjenjang
- [x] **Integration test lawan backend nyata** — `src/__tests__/pipeline.integration.test.ts` dijalankan 2026-11-05 terhadap backend lokal (API Go + Postgres 16 tanpa Docker): 4 tes lulus. SDK hasil build juga dijalankan di Chrome 156 (preflight `204`, `POST` gzip `202`, PII tersamarkan di database)

### Fase 3 — Privacy Engine
> Dibangun sebelum listener apa pun: tidak boleh ada jalur data tanpa redaksi.
- [x] `redactor.ts` + corpus test PII
- [x] `urlScrubber.ts`, deny-list berbasis key, guard depth/size, hook `beforeSend`

### Fase 4 — Telemetry Listeners
- [x] `errors.ts` — onerror + unhandledrejection + fingerprint + dedup + circuit breaker
- [x] `network.ts` — fetch + XHR, anti-recursion, restore saat shutdown
- [x] `breadcrumbs.ts` ring buffer + `navigation.ts` (route change SPA)

### Fase 5 — Replay
- [x] `recorder.ts` — dynamic import rrweb, sampling per sesi, idle scheduling
- [x] `masking.ts` — aturan DOM masking + hook `maskTextFn` ke redactor
- [x] `chunker.ts` — pecah ≤24 KB, `checkoutEveryNms`, penanganan event oversized
- [ ] Benchmark long-task pada halaman berat — **belum dilakukan**. Replay (rrweb) juga belum dijalankan di browser sungguhan

### Fase 6 — Pengerasan & DX
- [x] Kill-switch (`ARTracker.disable()` + `localStorage.ar_disabled`), opsi hormati Do Not Track
- [x] SSR-safety untuk Next.js (no-op di server)
- [x] Adapter tipis: helper React ErrorBoundary + `errorHandler` Vue (didokumentasikan, belum paket terpisah)
- [x] Playground `examples/vanilla` + `examples/next` — ditulis. Halaman uji serupa dijalankan di Chrome; `examples/` apa adanya belum dijalankan, dan `examples/next` belum dicoba sama sekali

### Fase 7 — Rilis
- [x] README (quickstart tiga baris), tabel opsi, panduan privasi, matriks dukungan browser
- [x] Laporan ukuran bundle final terhadap AC
- [ ] Changeset + publish `0.1.0` + tag — tag lokal dibuat; **publish ke npm belum dilakukan**

---

## 11. Risiko yang Masih Terbuka

| # | Risiko | Mitigasi | Status |
| --- | --- | --- | --- |
| R1 | `rrweb` (≈57 kB gzip terukur) membuat total bundle ≈71 kB bila pelanggan mengaktifkan replay | D1: budget diukur pada entry; biaya replay didokumentasikan eksplisit di README | Diterima |
| R2 | Backend memotong `attributes` >32 KB | Chunking 24 KB di SDK; tidak perlu perubahan backend | Tertangani |
| R3 | Belum ada endpoint pembacaan replay | Di luar scope issue #11; data tetap tersimpan sebagai `kind='session'` | Di luar scope |
| R4 | Kuota 1000 event/s dibagi seluruh pengguna satu project | Replay default off + sampling 0.1, dedup error, breadcrumb tidak dikirim per item | Tertangani |
| R5 | CSP ketat melarang `blob:` worker | Opsi `workerUrl` + fallback main-thread | Tertangani |
| R6 | Monkey-patch `fetch` berbenturan dengan SDK pihak ketiga lain (mis. Sentry) | Patch aditif, simpan referensi asli, selalu panggil fungsi sebelumnya, restore saat shutdown | Perlu uji manual di Fase 4 |

---

## 12. Deviasi dari dokumen ini (hasil implementasi `0.1.0`)

| # | Dokumen semula | Implementasi | Alasan |
| --- | --- | --- | --- |
| 1 | `import('./replay/recorder')` dari entry utama | Perekam **disuntikkan** lewat `replay: replay({...})` dari `@artracker/browser/replay` | Build IIFE/CJS tidak code-splitting; `import()` akan membundel rrweb ke entry. Menjaga `grep rrweb dist/index.js` = 0 |
| 2 | Walker redaksi untuk semua item | Chunk replay melewati walker atribut (`skipRedaction`); privasi replay via masking rrweb + redaksi param URL di chunker | `MAX_DEPTH 6` / `MAX_NODES 1000` akan merusak event rrweb. `beforeSend` tetap berjalan |
| 3 | `privacy.hashEmails` → SHA-256 | Opsi diterima, **belum berfungsi** (email selalu di-mask) | SHA-256 async vs pipeline sinkron |
| 4 | Interceptor `fetch` menormalkan lewat `new Request(input)` | Membaca `method`/`url` dari properti | `new Request(req)` mengonsumsi body `Request` milik aplikasi host |
| 5 | `sampleRate` (tanpa definisi) | Per sesi, deterministik, hanya untuk `track()` biasa | Sampling acak per event merusak funnel dan menyembunyikan error |
| 6 | `export default ARTracker`; IIFE dari entry yang sama | Hanya named export; IIFE dari `src/global.ts` | Namespace `{ARTracker, default}` memaksa `ARTracker.ARTracker.init()` pada `<script>` |
| 7 | Hanya `disable()` menyetel flag | `disable()` juga menghapus batch tertunda; panggilan saat opt-out dibuang | Data pengguna yang menolak tidak boleh terkirim belakangan |
| 8 | NIK = 16 digit | NIK = 16 digit **berstruktur valid** | Aturan 16 digit buta bertabrakan dengan "16 digit gagal Luhn tetap utuh" |
| 9 | `beforeSend` melempar → (tidak ditentukan) | Item **dibuang** (fail-closed) | Hook sering berupa scrubber PII milik pengguna |
| 10 | `rrweb` ~30–40 kB | Terukur ≈57 kB gzip | Estimasi awal keliru |
| 11 | Fallback storage IDB → localStorage | IDB → localStorage → **memori** | Review akhir: tanpa tier memori SDK tidak mengirim apa pun saat semua storage diblokir |
| 12 | Batas 24 KB dihitung dalam karakter | Dihitung dalam **byte UTF-8** | Backend menghitung `len(raw)` dalam byte; teks non-Latin melewati 32 KB walau <24K karakter |
| 13 | `session_start` pada setiap `init()`; `page_view` hanya saat pushState | `session_start` hanya untuk sesi baru; `page_view` awal saat install | Muat ulang/MPA menggandakan `session_start` dan tidak punya `page_view` |
| 14 | `identify` menyimpan traits di localStorage | traits hanya di memori | Traits dapat berisi PII mentah; klaim "sebelum menyentuh disk" |
| 15 | Replay: input `hidden` dan atribut tidak ditangani | `hidden` selalu di-mask; PII pada nilai atribut diredaksi di chunker (salinan, bukan event milik rrweb) | Review akhir: CSRF token / email di hidden input dan atribut bocor |
| 16 | Web Vitals, serialisasi+POST di Worker | Belum ada Web Vitals; worker hanya gzip | Koreksi dokumen terhadap kode |
| 17 | `Retry-After` selalu menang; retry idempoten | Hanya bila terbaca (CORS); backend belum dedup | Keduanya bergantung pada backend (`ExposeHeaders`, `ON CONFLICT`) — rekomendasi issue backend |
| 18 | `instanceof Error` untuk mengenali error | `isError()` (`core/safe.ts`): `instanceof` ditambah tag `[object Error]` / `[object DOMException]` | Ditemukan saat uji di Chrome: Error dari iframe gagal `instanceof` dan tersimpan sebagai `Error: {}` tanpa pesan dan stack. Objek biasa `{name, message}` tetap bukan Error |

Terverifikasi (2026-11-05): integrasi terhadap backend hidup dan alur dasar di Chrome 156 (lihat §10 Fase 2).

Belum terverifikasi: long-task / UI thread, Safari dan Firefox, replay di browser sungguhan, dan jalur `sendBeacon` secara spesifik.
