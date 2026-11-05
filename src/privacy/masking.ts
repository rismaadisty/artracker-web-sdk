import type { ResolvedConfig } from '../types'
import { redactString } from './redactor'

const SAFE_CLASS = /^[\w-]+$/
const SENSITIVE_AUTOCOMPLETE = /^(cc-|current-password$|new-password$|one-time-code$)/
// Kata utuh (card, cvv, pin, ...) agar shipping/spinner/pinterest/cardinality tidak ikut tertutup.
const SENSITIVE_IDENT = /(^|[^a-z])(card|cvv|cvc|ssn|nik|pin|otp)([^a-z]|$)|creditcard|cardnumber/i

const INPUT_TYPES = ['color', 'date', 'datetime-local', 'email', 'month', 'number', 'range', 'search', 'tel', 'text', 'time', 'url', 'week', 'textarea', 'select', 'password', 'hidden']

/** Elemen di dalam area yang ditandai mask/block. Gagal (selector tak valid) => dianggap ter-mask. */
export function isMaskedArea(el: Element, cfg: ResolvedConfig): boolean {
  try {
    const sels = ['[data-artracker-mask]', '[data-artracker-block]']
    for (const c of [cfg.privacy.blockClass, cfg.privacy.maskTextClass]) if (c && SAFE_CLASS.test(c)) sels.push('.' + c)
    return el.closest(sels.join(',')) !== null
  } catch {
    return true
  }
}

function isSensitiveField(el: Element): boolean {
  const type = (el as HTMLInputElement).type
  if (type === 'password' || type === 'hidden') return true // hidden: token CSRF, id/email pengguna, dsb.
  const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/)
  if (ac.some((t) => SENSITIVE_AUTOCOMPLETE.test(t))) return true
  return SENSITIVE_IDENT.test(`${el.getAttribute('name') ?? ''} ${el.id ?? ''}`)
}

/**
 * Keputusan mask satu input. Field sensitif SELALU di-mask (mengabaikan maskAllInputs dan unmask);
 * area mask menang atas unmask; unmask hanya membuka input biasa.
 */
export function shouldMaskInput(el: Element, cfg: ResolvedConfig): boolean {
  if (isSensitiveField(el)) return true
  if (isMaskedArea(el, cfg)) return true
  if (el.closest('[data-artracker-unmask]')) return false
  return cfg.privacy.maskAllInputs
}

const stars = (s: string): string => s.replace(/\S/g, '*')

/**
 * Opsi privasi untuk rrweb.record. Semua tipe input diteruskan ke maskInputFn supaya keputusan mask
 * (termasuk field sensitif saat maskAllInputs=false) ada di tangan kita. maskTextSelector '*' memaksa SETIAP
 * text node melewati maskTextFn, sehingga PII pada teks biasa diredaksi dan area mask jadi bintang.
 */
export function buildMaskOptions(cfg: ResolvedConfig): Record<string, unknown> {
  return {
    maskInputOptions: Object.fromEntries(INPUT_TYPES.map((t) => [t, true])),
    maskInputFn: (text: string, el: HTMLElement): string => (shouldMaskInput(el, cfg) ? '*'.repeat(text.length) : text),
    maskTextClass: cfg.privacy.maskTextClass,
    maskTextSelector: '*',
    maskTextFn: (text: string, el: HTMLElement | null): string => (el && isMaskedArea(el, cfg) ? stars(text) : redactString(text)),
    blockClass: cfg.privacy.blockClass,
    blockSelector: '[data-artracker-block]',
  }
}
