# @artracker/browser

SDK Web/Browser untuk [artracker](https://github.com/tiofani03/artracker): menangkap **error, request jaringan, event kustom, dan (opsional) session replay**, lalu mengirimnya ke `POST /api/v1/ingest` dengan redaksi PII otomatis dan antrean offline.

- **Ringan** — entry utama **11,5 kB** min+gzip (ukuran terukur, lihat [Ukuran bundle](#ukuran-bundle)).
- **Tanpa dependency runtime.** `rrweb` hanya dibutuhkan bila Anda mengaktifkan replay.
- **Tidak pernah melempar** error ke aplikasi Anda; aman dipanggil di server (SSR no-op).
- **PII disamarkan sebelum menyentuh disk atau jaringan.**

## Mulai cepat

```bash
pnpm add @artracker/browser
```

```ts
import { ARTracker } from '@artracker/browser'

ARTracker.init({ appKey: 'art_live_...', endpoint: 'https://api.example.com/api/v1/ingest' })
ARTracker.identify('usr_42', { plan: 'pro' })
ARTracker.track('checkout_clicked', { cart_value: 250000 })
```

Error yang tidak tertangani, request `fetch`/XHR, klik, dan perpindahan route SPA tercatat otomatis.

> `appKey` harus key publik `art_live_…`. Key rahasia `art_sec_…` **ditolak** oleh SDK.

### Lewat `<script>` (CDN)

```html
<script src="https://cdn.jsdelivr.net/npm/@artracker/browser/dist/index.global.js"></script>
<script>
  ARTracker.init({ appKey: 'art_live_...', endpoint: 'https://api.example.com/api/v1/ingest' })
</script>
```

Panggilan sebelum `init()` (mis. dari skrip `async`) ditampung — maksimum 100 — lalu dialirkan setelah `init()`.

## API

| Method | Keterangan |
| --- | --- |
| `init(options)` | Idempoten. Opsi tidak valid → peringatan di console, tidak melempar. |
| `identify(userId, traits?)` | Menyetel `user_id` (maks 128 karakter) dan mengirim event `$identify`. |
| `track(name, properties?)` | Event kustom (`type: event`). |
| `log(level, message, attributes?)` | `debug \| info \| warn \| error \| fatal`. |
| `captureException(error, context?)` | Mencatat error secara manual (stack, fingerprint, breadcrumbs). |
| `setContext(key, value)` | Ditambahkan ke `context` envelope. Hanya `environment` dan `app_version` yang disimpan backend. |
| `addBreadcrumb({ type, data? })` | Menambah jejak yang dilampirkan ke error berikutnya. |
| `flush()` | `Promise<void>`: mengirim semua yang tertunda. |
| `startReplay()` / `stopReplay()` | Kontrol replay manual (lihat [Session replay](#session-replay-opt-in)). |
| `reset()` | Logout: identitas dan sesi baru. |
| `disable()` / `enable()` | Opt-out persisten (`localStorage`). `disable()` **menghapus batch tertunda** dan tidak mengirim apa pun lagi. |
| `shutdown()` | Melepas semua patch/listener (berguna untuk HMR/test). |

## Opsi `init()`

| Opsi | Default | Keterangan |
| --- | --- | --- |
| `appKey` | — (wajib) | `art_live_…`, 32–128 karakter. |
| `endpoint` | — (wajib) | URL absolut `…/api/v1/ingest`. |
| `environment` | `'production'` | Disimpan backend. |
| `appVersion` | `''` | Disimpan backend sebagai `release_version`. |
| `sampleRate` | `1` | Sampling **per sesi** (deterministik) untuk event `track()`. Log/error dan item sesi **tidak** pernah di-sampling. |
| `replay` | `{ enabled: false, sampleRate: 0.1 }` | Lihat bagian replay. |
| `privacy.maskAllInputs` | `true` | Menutup semua nilai input pada replay. |
| `privacy.blockClass` / `maskTextClass` | `'ar-block'` / `'ar-mask'` | Class pemblokir / penyamar teks. |
| `privacy.maskUrlPathIds` | `false` | Mengganti segmen UUID/angka panjang pada URL menjadi `:id`. |
| `privacy.redactors` | `[]` | Fungsi `(s: string) => string` tambahan, dijalankan setelah redaksi bawaan. |
| `privacy.hashEmails` | `false` | **Dicadangkan, belum berfungsi di 0.1.0** — email selalu di-mask. |
| `network.enabled` | `true` | Interceptor `fetch`/XHR. |
| `network.ignoreUrls` | `[]` | String (substring) atau `RegExp`. Endpoint ingest sendiri selalu dikecualikan. |
| `network.captureBodies` | `false` | **Dicadangkan.** Body request/response tidak pernah dibaca. |
| `breadcrumbs.limit` | `30` | Ukuran ring buffer (1–200). |
| `batch` | `{ maxItems: 50, maxBytes: 131072, flushIntervalMs: 5000 }` | Dijepit ke 1–50 item, 1–128 KB, 250 ms–60 s. |
| `offline` | `{ maxQueueBytes: 5 MB, maxAgeMs: 7 hari }` | Dibersihkan saat `init()`. |
| `crossTabSession` | `false` | `true` → sesi dibagi antar-tab lewat `localStorage`. |
| `respectDoNotTrack` | `false` | `true` → tidak aktif bila browser mengirim DNT. |
| `workerUrl` | — | URL worker gzip sendiri, untuk CSP yang melarang `blob:`. |
| `beforeSend` | — | `(item) => item \| null`. Dijalankan **paling akhir**; `null` atau exception = item dibuang. |
| `debug` | `false` | Log internal ke console. |

## Session replay (opt-in)

Replay **mati secara default**. Mengaktifkannya menambah `rrweb` ke bundle aplikasi Anda — **±57 kB gzip** (terukur, record-only) di atas SDK.

```bash
pnpm add rrweb      # optional peer dependency, >= 2.0.0
```

```ts
import { ARTracker } from '@artracker/browser'
import { replay } from '@artracker/browser/replay'

ARTracker.init({
  appKey: 'art_live_...',
  endpoint: 'https://api.example.com/api/v1/ingest',
  replay: replay({ sampleRate: 0.1 }), // rekam 10% sesi
})
```

- Keputusan sampling diambil **sekali per sesi** (deterministik dari `session_id`); sesi baru = keputusan baru.
- Data dikirim sebagai item `type: session`, `name: replay_chunk`, masing-masing ≤ 24 KB.
- Tanpa `rrweb` terpasang, replay menjadi no-op (peringatan bila `debug: true`).
- `replay: { enabled: true }` **tanpa** `replay()` hanya memberi peringatan — SDK sengaja tidak membundel perekam ke entry utama.
- Mode manual (tanpa auto-start): `replay: { driver: replayDriver }` (`import { replayDriver } from '@artracker/browser/replay'`), lalu panggil `startReplay()` / `stopReplay()`. `startReplay()` merekam sekarang, mengabaikan `enabled` dan sampling.
- Backend `artracker` saat ini **belum** punya endpoint untuk memutar replay; data tersimpan sebagai `kind = session`.

## Privasi

Redaksi berjalan **sebelum** item masuk ke antrean, IndexedDB, maupun jaringan.

**Otomatis disamarkan di semua item** (`message`, `name`, `attributes`):

| Jenis | Perlakuan |
| --- | --- |
| Email | `b***@example.com` |
| Kartu kredit (13–19 digit, lolos Luhn) | `**** **** **** 6467` |
| Telepon Indonesia (`+62…`, `08…`) | hanya 4 digit terakhir |
| NIK (16 digit, struktur valid) | `[redacted]` |
| JWT, `Bearer …`, `Basic …`, key `sk_/pk_/rk_…`, `art_*` | `[redacted]` |
| Query/fragment `token`, `access_token`, `code`, `email`, `sig`, `api_key`, `password`, `secret`… | `[redacted]` |
| Key objek seperti `password`, `token`, `secret`, `authorization`, `cookie`, `otp`, `pin`, `cvv`, `card`, `ssn`, `nik`, `apiKey` | nilai → `[redacted]` |

**Pada replay (DOM):**

- Semua input di-mask (`maskAllInputs`). Field `type="password"`, `autocomplete="cc-*"`/`*-password`, serta `name`/`id` berisi `card|cvv|cvc|ssn|nik|pin|otp` **selalu** di-mask, bahkan bila `maskAllInputs: false`.
- `data-artracker-mask` — isi teks/input di dalamnya menjadi `*`.
- `data-artracker-block` — elemen diganti placeholder.
- `data-artracker-unmask` — membuka input **biasa** (tidak pernah field sensitif; `mask` menang atas `unmask`).
- Setiap text node dilewatkan ke redaksi PII yang sama dengan di atas.
- Breadcrumb klik **tidak pernah** mencatat nilai input — hanya status `filled`/`cleared`.

**Tidak tercakup — perhatikan:**

- Nilai `user_id` dari `identify()` dikirim apa adanya. Jangan memakai email sebagai id bila itu sensitif.
- Redaksi berbasis pola tidak mengenali nama, alamat, atau teks bebas yang tidak mengikuti pola di atas. Gunakan `data-artracker-mask` / `beforeSend` untuk itu.
- Pada replay, **atribut elemen** selain query param URL sensitif (mis. `data-*`, `title`, `alt`) direkam apa adanya — rrweb 2.x tidak menyediakan hook untuk atribut.
- Request jaringan dicatat untuk **setiap** panggilan (termasuk 2xx, level `info`). Pada aplikasi yang ramai, gunakan `network.ignoreUrls` agar tidak menghabiskan kuota event project (default backend: 1000 event/s).

## Yang dikumpulkan otomatis

| Sumber | Item |
| --- | --- |
| Error tak tertangani, `unhandledrejection` | `log` / `error`, stack ≤ 16 KB, fingerprint, breadcrumbs. Dedup 10 detik per fingerprint; maksimum 20 error/menit. |
| Gagal memuat `img`/`script`/`link` | `log` / `warn`, `resource_error` |
| `fetch` & XHR | `log`, `http_request` — method, URL ter-scrub, status, `duration_ms`. Level: `<400` info, `4xx` warn, `5xx`/gagal error. |
| Perpindahan route (`pushState`, `replaceState`, `popstate`, `hashchange`) | `event`, `page_view` |
| Awal/akhir sesi | `session`, `session_start` (metadata perangkat) / `session_end` |

Sesi berganti setelah **30 menit idle**, **4 jam**, atau `reset()`.

## Pengiriman & offline

- Batch ≤ 50 item / 128 KB / 5 detik; selalu ditulis ke **IndexedDB** dulu (fallback `localStorage` 1 MB), lalu dikirim — batch tertua lebih dulu, maksimum 5 batch/detik.
- Gzip dikerjakan di **Web Worker** (`CompressionStream`); bila tidak tersedia → main thread → JSON polos.
- Saat tab disembunyikan / ditutup: `navigator.sendBeacon` (key lewat `?api_key=`).
- `429`/`503`/gagal jaringan: coba lagi dengan backoff eksponensial (hormati `Retry-After`). Setelah 8 kegagalan beruntun tidak ada retry otomatis lagi; pengiriman lanjut saat event `online` atau `flush()` setelah jeda berakhir.
- `401` (key dicabut): SDK **berhenti** untuk sesi itu. `400`: batch dibuang. `413`: batch dipecah dua.
- Setiap item membawa `id` UUIDv7 yang tetap pada retry, jadi pengiriman ulang tidak menggandakan baris.

## Framework

**Next.js (App Router)** — panggil `init` di Client Component; modul aman diimpor di server (no-op).

```tsx
'use client'
import { useEffect } from 'react'
import { ARTracker } from '@artracker/browser'

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    ARTracker.init({ appKey: process.env.NEXT_PUBLIC_ARTRACKER_KEY!, endpoint: process.env.NEXT_PUBLIC_ARTRACKER_ENDPOINT! })
  }, [])
  return children
}
```

**React** — error boundary:

```tsx
componentDidCatch(error: Error, info: React.ErrorInfo) {
  ARTracker.captureException(error, { componentStack: info.componentStack })
}
```

**Vue** — `app.config.errorHandler = (err, _vm, info) => ARTracker.captureException(err, { info })`

## Ukuran bundle

Diukur dengan `size-limit` (min+gzip), gate di CI:

| Artefak | Ukuran | Batas |
| --- | --- | --- |
| `@artracker/browser` (entry) | **11,5 kB** | 18 kB |
| `@artracker/browser/replay` (adapter, tanpa rrweb) | **2,5 kB** | 4 kB |
| `rrweb` (record-only, peer) | ±57 kB | di luar entry |

Total dengan replay aktif ≈ **71 kB**. Target `< 45 kB` dipenuhi oleh **entry**, bukan oleh total dengan replay.

## Dukungan browser & status pengujian

Target kompilasi `es2020`. Fitur yang dipakai dengan fallback: `CompressionStream` (tanpa itu → JSON polos), `Worker` (tanpa itu → main thread), IndexedDB (tanpa itu → `localStorage` → memori), `sendBeacon`.

> **Jujur soal pengujian:** seluruh tes (≈250) berjalan di **jsdom** dengan `fake-indexeddb`; rrweb nyata dijalankan di jsdom. SDK **belum diuji di browser sungguhan** (tidak ada pengukuran long-task/UI-thread) dan **belum diuji terhadap backend hidup** — tes integrasinya ada tetapi dilewati tanpa backend (lihat di bawah).

## Pengembangan

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm size

# Tes integrasi ke backend nyata (butuh `make db-up && make api` di repo artracker)
ARTRACKER_E2E_ENDPOINT=http://localhost:8080/api/v1/ingest \
ARTRACKER_E2E_KEY=art_live_... \
pnpm vitest run src/__tests__/pipeline.integration.test.ts
```

Kontrak backend yang menjadi acuan ada di [`CONTRACT.md`](./CONTRACT.md); desain di [`ARCHITECTURE.md`](./ARCHITECTURE.md).
