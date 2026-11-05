import { isError } from '../core/safe'
import type { RawItem, ResolvedConfig } from '../types'
import { redactQueryParams } from './urlScrubber'

const REDACTED = '[redacted]'
const MAX_DEPTH = 6
const MAX_NODES = 1000

// Semua pola menghindari lookbehind (Safari < 16.4); batas digit memakai grup tangkap (^|\D).
const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const BASIC_RE = /\bBasic\s+[A-Za-z0-9+/=]{8,}/g
const API_KEY_RES = [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, /\bart_(?:sec|live)_[A-Za-z0-9]{8,}\b/g]
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const CARD_RE = /(^|\D)((?:\d[ -]?){12,18}\d)(?!\d)/g
const NIK_RE = /(^|\D)(\d{16})(?!\d)/g
const PHONE_RE = /(^|\D)((?:\+62|62|0)8\d{8,11})(?!\d)/g

function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

/** NIK: provinsi 11-94, tanggal lahir 01-31 (perempuan +40), bulan 01-12. */
function looksLikeNik(d: string): boolean {
  const prov = Number(d.slice(0, 2))
  const day = Number(d.slice(6, 8))
  const month = Number(d.slice(8, 10))
  return prov >= 11 && prov <= 94 && ((day >= 1 && day <= 31) || (day >= 41 && day <= 71)) && month >= 1 && month <= 12
}

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  return `${email.slice(0, 1)}***${email.slice(at)}`
}

// Fast path: semua pola di bawah butuh salah satu pemicu ini; teks biasa tanpa pemicu (mayoritas node DOM) lewat tanpa regex.
const TRIGGER = /[@=\d]|eyj|bearer|basic|_live_|_test_|_sec_/i

function builtIn(input: string): string {
  if (!TRIGGER.test(input)) return input
  let s = input
  s = s.replace(JWT_RE, REDACTED)
  s = s.replace(BEARER_RE, `Bearer ${REDACTED}`).replace(BASIC_RE, `Basic ${REDACTED}`)
  for (const re of API_KEY_RES) s = s.replace(re, REDACTED)
  s = redactQueryParams(s)
  s = s.replace(EMAIL_RE, maskEmail)
  s = s.replace(CARD_RE, (m, pre: string, num: string) => {
    const digits = num.replace(/[ -]/g, '')
    if (digits.length < 13 || digits.length > 19) return m
    // Epoch milidetik 13 digit (mis. 1762331598050) bukan kartu; tidak ada merek kartu 13 digit berawalan 1.
    if (digits.length === 13 && digits.startsWith('1')) return m
    return luhn(digits) ? `${pre}**** **** **** ${digits.slice(-4)}` : m
  })
  s = s.replace(NIK_RE, (m, pre: string, num: string) => (looksLikeNik(num) ? `${pre}${REDACTED}` : m))
  s = s.replace(PHONE_RE, (_m, pre: string, num: string) => {
    const plus = num.startsWith('+') ? '+' : ''
    return `${pre}${plus}${'*'.repeat(num.length - plus.length - 4)}${num.slice(-4)}`
  })
  return s
}

export function redactString(input: string): string {
  return redactStringWith(input, [])
}

function redactStringWith(input: string, extra: Array<(s: string) => string>): string {
  let s = builtIn(input)
  for (const fn of extra) {
    try {
      s = fn(s)
    } catch {
      /* redactor kustom yang rusak dilewati */
    }
  }
  return s
}

const SHORT_WORDS = new Set(['pass', 'pwd', 'pin', 'otp', 'cvv', 'cvc', 'ssn', 'nik', 'card'])
const LONG_SUBSTRINGS = ['password', 'passwd', 'secret', 'token', 'authorization', 'cookie', 'apikey', 'creditcard', 'cardnumber']

/**
 * Kata pendek dicocokkan sebagai KATA utuh (className, shipping, passenger tidak ikut), kata panjang
 * sebagai potongan pada key yang dinormalisasi (userPassword, x-api-key, access_token).
 */
function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
  if (words.some((w) => SHORT_WORDS.has(w))) return true
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return LONG_SUBSTRINGS.some((s) => compact.includes(s))
}

interface Walk {
  nodes: number
  seen: WeakSet<object>
  extra: Array<(s: string) => string>
}

function walk(v: unknown, depth: number, ctx: Walk): unknown {
  if (typeof v === 'string') return redactStringWith(v, ctx.extra)
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'bigint') return String(v)
  if (typeof v !== 'object') return undefined // function, symbol, undefined
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  if (isError(v)) return { name: v.name, message: redactStringWith(v.message, ctx.extra) }
  if (depth >= MAX_DEPTH) return '[max-depth]'
  if (ctx.seen.has(v)) return '[circular]'
  if (++ctx.nodes > MAX_NODES) return '[truncated]'
  ctx.seen.add(v)
  try {
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1, ctx))
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v)) {
      const val = (v as Record<string, unknown>)[k]
      out[k] = isSensitiveKey(k) ? REDACTED : walk(val, depth + 1, ctx)
    }
    return out
  } finally {
    ctx.seen.delete(v) // hanya leluhur yang dihitung sirkular; referensi bersama non-siklik tetap diproses
  }
}

export function redactValue(value: unknown, depth = 0, extra: Array<(s: string) => string> = []): unknown {
  return walk(value, depth, { nodes: 0, seen: new WeakSet(), extra })
}

function looksLikeItem(x: unknown): x is RawItem {
  return typeof x === 'object' && x !== null && typeof (x as RawItem).type === 'string'
}

/**
 * Redaksi bawaan -> redactor kustom -> beforeSend (paling akhir). null = item dibuang.
 * beforeSend yang melempar membuang item (fail-closed): hook itu sering adalah scrubber milik pengguna.
 */
export function redactItem(item: RawItem, cfg: ResolvedConfig, opts?: { skipAttributes?: boolean }): RawItem | null {
  const extra = cfg.privacy.redactors
  const out: RawItem = { ...item }
  if (out.name) out.name = redactStringWith(out.name, extra)
  if (out.message) out.message = redactStringWith(out.message, extra)
  if (out.attributes && !opts?.skipAttributes) out.attributes = redactValue(out.attributes, 0, extra) as Record<string, unknown>

  if (cfg.beforeSend) {
    let result: unknown
    try {
      result = cfg.beforeSend(out)
    } catch (err) {
      if (cfg.debug) console.warn('[artracker] beforeSend threw; item dropped', err)
      return null
    }
    if (result === null) return null
    if (looksLikeItem(result)) return result
  }
  return out
}
