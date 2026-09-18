import { EventEmitter } from 'node:events'
import * as workerThreads from 'node:worker_threads'
import { getEventHash } from 'nostr-tools/pure'
import { describe, expect, it, vi } from 'vitest'
import { leadingZeroBits, mineEvent, type UnsignedEvent } from '@agentbridge/core'

const base: UnsignedEvent = {
  pubkey: 'e9451985e285d64afb4594cf538593e53e9fedfbec8bdaec8e9399df40ea41b8',
  created_at: 1_700_000_000,
  kind: 1059,
  tags: [['p', 'a'.repeat(64)], ['expiration', '1700604800']],
  content: 'x'.repeat(4_000),
}

describe('mineEvent', () => {
  it('finds a nonce whose NIP-01 id has the requested leading zero bits, without touching the date or other tags', async () => {
    const mined = await mineEvent(base, 16)
    expect(mined.id).toBe(getEventHash(mined))
    expect(leadingZeroBits(mined.id)).toBeGreaterThanOrEqual(16)
    expect(mined.created_at).toBe(base.created_at)
    expect(mined.tags.slice(0, 2)).toEqual(base.tags)
    expect(mined.tags[2]).toEqual(['nonce', expect.stringMatching(/^\d+$/), '16'])
    expect(base.tags).toHaveLength(2)
  })

  it('mines 16 bits over a 4 KB event in well under ten seconds', async () => {
    const started = Date.now()
    await mineEvent(base, 16)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  // 32 bits never finishes in a test's lifetime on any machine, so this cannot pass or fail because
  // the machine is fast: a 5 ms interval must keep ticking while the mining promise is pending. Mining
  // on the calling thread would never return, and the test would time out.
  it('keeps the event loop responsive while mining', async () => {
    const controller = new AbortController()
    const mining = mineEvent(base, 32, { signal: controller.signal })
    let ticks = 0
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (++ticks < 5) return
        clearInterval(timer)
        resolve()
      }, 5)
    })
    controller.abort()
    await expect(mining).rejects.toThrow(/aborted/)
    expect(ticks).toBe(5)
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    const mining = mineEvent(base, 32, { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await expect(mining).rejects.toThrow(/aborted/)
  })

  it('rejects when the worker exits without an answer', { timeout: 2_000 }, async () => {
    class ExitingWorker extends EventEmitter {
      constructor() {
        super()
        setImmediate(() => this.emit('exit', 1))
      }
      terminate() {
        return Promise.resolve(1)
      }
    }
    vi.resetModules()
    vi.doMock('node:worker_threads', () => ({ Worker: ExitingWorker }))
    try {
      const { mineEvent: mineWithExitingWorker } = await import('../src/envelope/pow')
      await expect(mineWithExitingWorker(base, 8)).rejects.toThrow('mining worker exited')
    } finally {
      vi.doUnmock('node:worker_threads')
      vi.resetModules()
    }
  })

  it('rejects impossible difficulties', () => {
    expect(() => mineEvent(base, 33)).toThrow(RangeError)
    expect(() => mineEvent(base, -1)).toThrow(RangeError)
  })
})

describe('mineEvent across several workers', () => {
  const event = { pubkey: 'a'.repeat(64), created_at: 1_700_000_000, kind: 1059, tags: [] as string[][], content: 'x' }

  it('finds a nonce with several workers and keeps the result verifiable', async () => {
    const mined = await mineEvent(event, 12, { workers: 3 })
    expect(leadingZeroBits(mined.id)).toBeGreaterThanOrEqual(12)
    const nonceTag = mined.tags.find((t) => t[0] === 'nonce')
    expect(nonceTag?.[2]).toBe('12')
    expect(Number(nonceTag?.[1])).toBeGreaterThanOrEqual(0)
  })

  it('splits the nonce space, so the workers never try the same nonce twice', async () => {
    // With one worker per lane and a stride equal to the lane count, lane k only ever tries nonces
    // congruent to k. Two runs of the same event with different lane counts must both be valid.
    const a = await mineEvent(event, 10, { workers: 1 })
    const b = await mineEvent(event, 10, { workers: 4 })
    expect(leadingZeroBits(a.id)).toBeGreaterThanOrEqual(10)
    expect(leadingZeroBits(b.id)).toBeGreaterThanOrEqual(10)
  })

  it('stops every worker when the caller aborts', async () => {
    const controller = new AbortController()
    const mining = mineEvent(event, 32, { workers: 4, signal: controller.signal })
    controller.abort()
    await expect(mining).rejects.toThrow('mining aborted')
  })

  it('refuses a worker count that is not a positive integer', async () => {
    await expect(mineEvent(event, 8, { workers: 0 })).rejects.toThrow(RangeError)
    await expect(mineEvent(event, 8, { workers: 2.5 })).rejects.toThrow(RangeError)
  })

  it('terminates the lanes it already created when one fails to start', async () => {
    // A worker allocation can fail (a process at its thread limit). Inject that on the second lane.
    let created = 0
    const terminated: number[] = []
    vi.resetModules()
    vi.doMock('node:worker_threads', async () => {
      const actual = await vi.importActual<typeof workerThreads>('node:worker_threads')
      class FailingWorker extends actual.Worker {
        constructor(...args: ConstructorParameters<typeof actual.Worker>) {
          created += 1
          if (created === 2) throw new Error('simulated worker allocation failure')
          super(...args)
        }
        override terminate(): Promise<number> {
          terminated.push(created)
          return super.terminate()
        }
      }
      return { ...actual, Worker: FailingWorker }
    })
    try {
      const { mineEvent: mineWithFailingWorker } = await import('../src/envelope/pow')
      await expect(mineWithFailingWorker(event, 20, { workers: 3 })).rejects.toThrow('simulated worker allocation failure')
      expect(terminated.length).toBeGreaterThanOrEqual(1)
    } finally {
      vi.doUnmock('node:worker_threads')
      vi.resetModules()
    }
  })
})
