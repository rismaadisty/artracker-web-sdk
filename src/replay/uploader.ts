export type ChunkURLRequest = {
  session_id: string
  chunk_seq: number
  size_bytes: number
  user_id?: string
  environment?: string
  start_time?: string
}

export type ChunkURLResponse = {
  upload_url: string
  object_key: string
  expires_in: number
}

export type ChunkAckRequest = {
  session_id: string
  chunk_seq: number
  size_bytes: number
  duration_ms: number
  event_count: number
  has_error: boolean
  has_rage_click: boolean
  has_dead_click: boolean
}

export type ChunkAckResponse = {
  status: string
  session_id: string
  chunk_seq: number
  chunk_count: number
}

/**
 * Compresses a UTF-8 string into a GZIP byte array using browser-native CompressionStream.
 */
export async function gzipCompressString(content: string): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const bytes = enc.encode(content)

  if (typeof CompressionStream !== 'undefined') {
    try {
      const cs = new CompressionStream('gzip')
      const writer = cs.writable.getWriter()
      writer.write(bytes)
      writer.close()
      const buf = await new Response(cs.readable).arrayBuffer()
      return new Uint8Array(buf)
    } catch {
      // fallback to uncompressed bytes
    }
  }

  return bytes
}

export function resolveReplayBaseUrl(endpoint: string): string {
  // Strip trailing slashes and /ingest if present
  let clean = endpoint.trim().replace(/\/+$/, '')
  clean = clean.replace(/\/api\/v1\/ingest$/, '/api/v1')
  clean = clean.replace(/\/ingest$/, '')
  if (!clean.endsWith('/api/v1')) {
    clean = clean.replace(/\/api\/v1.*$/, '/api/v1')
  }
  return clean
}

/**
 * Requests a presigned PUT upload URL for an R2/S3 replay chunk from Artracker backend.
 */
export async function requestChunkUploadUrl(
  endpoint: string,
  apiKey: string,
  req: ChunkURLRequest,
  fetchFn: typeof fetch = fetch,
): Promise<ChunkURLResponse | null> {
  const base = resolveReplayBaseUrl(endpoint)
  const url = `${base}/replay/chunk-url`

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Artracker-Key': apiKey,
      },
      body: JSON.stringify(req),
    })

    if (!res.ok) {
      return null
    }

    return (await res.json()) as ChunkURLResponse
  } catch {
    return null
  }
}

/**
 * Directly uploads the GZIP-compressed replay chunk to Cloudflare R2 / S3 via presigned PUT.
 */
export async function uploadReplayChunkBinary(
  uploadUrl: string,
  gzippedData: Uint8Array,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/gzip',
      },
      body: gzippedData as unknown as BodyInit,
    })

    return res.ok || res.status === 200 || res.status === 204
  } catch {
    return false
  }
}

/**
 * Acknowledges a successfully stored chunk to update the replay session index and timeline markers.
 */
export async function acknowledgeReplayChunk(
  endpoint: string,
  apiKey: string,
  ack: ChunkAckRequest,
  fetchFn: typeof fetch = fetch,
): Promise<ChunkAckResponse | null> {
  const base = resolveReplayBaseUrl(endpoint)
  const url = `${base}/replay/chunk-ack`

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Artracker-Key': apiKey,
      },
      body: JSON.stringify(ack),
    })

    if (!res.ok) {
      return null
    }

    return (await res.json()) as ChunkAckResponse
  } catch {
    return null
  }
}
