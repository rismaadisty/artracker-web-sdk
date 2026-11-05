# Contoh Next.js (App Router)

1. `pnpm add @artracker/browser`
2. Env: `NEXT_PUBLIC_ARTRACKER_KEY=art_live_...` dan `NEXT_PUBLIC_ARTRACKER_ENDPOINT=https://api.example.com/api/v1/ingest`
3. `app/providers.tsx`:

```tsx
'use client'
import { useEffect } from 'react'
import { ARTracker } from '@artracker/browser'

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    ARTracker.init({
      appKey: process.env.NEXT_PUBLIC_ARTRACKER_KEY!,
      endpoint: process.env.NEXT_PUBLIC_ARTRACKER_ENDPOINT!,
      appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
    })
    return () => ARTracker.shutdown() // aman untuk React Strict Mode / HMR
  }, [])
  return <>{children}</>
}
```

4. Bungkus `children` di `app/layout.tsx` dengan `<Providers>`.

Modul `@artracker/browser` aman diimpor dari Server Component: di server semua method menjadi no-op.

Untuk replay: `pnpm add rrweb`, lalu
`import { replay } from '@artracker/browser/replay'` dan `replay: replay({ sampleRate: 0.1 })` pada `init()`.
