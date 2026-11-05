import type { ResolvedConfig } from '../types'

declare const __AR_VERSION__: string
export const SDK_NAME = 'artracker-web'
export const SDK_VERSION: string = typeof __AR_VERSION__ === 'string' ? __AR_VERSION__ : '0.0.0'

function pick<T>(fn: () => T, fallback: T): T {
  try {
    return fn() ?? fallback
  } catch {
    return fallback
  }
}

/** URL tanpa query/hash: query dan fragment sering membawa token atau PII. */
function safePage(): string {
  return pick(() => window.location.origin + window.location.pathname, '')
}

/** Metadata perangkat/halaman. Dipakai pada session_start karena backend hanya menyimpan environment & app_version. */
export function collectDeviceMeta(): Record<string, unknown> {
  return {
    referrer: pick(() => document.referrer.split(/[?#]/)[0] ?? '', ''),
    entry_url: safePage(),
    screen: pick(() => `${screen.width}x${screen.height}`, ''),
    viewport: pick(() => `${window.innerWidth}x${window.innerHeight}`, ''),
    ua: pick(() => navigator.userAgent, ''),
    lang: pick(() => navigator.language, ''),
    tz: pick(() => Intl.DateTimeFormat().resolvedOptions().timeZone, ''),
  }
}

export function buildContext(cfg: ResolvedConfig): Record<string, unknown> {
  const meta = collectDeviceMeta()
  return {
    environment: cfg.environment,
    app_version: cfg.appVersion,
    page: safePage(),
    referrer: meta.referrer,
    screen: meta.screen,
    ua: meta.ua,
    lang: meta.lang,
    tz: meta.tz,
    sdk_platform: 'web',
  }
}
