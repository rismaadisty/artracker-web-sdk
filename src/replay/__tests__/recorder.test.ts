import { resolveConfig } from '../../core/config'
import { SessionManager } from '../../core/session'
import type { TelemetryContext } from '../../core/client'
import { BreadcrumbBuffer } from '../../telemetry/breadcrumbs'
import { startRecording } from '../recorder'

const base = { appKey: 'art_live_' + '0'.repeat(32), endpoint: 'https://a.example/i' }
type Emitted = { type: string; name: string; at?: number; skipRedaction?: boolean; attributes: { seq: number; start: number; end: number; full_snapshot: boolean; events: Array<{ type: number }> } }

let emit: ReturnType<typeof vi.fn>
const make = (replay: { enabled?: boolean; sampleRate?: number } = { enabled: true, sampleRate: 1 }, privacy = {}) => {
  const cfg = resolveConfig({ ...base, replay, privacy })
  const ctx: TelemetryContext = { cfg, session: new SessionManager(cfg), breadcrumbs: new BreadcrumbBuffer(30), emit: emit as unknown as TelemetryContext['emit'] }
  return ctx
}
const chunks = () => emit.mock.calls.map((c) => c[0] as Emitted)

beforeEach(() => {
  sessionStorage.clear()
  document.body.innerHTML = '<p id="p">halo dunia</p>'
  emit = vi.fn()
})

test('tidak merekam saat replay.enabled false', async () => {
  const stop = await startRecording(make({ enabled: false }))
  document.getElementById('p')!.textContent = 'berubah'
  await new Promise((r) => setTimeout(r, 20))
  stop()
  expect(emit).not.toHaveBeenCalled()
})

test('force mengabaikan enabled dan sampling (dipakai startReplay manual)', async () => {
  const stop = await startRecording(make({ enabled: false, sampleRate: 0 }), { force: true })
  stop()
  expect(chunks().length).toBeGreaterThan(0)
})

test('keputusan sampling deterministik untuk session_id yang sama', async () => {
  const ctx = make({ enabled: true, sampleRate: 0.5 })
  const results: number[] = []
  for (let i = 0; i < 3; i++) {
    emit.mockClear()
    const stop = await startRecording(ctx)
    stop()
    results.push(emit.mock.calls.length > 0 ? 1 : 0)
  }
  expect(new Set(results).size).toBe(1)
})

test('sampleRate 0 tidak merekam, sampleRate 1 merekam', async () => {
  ;(await startRecording(make({ enabled: true, sampleRate: 0 })))()
  expect(emit).not.toHaveBeenCalled()
  ;(await startRecording(make({ enabled: true, sampleRate: 1 })))()
  expect(emit).toHaveBeenCalled()
})

test('chunk dipancarkan sebagai item session replay_chunk dengan full snapshot dan skipRedaction', async () => {
  const stop = await startRecording(make())
  document.getElementById('p')!.textContent = 'berubah'
  await new Promise((r) => setTimeout(r, 20))
  stop()
  const [first] = chunks()
  expect(first?.type).toBe('session')
  expect(first?.name).toBe('replay_chunk')
  expect(first?.skipRedaction).toBe(true)
  expect(first?.attributes.seq).toBe(0)
  expect(first?.attributes.full_snapshot).toBe(true)
  expect(first?.attributes.events.some((e) => e.type === 2)).toBe(true)
  expect(first?.at).toBe(first?.attributes.start)
  for (const c of chunks()) expect(JSON.stringify(c.attributes).length).toBeLessThanOrEqual(24 * 1024)
})

test('pagehide membuang buffer secara sinkron sebelum handler lain berjalan', async () => {
  const stop = await startRecording(make())
  emit.mockClear()
  document.getElementById('p')!.textContent = 'sebelum pagehide'
  await new Promise((r) => setTimeout(r, 20))
  window.dispatchEvent(new Event('pagehide'))
  expect(emit).toHaveBeenCalled()
  stop()
})

test('stop() menghentikan perekaman: mutasi setelahnya tidak menghasilkan chunk', async () => {
  const stop = await startRecording(make())
  stop()
  const count = emit.mock.calls.length
  document.getElementById('p')!.textContent = 'setelah stop'
  await new Promise((r) => setTimeout(r, 30))
  expect(emit.mock.calls.length).toBe(count)
  expect(() => stop()).not.toThrow() // idempoten
})

// Privasi: rrweb NYATA di jsdom, bukan mock.
test('PII, input, area mask/block, dan token URL tidak pernah muncul di event yang direkam', async () => {
  document.body.innerHTML = `
    <input id="n" type="text" name="nama" value="Budi Santoso">
    <input id="pw" type="password" value="hunter2">
    <input id="cc" type="text" autocomplete="cc-number" value="4539148803436467">
    <p>hubungi budi@example.com atau 081234567890</p>
    <p>Halaman beranda aman</p>
    <div data-artracker-block>blockedsecret</div>
    <div data-artracker-mask>maskedsecret</div>
    <a href="https://a.example/cb?token=abc123&x=1">link</a>`
  const stop = await startRecording(make({ enabled: true, sampleRate: 1 }, { maskAllInputs: false }))
  await new Promise((r) => setTimeout(r, 20))
  stop()
  const dump = JSON.stringify(chunks().map((c) => c.attributes))
  for (const secret of ['hunter2', '4539148803436467', 'budi@example.com', '081234567890', 'blockedsecret', 'maskedsecret', 'abc123']) {
    expect(dump, `bocor: ${secret}`).not.toContain(secret)
  }
  expect(dump).toContain('Halaman beranda aman') // teks tanpa PII tetap utuh agar replay berguna
  expect(dump).toContain('Budi Santoso') // nama biasa dengan maskAllInputs:false boleh terekam
})

test('maskAllInputs default menutup input biasa juga', async () => {
  document.body.innerHTML = '<input type="text" name="kota" value="Bandung">'
  const stop = await startRecording(make())
  stop()
  expect(JSON.stringify(chunks().map((c) => c.attributes))).not.toContain('Bandung')
})

test('rrweb yang tidak terpasang menghasilkan no-op, bukan error', async () => {
  vi.resetModules()
  vi.doMock('rrweb', () => {
    throw new Error('Cannot find module rrweb')
  })
  const { startRecording: start } = await import('../recorder')
  const stop = await start(make())
  expect(typeof stop).toBe('function')
  expect(() => stop()).not.toThrow()
  expect(emit).not.toHaveBeenCalled()
  vi.doUnmock('rrweb')
  vi.resetModules()
})
