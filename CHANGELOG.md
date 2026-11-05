# Changelog

## 0.1.0

Rilis pertama `@artracker/browser`.

- Core: `init`, `identify`, `track`, `log`, `captureException`, `setContext`, `addBreadcrumb`, `flush`, `reset`, `shutdown`, `disable`/`enable`.
- Sesi (30 menit idle / 4 jam), identitas pengguna, sampling per sesi, SSR no-op, opsi Do Not Track.
- Privasi: redaksi PII (email, kartu+Luhn, telepon ID, NIK, JWT, key, param URL, key sensitif) sebelum antrean/IndexedDB/jaringan; `beforeSend`.
- Telemetri otomatis: error & `unhandledrejection` (dedup + circuit breaker), resource error, `fetch`/XHR, breadcrumbs klik/input/navigasi, `page_view` SPA.
- Transport: batching, IndexedDB (+fallback localStorage), gzip di Web Worker (+fallback), `sendBeacon` saat unload, backoff + `Retry-After`, `401` mematikan SDK, `413` memecah batch.
- Session replay (opt-in) lewat `@artracker/browser/replay` + `rrweb` (optional peer): masking DOM, chunk ≤ 24 KB.
- Ukuran (min+gzip): entry 11,5 kB, adapter replay 2,5 kB; rrweb ±57 kB di luar entry.

Belum ada: `privacy.hashEmails`, `network.captureBodies`, Web Vitals, pengujian di browser sungguhan, verifikasi terhadap backend hidup.
