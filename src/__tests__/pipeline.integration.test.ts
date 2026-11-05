import { gzipSync } from 'node:zlib'
import { createItem } from '../core/envelope'
import { buildEnvelope } from '../core/envelope'
import { resolveConfig } from '../core/config'

const endpoint = process.env.ARTRACKER_E2E_ENDPOINT
const key = process.env.ARTRACKER_E2E_KEY

// Butuh backend lokal hidup: `make api` + API key art_live_ dari dashboard.
describe.skipIf(!endpoint || !key)('ingest end-to-end (backend nyata)', () => {
  // Lazy: body describe tetap dievaluasi saat skipIf aktif, jadi jangan validasi key di sini.
  const config = () => resolveConfig({ appKey: key ?? '', endpoint: endpoint ?? 'http://x' })
  const envelope = () =>
    buildEnvelope(
      [
        createItem({ type: 'event', name: 'e2e_event', attributes: { from: 'sdk-integration-test' } }),
        createItem({ type: 'log', level: 'error', message: 'e2e error', attributes: { from: 'sdk-integration-test' } }),
      ],
      config(),
      { environment: 'e2e' },
      Date.now(),
    )

  test('202 untuk JSON polos dengan queued: 2', async () => {
    const cfg = config()
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Artracker-Key': cfg.appKey },
      body: JSON.stringify(envelope()),
    })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ status: 'accepted', queued: 2 })
  })

  test('202 untuk body gzip dengan Content-Encoding: gzip', async () => {
    const cfg = config()
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'X-Artracker-Key': cfg.appKey },
      body: new Uint8Array(gzipSync(JSON.stringify(envelope()))),
    })
    expect(res.status).toBe(202)
  })

  test('fallback ?api_key= (jalur sendBeacon) diterima tanpa header kunci', async () => {
    const cfg = config()
    const res = await fetch(`${cfg.endpoint}?api_key=${encodeURIComponent(cfg.appKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(envelope()),
    })
    expect(res.status).toBe(202)
  })

  test('key tidak valid ditolak 401', async () => {
    const cfg = config()
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Artracker-Key': 'art_live_' + 'f'.repeat(40) },
      body: JSON.stringify(envelope()),
    })
    expect(res.status).toBe(401)
  })
})
