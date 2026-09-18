import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import { getPow } from 'nostr-tools/nip13'

export type UnsignedEvent = { pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }
export type MinedEvent = UnsignedEvent & { id: string }

export const leadingZeroBits = (hexId: string): number => getPow(hexId)

// One worker is left for everything else, so a laptop stays usable while a connection request mines,
// and the cap keeps the memory of four extra V8 isolates bounded on a many-core machine.
export const defaultMiningWorkers = (): number => Math.max(1, Math.min(availableParallelism() - 1, 4))

// Inline CommonJS source so the worker survives esbuild's single-file bundles (a separate worker
// file would not be copied into dist). Serialization matches NIP-01 exactly, and created_at is
// never changed: NIP-59 wraps carry a deliberately randomized past date.
//
// Each worker walks its own lane of the nonce space: worker `start` of `stride` tries
// start, start + stride, start + 2 * stride, … so no two workers ever hash the same candidate.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { createHash } = require('node:crypto')
const { event, bits, start, stride } = workerData
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
for (let i = start; ; i += stride) {
  nonce[1] = String(i)
  const hash = createHash('sha256').update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, tags, event.content])).digest()
  if (zeros(hash) >= bits) {
    parentPort.postMessage({ nonce: nonce[1], id: hash.toString('hex') })
    break
  }
}
`

export function mineEvent(event: UnsignedEvent, bits: number, options: { signal?: AbortSignal; workers?: number } = {}): Promise<MinedEvent> {
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new RangeError('bits must be an integer from 0 to 32')
  return new Promise((resolve, reject) => {
    const lanes = options.workers ?? defaultMiningWorkers()
    if (!Number.isInteger(lanes) || lanes < 1) {
      reject(new RangeError('workers must be a positive integer'))
      return
    }
    if (options.signal?.aborted) {
      reject(new Error('mining aborted'))
      return
    }
    const workers: Worker[] = []
    let settled = false
    // Every exit goes through `settle`, including a failure to *create* a worker: a throw from
    // `new Worker` would otherwise reject this promise directly, leaving the lanes already created
    // mining forever and the abort listener attached. Terminating every worker is what makes an
    // abort real (a losing lane is in a tight synchronous loop), and waiting for those terminations
    // before settling keeps a losing lane from burning a core into the caller's next operation.
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      void Promise.allSettled(workers.map((worker) => worker.terminate())).then(fn)
    }
    const onAbort = () => settle(() => reject(new Error('mining aborted')))
    options.signal?.addEventListener('abort', onAbort, { once: true })

    let exited = 0
    try {
      for (let lane = 0; lane < lanes; lane++) {
        const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { event, bits, start: lane, stride: lanes } })
        workers.push(worker)
        worker.once('message', (m: { nonce: string; id: string }) =>
          settle(() => resolve({ ...event, tags: [...event.tags, ['nonce', m.nonce, String(bits)]], id: m.id })),
        )
        worker.once('error', (err) => settle(() => reject(err)))
        // A worker that ends without posting a nonce (killed, or exited from inside) is only fatal
        // when it was the last one still searching: while another lane is alive the search goes on.
        // After a message or an error, `settle` makes this a no-op anyway.
        worker.once('exit', () => {
          exited += 1
          if (exited === workers.length) settle(() => reject(new Error('mining worker exited')))
        })
      }
    } catch (err) {
      settle(() => reject(err))
    }
  })
}
