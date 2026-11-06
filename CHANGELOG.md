# Changelog

## 0.1.0

Rilis pertama `@artracker/browser`.

- Core: `init`, `identify`, `track`, `log`, `captureException`, `setContext`, `addBreadcrumb`, `flush`, `reset`, `shutdown`, `disable`/`enable`.
- Sesi (30 menit idle / 4 jam), identitas pengguna, sampling per sesi, SSR no-op, opsi Do Not Track.
- Privasi: redaksi PII (email, kartu+Luhn, telepon ID, NIK, JWT, key, param URL, key sensitif) sebelum antrean/IndexedDB/jaringan; `beforeSend`.
- Telemetri otomatis: error & `unhandledrejection` (dedup + circuit breaker), resource error, `fetch`/XHR, breadcrumbs klik/input/navigasi, `page_view` SPA.
- Transport: batching, IndexedDB (+fallback localStorage), gzip di Web Worker (+fallback), `sendBeacon` saat unload, backoff + `Retry-After`, `401` mematikan SDK, `413` memecah batch.
- Session replay (opt-in) lewat `@artracker/browser/replay` + `rrweb` (optional peer): masking DOM, chunk ≤ 24 KB.
- Ukuran (min+gzip): entry 11,8 kB, adapter replay 2,9 kB; rrweb ±57 kB di luar entry.

Perbaikan dari review akhir (sebelum rilis): fallback storage ke memori, `<input type=hidden>` dan PII pada atribut elemen di replay, batas ukuran dalam byte UTF-8, kuota IndexedDB saat sesi berjalan, `session_start` hanya untuk sesi baru + `page_view` awal, traits tidak lagi ditulis ke `localStorage`, race `disable()`/`enable()`.

Perbaikan dari pengujian pada backend hidup dan Chrome (sebelum rilis): objek `Error` dari realm lain (iframe, micro-frontend) tidak lagi tersimpan sebagai `Error: {}` tanpa pesan dan stack, baik lewat `captureException`, `unhandledrejection`, `window.onerror`, maupun saat berada di dalam `attributes`.

Terverifikasi (2026-11-05): 4 tes integrasi lulus terhadap backend lokal (API Go + Postgres 16); di Chrome 156 preflight CORS dijawab `204`, `POST` gzip dijawab `202`, PII tersamarkan di payload dan di database, error tercatat dengan stack dan breadcrumb, dan batch yang masih tertunda tetap sampai saat halaman ditinggalkan.

Belum ada: `privacy.hashEmails`, `network.captureBodies`, Web Vitals.

Belum terverifikasi: benchmark long-task, Safari dan Firefox, session replay (rrweb) di browser sungguhan, dan jalur `sendBeacon` secara spesifik (pengiriman saat unload terbukti sampai, tetapi mekanismenya tidak terkonfirmasi).
