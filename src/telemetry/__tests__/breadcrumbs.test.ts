import { BreadcrumbBuffer } from '../breadcrumbs'

test('ring buffer membuang entri terlama di atas limit', () => {
  const b = new BreadcrumbBuffer(3)
  for (let i = 1; i <= 5; i++) b.add({ type: 't', at: i, data: { i } })
  expect(b.snapshot().map((x) => x.at)).toEqual([3, 4, 5])
})

test('snapshot mengembalikan salinan', () => {
  const b = new BreadcrumbBuffer(3)
  b.add({ type: 't', at: 1, data: {} })
  b.snapshot().pop()
  expect(b.snapshot()).toHaveLength(1)
})

// ---- listener click / input ----
import { resolveConfig } from '../../core/config'
import { SessionManager } from '../../core/session'
import type { TelemetryContext } from '../../core/client'
import { installBreadcrumbListeners } from '../breadcrumbs'

describe('installBreadcrumbListeners', () => {
  const cfg = resolveConfig({ appKey: 'art_live_' + '0'.repeat(32), endpoint: 'https://a.example/i' })
  let buf: BreadcrumbBuffer
  let off: () => void
  const ctx = (): TelemetryContext => ({ cfg, session: new SessionManager(cfg), breadcrumbs: buf, emit: vi.fn() })

  beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = ''
    buf = new BreadcrumbBuffer(30)
    off = installBreadcrumbListeners(ctx())
  })
  afterEach(() => off())

  const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  const type = (el: HTMLInputElement, value: string) => {
    el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  test('klik mencatat tag, selector, dan teks yang sudah diredaksi', () => {
    document.body.innerHTML = '<div class="card box extra"><button id="pay" aria-label="Bayar untuk budi@example.com">Bayar sekarang</button></div>'
    click(document.getElementById('pay') as Element)
    const [b] = buf.snapshot()
    expect(b?.type).toBe('click')
    expect(b?.data.tag).toBe('button')
    expect(String(b?.data.selector)).toContain('button#pay')
    expect(b?.data.text).toBe('Bayar sekarang')
    expect(String(b?.data.aria_label)).not.toContain('budi@example.com')
  })

  test('teks klik dipotong ke 64 karakter dan PII di dalamnya diredaksi', () => {
    document.body.innerHTML = `<button id="b">${'x'.repeat(200)}</button><a id="l" href="#">hubungi budi@example.com</a>`
    click(document.getElementById('b') as Element)
    click(document.getElementById('l') as Element)
    const [first, second] = buf.snapshot()
    expect(String(first?.data.text).length).toBeLessThanOrEqual(64)
    expect(String(second?.data.text)).not.toContain('budi@example.com')
  })

  test('klik pada elemen yang di-mask tidak mencatat teks', () => {
    document.body.innerHTML = '<div data-artracker-mask><button id="s">Saldo Rp 5.000.000</button></div><button id="c" class="ar-block">Rahasia</button>'
    click(document.getElementById('s') as Element)
    click(document.getElementById('c') as Element)
    for (const b of buf.snapshot()) expect(b.data.text).toBeUndefined()
    expect(JSON.stringify(buf.snapshot())).not.toContain('5.000.000')
  })

  test('klik pada input tidak pernah mencatat nilainya', () => {
    document.body.innerHTML = '<input id="i" value="4539 1488 0343 6467">'
    click(document.getElementById('i') as Element)
    expect(JSON.stringify(buf.snapshot())).not.toContain('4539')
  })

  test('input hanya mencatat status filled/cleared, tidak pernah nilainya', () => {
    document.body.innerHTML = '<input id="i" type="password">'
    const input = document.getElementById('i') as HTMLInputElement
    type(input, 'r')
    type(input, 'rahasia')
    type(input, '')
    const snap = buf.snapshot()
    expect(snap.map((b) => b.data.state)).toEqual(['filled', 'cleared']) // bukan satu breadcrumb per ketukan
    expect(JSON.stringify(snap)).not.toContain('rahasia')
  })

  test('event pada target non-Element diabaikan tanpa melempar', () => {
    expect(() => document.dispatchEvent(new Event('click'))).not.toThrow()
    expect(buf.snapshot()).toHaveLength(0)
  })

  test('listener dilepas setelah fungsi pembersih dipanggil', () => {
    document.body.innerHTML = '<button id="b">x</button>'
    off()
    click(document.getElementById('b') as Element)
    expect(buf.snapshot()).toHaveLength(0)
  })
})
