import { EventEmitter } from 'node:events'
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
