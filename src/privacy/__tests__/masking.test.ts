import { resolveConfig } from '../../core/config'
import { buildMaskOptions, isMaskedArea, shouldMaskInput } from '../masking'

const base = { appKey: 'art_live_' + '0'.repeat(32), endpoint: 'https://a.example/i' }
const cfg = resolveConfig(base)
const open = resolveConfig({ ...base, privacy: { maskAllInputs: false } })

const el = (html: string): HTMLInputElement => {
  document.body.innerHTML = html
  return document.body.querySelector('input,textarea,select') as HTMLInputElement
}

test('maskAllInputs aktif secara default: input teks biasa di-mask', () => {
  expect(shouldMaskInput(el('<input type="text" name="nama">'), cfg)).toBe(true)
  expect(shouldMaskInput(el('<textarea></textarea>'), cfg)).toBe(true)
})

test('maskAllInputs false: input biasa tidak di-mask', () => {
  expect(shouldMaskInput(el('<input type="text" name="nama">'), open)).toBe(false)
})

test('password dan autocomplete cc-* / *-password selalu di-mask meski maskAllInputs false', () => {
  expect(shouldMaskInput(el('<input type="password">'), open)).toBe(true)
  for (const ac of ['cc-number', 'cc-csc', 'cc-exp', 'current-password', 'new-password', 'billing cc-number', 'one-time-code']) {
    expect(shouldMaskInput(el(`<input type="text" autocomplete="${ac}">`), open)).toBe(true)
  }
})

test('name/id yang menyiratkan data sensitif selalu di-mask, tetapi bukan sekadar potongan kata', () => {
  for (const attr of ['name="card_number"', 'id="cvv"', 'name="cardNumber"', 'name="nik"', 'id="otp-code"', 'name="pin"']) {
    expect(shouldMaskInput(el(`<input type="text" ${attr}>`), open)).toBe(true)
  }
  for (const attr of ['name="shipping"', 'id="spinner"', 'name="pinterest"', 'name="cardinality"']) {
    expect(shouldMaskInput(el(`<input type="text" ${attr}>`), open)).toBe(false)
  }
})

test('data-artracker-mask pada leluhur me-mask; data-artracker-unmask membuka input biasa', () => {
  expect(shouldMaskInput(el('<div data-artracker-mask><input type="text"></div>'), open)).toBe(true)
  expect(shouldMaskInput(el('<div data-artracker-unmask><input type="text" name="kota"></div>'), cfg)).toBe(false)
})

test('data-artracker-unmask tidak pernah membuka field sensitif, dan mask menang atas unmask', () => {
  expect(shouldMaskInput(el('<div data-artracker-unmask><input type="password"></div>'), cfg)).toBe(true)
  expect(shouldMaskInput(el('<div data-artracker-mask><div data-artracker-unmask><input type="text"></div></div>'), cfg)).toBe(true)
})

test('isMaskedArea mengenali atribut mask/block dan class konfigurasi', () => {
  document.body.innerHTML = '<div data-artracker-mask><b id="a">x</b></div><i id="b" class="ar-block">y</i><u id="c" class="ar-mask">z</u><s id="d">w</s>'
  const q = (id: string) => document.getElementById(id) as Element
  expect([q('a'), q('b'), q('c'), q('d')].map((e) => isMaskedArea(e, cfg))).toEqual([true, true, true, false])
})

test('buildMaskOptions: blockSelector/blockClass dan maskTextClass dari konfigurasi', () => {
  const o = buildMaskOptions(resolveConfig({ ...base, privacy: { blockClass: 'secret-blk', maskTextClass: 'secret-txt' } }))
  expect(o.blockSelector).toBe('[data-artracker-block]')
  expect(o.blockClass).toBe('secret-blk')
  expect(o.maskTextClass).toBe('secret-txt')
})

test('buildMaskOptions: maskInputFn menutup nilai sensitif dan menghormati maskAllInputs', () => {
  const fn = buildMaskOptions(open).maskInputFn as (t: string, e: HTMLElement) => string
  expect(fn('rahasia', el('<input type="password">'))).toBe('*******')
  expect(fn('Bandung', el('<input type="text" name="kota">'))).toBe('Bandung')
  const all = buildMaskOptions(cfg).maskInputFn as (t: string, e: HTMLElement) => string
  expect(all('Bandung', el('<input type="text" name="kota">'))).toBe('*******')
})

test('buildMaskOptions: semua tipe input diteruskan ke maskInputFn agar keputusan ada di tangan kita', () => {
  const opts = buildMaskOptions(open).maskInputOptions as Record<string, boolean>
  for (const k of ['text', 'email', 'tel', 'number', 'password', 'textarea', 'select', 'search', 'url']) expect(opts[k]).toBe(true)
})

test('buildMaskOptions: maskTextFn menjalankan redactString pada teks biasa dan bintang pada area mask', () => {
  const o = buildMaskOptions(cfg)
  expect(o.maskTextSelector).toBe('*')
  const fn = o.maskTextFn as (t: string, e: HTMLElement | null) => string
  expect(fn('hubungi budi@example.com', null)).not.toContain('budi@example')
  expect(fn('Halaman beranda', null)).toBe('Halaman beranda')
  document.body.innerHTML = '<div data-artracker-mask><b id="s">Saldo 5.000</b></div>'
  expect(fn('Saldo 5.000', document.getElementById('s'))).toBe('***** *****')
})

test('input hidden (token CSRF, email) selalu di-mask, bahkan saat maskAllInputs false', () => {
  expect(shouldMaskInput(el('<input type="hidden" name="csrf" value="abc">'), open)).toBe(true)
  const opts = buildMaskOptions(open).maskInputOptions as Record<string, boolean>
  expect(opts.hidden).toBe(true)
})
