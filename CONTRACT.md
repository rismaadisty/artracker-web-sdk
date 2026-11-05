# Kontrak Ingest Backend — Referensi untuk `@artracker/browser`

> Dokumen ini adalah ringkasan **terverifikasi** dari kode backend `artracker` per 2026-11-05.
> Setiap baris di bawah ditelusuri ke file sumbernya. Jika backend berubah, dokumen ini harus
> diperbarui lebih dulu sebelum SDK menyesuaikan.

Sumber: `backend/internal/handler/{routes,ingest,telemetry}.go`,
`backend/internal/ingest/{model,sanitize,decompress,ratelimit,keycache}.go`,
`backend/internal/db/migrations/0003_ingest_telemetry.sql`, `backend/cmd/api/main.go`,
`docs/plan.md`.

---

## 1. Endpoint

| Aspek | Nilai |
| --- | --- |
| Method & path | `POST /api/v1/ingest` |
| Middleware | `VerifyIngestKey` → `RateLimitIngest` → `Ingest` (`handler/routes.go`) |
| Respons sukses | `202 Accepted` — `{"status":"accepted","queued":<n>}` |
| Model pemrosesan | Fire-and-forget: envelope di-enqueue ke worker pool, lalu langsung 202 |

## 2. Autentikasi

| Cara | Detail |
| --- | --- |
| Header (utama) | `X-Artracker-Key: art_live_…` |
| Query (fallback) | `?api_key=art_live_…` — **wajib dipakai oleh `navigator.sendBeacon`** karena Beacon API tidak dapat mengirim custom header |
| Tipe key diterima | `art_live_*` (public client) dan `art_sec_*` (secret admin). SDK web **hanya** boleh memakai `art_live_*` |
| Validasi | Prefix check → LRU cache (TTL 60 s) → query DB dengan singleflight (`ingest/keycache.go`) |
| Panjang key valid | 32–128 karakter |
| Gagal | `401 Unauthorized` (`missing api key` / `invalid api key`) |

## 3. CORS

Dikonfigurasi khusus untuk route ingest di `cmd/api/main.go`:

```
AllowOrigins: "*"
AllowHeaders: "Origin, Content-Type, Content-Encoding, Accept, X-Artracker-Key"
AllowMethods: "POST, OPTIONS"
```

Implikasi untuk SDK:
- `fetch` dengan header `X-Artracker-Key` + `Content-Encoding: gzip` **akan** memicu preflight
  `OPTIONS`, dan preflight itu diizinkan. Browser meng-cache preflight, jadi biayanya sekali
  per origin/periode.
- `sendBeacon` tidak boleh memicu preflight (tidak ada peluang preflight saat unload) →
  gunakan `Blob` bertipe `text/plain` + `?api_key=` sehingga request masuk kategori
  *simple request*.
- `AllowCredentials` tidak diaktifkan → jangan pernah mengirim cookie ke endpoint ingest.

## 4. Kompresi

| Aspek | Perilaku |
| --- | --- |
| Header | `Content-Encoding: gzip` (opsional) |
| Deteksi | Backend memeriksa magic byte `0x1f 0x8b`; jika header gzip ada tapi body ternyata sudah plain JSON (didekompresi proxy), body tetap diterima |
| Proteksi zip-bomb | `io.LimitReader` ke `MaxUncompressedBytes + 1` (`ingest/decompress.go`) |
| Tanpa header | Body dibaca sebagai JSON polos — **selalu valid**, jadi gzip boleh di-skip saat fallback |

## 5. Batas Ukuran (`ingest/model.go`)

| Konstanta | Nilai | Dampak bila dilanggar |
| --- | --- | --- |
| `MaxCompressedBytes` | 512 KB | `413 Request Entity Too Large` |
| `MaxUncompressedBytes` | 2 MB | `413` |
| `MaxBatchItems` | 500 | `400 batch item count exceeds maximum limit` |
| `MaxAttributeBytes` | 32 KB | **Diam-diam** diganti `{"_truncated":true,"_original_bytes":N}` |
| `MaxStringNameLen` | 255 | `name` dipotong |
| `MaxStringMsgLen` | 4096 | `message` dipotong |
| `MaxStringIDLen` | 128 | `session_id` / `user_id` dipotong |

> **Aturan SDK:** target maksimum per request adalah **128 KB uncompressed** dan **50 item**,
> jauh di bawah batas keras, agar ada ruang aman untuk lonjakan ukuran attributes.
> Soft cap per item: **24 KB** setelah `JSON.stringify(attributes)`.

## 6. Skema Envelope

```jsonc
{
  "sent_at": "2026-11-05T09:13:20.120Z",   // RFC3339, waktu kirim — WAJIB diisi SDK
  "sdk": { "name": "artracker-web", "version": "0.1.0" },
  "context": {
    "environment": "production",            // → kolom environment (default "production", maks 64)
    "app_version": "2.4.1",                 // → kolom release_version (maks 64)
    "...": "field lain TIDAK disimpan backend"
  },
  "items": [ /* RawItem, 1..500 */ ]
}
```

