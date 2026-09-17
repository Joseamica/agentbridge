import { Worker } from 'node:worker_threads'
import { getPow } from 'nostr-tools/nip13'

export type UnsignedEvent = { pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }
export type MinedEvent = UnsignedEvent & { id: string }

export const leadingZeroBits = (hexId: string): number => getPow(hexId)

// Inline CommonJS source so the worker survives esbuild's single-file bundles (a separate worker
// file would not be copied into dist). Serialization matches NIP-01 exactly, and created_at is
// never changed: NIP-59 wraps carry a deliberately randomized past date.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { createHash } = require('node:crypto')
const { event, bits } = workerData
const nonce = ['nonce', '0', String(bits)]
const tags = [...event.tags, nonce]
const zeros = (buf) => {
  let n = 0
  for (const byte of buf) {
    if (byte === 0) { n += 8; continue }
    return n + Math.clz32(byte) - 24
  }
  return n
}
for (let i = 0; ; i++) {
  nonce[1] = String(i)
  const hash = createHash('sha256').update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, tags, event.content])).digest()
  if (zeros(hash) >= bits) {
    parentPort.postMessage({ nonce: nonce[1], id: hash.toString('hex') })
    break
  }
}
`

export function mineEvent(event: UnsignedEvent, bits: number, options: { signal?: AbortSignal } = {}): Promise<MinedEvent> {
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new RangeError('bits must be an integer from 0 to 32')
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('mining aborted'))
      return
    }
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { event, bits } })
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      fn()
    }
    const onAbort = () => settle(() => reject(new Error('mining aborted')))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    worker.once('message', (m: { nonce: string; id: string }) =>
      settle(() => resolve({ ...event, tags: [...event.tags, ['nonce', m.nonce, String(bits)]], id: m.id })),
    )
    worker.once('error', (err) => settle(() => reject(err)))
    // A worker that ends without posting a nonce (killed, or exited from inside) would otherwise
    // leave this promise pending forever. After a message or an error, `settle` makes this a no-op.
    worker.once('exit', () => settle(() => reject(new Error('mining worker exited'))))
  })
}
