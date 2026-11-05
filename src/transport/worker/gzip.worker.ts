/**
 * Isi worker. HARUS self-contained: fungsi ini diserialisasi lewat toString() menjadi Blob URL,
 * sehingga tidak boleh merujuk import atau variabel di luar tubuhnya.
 */
export function gzipWorkerMain(): void {
  const ctx = self as unknown as {
    onmessage: ((e: { data: { id: number; json: string } }) => void) | null
    postMessage(msg: unknown, transfer?: unknown[]): void
  }
  ctx.onmessage = async (e) => {
    const { id, json } = e.data
    try {
      const cs = new CompressionStream('gzip')
      const w = cs.writable.getWriter()
      void w.write(new TextEncoder().encode(json))
      void w.close()
      const buf = await new Response(cs.readable).arrayBuffer()
      ctx.postMessage({ id, buf }, [buf])
    } catch (err) {
      ctx.postMessage({ id, error: String(err) })
    }
  }
}

export function workerSource(): string {
  return `(${gzipWorkerMain.toString()})()`
}