**Penting:** hanya `context.environment` dan `context.app_version` (alias `release_version`)
yang dipetakan ke kolom DB (`ingest/sanitize.go`). Field `context` lainnya **hilang**.
Karena itu SDK menyalin metadata perangkat/halaman ke `attributes` pada item
`session_start`.

## 7. Skema Item (`RawItem`)

| Field | Tipe | Aturan |
| --- | --- | --- |
| `id` | string | UUID. Jika valid dipakai apa adanya; jika kosong/invalid backend membuat UUIDv7. **SDK selalu mengisi UUIDv7 sendiri** agar retry idempoten |
| `type` | string | **Hanya** `event`, `log`, `session`. Nilai lain → item **di-drop diam-diam** |
| `name` | string | ≤255 |
| `level` | string | Hanya berlaku untuk `type:"log"`; valid: `debug,info,warn,error,fatal`; invalid → `info`. Untuk tipe lain dipaksa kosong |
| `message` | string | ≤4096 |
| `timestamp` | RFC3339 | Dipakai untuk koreksi clock-skew |
| `session_id` | string | ≤128 |
| `user_id` | string | ≤128 |
| `attributes` | objek JSON | ≤32 KB; JSON invalid → `{}` |

## 8. Normalisasi Timestamp (`ingest/sanitize.go`)

1. **`sent_at` + `timestamp` keduanya ada** → `event_timestamp = received_at - (sent_at - timestamp)`
   selama drift berada di `[0, 7 hari]`. Ini mengoreksi jam klien yang meleset.
2. Hanya `timestamp` → dipakai apa adanya bila berada di `[-30 hari, +5 menit]` dari waktu server.
3. Selain itu → `received_at` (waktu server).

> **Aturan SDK:** selalu kirim `sent_at` pada envelope **dan** `timestamp` pada setiap item.
> Ini satu-satunya cara mendapat urutan waktu yang benar untuk pengguna dengan jam salah.

## 9. Rate Limit (`ingest/ratelimit.go`, default `config.go`)

| Bucket | Default | Respons saat habis |
| --- | --- | --- |
| Request per project | `INGEST_PROJECT_RPS` = 50 req/s | `429` + `Retry-After` (detik) |
| Event per project | `INGEST_PROJECT_EVENTS_PER_SEC` = 1000 event/s | `429` + `Retry-After` |

Token bucket (burst-friendly), dihitung per `project_id` — **dibagi oleh semua pengguna satu
aplikasi**. Karena itu SDK wajib hemat: sampling replay, dedup error, dan breadcrumb tidak
dikirim sebagai item tersendiri.

## 10. Tabel Kode Respons & Reaksi SDK

| Status | Penyebab | Reaksi SDK |
| --- | --- | --- |
| `202` | Diterima | Hapus batch dari IndexedDB, reset backoff |
| `400` | JSON invalid / `items` kosong / >500 item | **Drop permanen** (bug SDK), catat di debug log |
| `401` | Key hilang/invalid | **Hentikan SDK** (kill-switch sesi), jangan retry — mencegah badai request |
| `413` | Payload terlalu besar | Pecah batch jadi dua; jika satu item tetap >batas → drop item itu |
| `429` | Rate limit | Hormati `Retry-After`, jeda global, batch tetap pending |
| `503` | Buffer worker penuh (`Retry-After: 5`) | Sama seperti 429 |
| Network error / offline | — | Batch tetap pending di IndexedDB, backoff eksponensial |

## 11. Penyimpanan & Pembacaan

Tabel `telemetry_events` (partisi RANGE pada `received_at`), kolom:
`id, project_id, kind, name, level, message, session_id, user_id, environment,
release_version, client_timestamp, event_timestamp, received_at, attributes, sdk_meta`.

Indeks yang relevan untuk SDK:
- `(project_id, event_timestamp DESC)`
- `(project_id, kind, event_timestamp DESC)`
- `(project_id, session_id) WHERE session_id <> ''`

Endpoint baca untuk verifikasi manual saat pengembangan:
`GET /api/v1/projects/:projectID/events?kind=all&limit=50` (butuh JWT dashboard, bukan API key).

> **Catatan scope:** belum ada endpoint pembacaan replay (`GET /sessions/:id/replay`).
> SDK tetap mengirim chunk replay sebagai `kind='session'`; pemutarannya adalah scope issue lain.

## 12. Hal yang TIDAK boleh diasumsikan SDK

- Tidak ada dedup di sisi server selain pemakaian ulang `id` → SDK yang bertanggung jawab atas
  idempotensi (UUIDv7 dibuat sekali, dipakai ulang pada setiap retry).
- Tidak ada validasi skema `attributes` → SDK yang menjaga struktur & redaksi PII.
- Tidak ada kompresi balik / respons berisi konfigurasi → tidak ada remote config di iterasi ini.
- `202` **bukan** jaminan data tersimpan (fire-and-forget), hanya jaminan diterima.
