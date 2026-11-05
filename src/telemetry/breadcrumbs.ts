import type { TelemetryContext } from '../core/client'
import type { ResolvedConfig } from '../types'
import { redactString } from '../privacy/redactor'

export interface Breadcrumb {
  type: string
  at: number
  data: Record<string, unknown>
}

/** Ring buffer breadcrumb: tidak dikirim sebagai item sendiri, hanya dilampirkan pada error dan session_end. */
export class BreadcrumbBuffer {
  private items: Breadcrumb[] = []

  constructor(private readonly limit: number) {}

  add(b: Breadcrumb): void {
    this.items.push(b)
    if (this.items.length > this.limit) this.items.shift()
  }

  snapshot(): Breadcrumb[] {
    return this.items.slice()
  }
}

const MAX_TEXT = 64
const CLICKABLE = 'a,button,[role="button"],input,select,textarea,label,summary'
const SAFE_CLASS = /^[\w-]+$/

function selectorOf(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  for (let i = 0; cur && i < 3 && cur !== document.documentElement; i++) {
    let p = cur.tagName.toLowerCase()
    if (cur.id) {
      parts.unshift(`${p}#${cur.id}`)
      break
    }
    const cls = typeof cur.className === 'string' ? cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : []
    if (cls.length) p += '.' + cls.join('.')
    parts.unshift(p)
    cur = cur.parentElement
  }
  return redactString(parts.join(' > '))
}

/** Elemen di dalam area yang ditandai mask/block tidak boleh mengungkap teksnya. Gagal => dianggap ter-mask. */
function isMasked(el: Element, cfg: ResolvedConfig): boolean {
  try {
    const sels = ['[data-artracker-mask]', '[data-artracker-block]']
    for (const c of [cfg.privacy.blockClass, cfg.privacy.maskTextClass]) if (c && SAFE_CLASS.test(c)) sels.push('.' + c)
    return el.closest(sels.join(',')) !== null
  } catch {
    return true
  }
}

const isFormField = (el: Element): boolean => /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)

function eventElement(ev: Event): Element | null {
  const t = ev.target as Node | null
  if (!t) return null
  if (t instanceof Element) return t
  return t.parentElement
}

/** Click + input sebagai breadcrumb. Nilai input TIDAK PERNAH dicatat; hanya status filled/cleared. */
export function installBreadcrumbListeners(ctx: TelemetryContext): () => void {
  const lastState = new WeakMap<Element, string>()

  const onClick = (ev: Event): void => {
    try {
      const raw = eventElement(ev)
      if (!raw) return
      const el = raw.closest(CLICKABLE) ?? raw
      const data: Record<string, unknown> = { tag: el.tagName.toLowerCase(), selector: selectorOf(el) }
      if (!isFormField(el) && !isMasked(el, ctx.cfg)) {
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
        if (text) data.text = redactString(text)
        const aria = el.getAttribute('aria-label')
        if (aria) data.aria_label = redactString(aria.slice(0, MAX_TEXT))
      }
      ctx.breadcrumbs.add({ type: 'click', at: Date.now(), data })
    } catch {
      /* diabaikan */
    }
  }

  const onInput = (ev: Event): void => {
    try {
      const el = eventElement(ev)
      if (!el || !isFormField(el)) return
      const f = el as HTMLInputElement
      const filled = f.type === 'checkbox' || f.type === 'radio' ? f.checked : f.value.length > 0
      const state = filled ? 'filled' : 'cleared'
      if (lastState.get(el) === state) return // satu breadcrumb per perubahan status, bukan per ketukan
      lastState.set(el, state)
      ctx.breadcrumbs.add({ type: 'input', at: Date.now(), data: { tag: el.tagName.toLowerCase(), selector: selectorOf(el), state } })
    } catch {
      /* diabaikan */
    }
  }

  const opts = { capture: true, passive: true } as const
  document.addEventListener('click', onClick, opts)
  document.addEventListener('input', onInput, opts)
  return () => {
    document.removeEventListener('click', onClick, opts)
    document.removeEventListener('input', onInput, opts)
  }
}
