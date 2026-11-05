const SENSITIVE_PARAMS = [
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'code',
  'email',
  'sig',
  'signature',
  'api_key',
  'apikey',
  'password',
  'secret',
].join('|')

// Tanpa lookbehind: Safari < 16.4 melempar SyntaxError saat memuat modul bila ada (?<!...).
// Nilai berhenti di tanda kutip/backslash agar aman dijalankan pada teks JSON (chunker replay).
const PARAM_RE = new RegExp(`([?&#;])(${SENSITIVE_PARAMS})=([^&#\\s"\\\\]*)`, 'gi')
/** Pengecekan cepat tanpa flag g: apakah string kemungkinan memuat param sensitif. */
export const SENSITIVE_PARAM_HINT = new RegExp(`[?&#;](${SENSITIVE_PARAMS})=`, 'i')
const PATH_ID_RE = /\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4,})(?=\/|$)/gi

/** Meredaksi nilai query/fragment param sensitif di dalam string apa pun. */
export function redactQueryParams(input: string): string {
  return input.replace(PARAM_RE, '$1$2=[redacted]')
}

export function scrubUrl(url: string, opts: { maskUrlPathIds: boolean }): string {
  if (typeof url !== 'string' || url === '') return ''
  let out = redactQueryParams(url)
  if (opts.maskUrlPathIds) {
    const cut = out.search(/[?#]/)
    const pathPart = cut === -1 ? out : out.slice(0, cut)
    const rest = cut === -1 ? '' : out.slice(cut)
    out = pathPart.replace(PATH_ID_RE, '/:id') + rest
  }
  return out
}
