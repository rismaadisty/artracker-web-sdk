import { describe, expect, it, vi } from 'vitest'
import {
  acknowledgeReplayChunk,
  requestChunkUploadUrl,
  resolveReplayBaseUrl,
  uploadReplayChunkBinary,
} from '../uploader'

describe('Replay Uploader', () => {
  it('correctly resolves replay base url from different endpoint variants', () => {
    expect(resolveReplayBaseUrl('https://api.artracker.com/api/v1/ingest')).toBe('https://api.artracker.com/api/v1')
    expect(resolveReplayBaseUrl('http://localhost:8081/api/v1/ingest/')).toBe('http://localhost:8081/api/v1')
    expect(resolveReplayBaseUrl('http://localhost:8081/api/v1')).toBe('http://localhost:8081/api/v1')
  })

  it('requests chunk upload url successfully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        upload_url: 'https://r2.storage.com/chunk_001',
        object_key: 'chunk_001.json.gz',
        expires_in: 300,
      }),
    })

    const res = await requestChunkUploadUrl(
      'http://localhost:8081/api/v1/ingest',
      'art_live_testkey123',
      {
        session_id: 'sess_123',
        chunk_seq: 0,
        size_bytes: 1024,
      },
      mockFetch as unknown as typeof fetch,
    )

    expect(res).not.toBeNull()
    expect(res?.upload_url).toBe('https://r2.storage.com/chunk_001')
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8081/api/v1/replay/chunk-url',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Artracker-Key': 'art_live_testkey123',
        }),
      }),
    )
  })

  it('uploads binary to presigned url via PUT', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    })

    const payload = new Uint8Array([1, 2, 3, 4])
    const ok = await uploadReplayChunkBinary('https://r2.storage.com/chunk_001', payload, mockFetch as unknown as typeof fetch)

    expect(ok).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://r2.storage.com/chunk_001',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/gzip' },
      }),
    )
  })

  it('acknowledges chunk to backend with frustration & error flags', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'acknowledged',
        session_id: 'sess_123',
        chunk_seq: 0,
        chunk_count: 1,
      }),
    })

    const res = await acknowledgeReplayChunk(
      'http://localhost:8081/api/v1/ingest',
      'art_live_testkey123',
      {
        session_id: 'sess_123',
        chunk_seq: 0,
        size_bytes: 1024,
        duration_ms: 5000,
        event_count: 35,
        has_error: true,
        has_rage_click: true,
        has_dead_click: false,
      },
      mockFetch as unknown as typeof fetch,
    )

    expect(res).not.toBeNull()
    expect(res?.status).toBe('acknowledged')
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8081/api/v1/replay/chunk-ack',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"has_rage_click":true'),
      }),
    )
  })
})
