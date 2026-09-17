import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardPool, NOSTR, type PoolOptions } from '@agentbridge/core'
import { plainSocketFactory, startFakeBoard, type FakeBoard, type FakeBoardOptions } from './support/fake-board'
import { testIdentity } from './support/keys'

const me = testIdentity(7)
const stranger = testIdentity(8)
const NOW = 10_000_000
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function board(options: FakeBoardOptions = {}): Promise<FakeBoard> {
  const b = await startFakeBoard(options)
  cleanups.push(() => b.close())
  return b
}

function pool(extra: Partial<PoolOptions> = {}): BoardPool {
  const p = new BoardPool({ identity: me, createSocket: plainSocketFactory, timeoutMs: 2_000, now: () => NOW, reconnectDelaysMs: [20], ...extra })
  cleanups.push(() => p.close())
  return p
}

const signed = (content: string): NostrEvent =>
  finalizeEvent({ kind: 1059, created_at: NOW, tags: [['p', me.publicKey]], content }, stranger.secretKey)

const fake = (n: number): NostrEvent => ({
  id: n.toString(16).padStart(64, '0'),
  pubkey: 'c'.repeat(64),
  created_at: NOW,
  kind: 1059,
  tags: [['p', me.publicKey]],
  content: String(n),
  sig: 'd'.repeat(128),
})

const until = async (check: () => boolean, tries = 500) => {
  for (let i = 0; i < tries && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}
const reqCount = (b: FakeBoard) => b.frames.filter((f) => f[0] === 'REQ').length

describe('BoardPool.publish', () => {
  it('reports each relay separately and never throws', async () => {
    const good = await board()
    const strict = await board({ maxFrameBytes: 300 })
    const outcome = await pool().publish([good.url, strict.url, 'ws://127.0.0.1:1'], signed('x'.repeat(400)))
    expect(outcome.accepted).toEqual([good.url])
    expect(outcome.rejected).toEqual(
      expect.arrayContaining([
        { relay: strict.url, reason: 'invalid: event too large' },
        { relay: 'ws://127.0.0.1:1', reason: expect.stringMatching(/^error: /) },
      ]),
    )
  })

  it('asks the guard before writing to each relay and sends nothing it refuses', async () => {
    const first = await board()
    const second = await board()
    let asked = 0
    const outcome = await pool().publish([first.url, second.url], signed('vetado'), () => {
      asked++
      return false
    })
    expect(asked).toBe(2)
    expect(outcome.accepted).toEqual([])
    expect(outcome.rejected.map((r) => r.reason)).toEqual(['error: publish guard refused', 'error: publish guard refused'])
    expect(first.events).toHaveLength(0)
    expect(second.events).toHaveLength(0)
  })

  it('publishes to at most five distinct relays', async () => {
    const boards = await Promise.all(Array.from({ length: 6 }, () => board()))
    const urls = boards.map((b) => b.url)
    const outcome = await pool().publish([urls[0]!, ...urls], signed('hola'))
    expect(outcome.accepted).toHaveLength(5)
    expect(boards[5]!.events).toHaveLength(0)
  })
})

describe('BoardPool.query', () => {
  it('returns stored events once EOSE arrives', async () => {
    const b = await board()
    b.inject(fake(1))
    expect(await pool().query(b.url, { kinds: [1059] })).toEqual({ events: [fake(1)], complete: true, closedReason: null })
  })

  it('is incomplete when the relay closes the query, never answers, or cannot be reached', async () => {
    const closing = await board({ rejectReads: true })
    const silent = await board({ ignoreReads: true })
    const p = pool()
    expect(await p.query(closing.url, {})).toMatchObject({ complete: false, closedReason: 'restricted: reads are disabled' })
    expect(await p.query(silent.url, {}, 200)).toMatchObject({ complete: false, closedReason: 'error: timed out waiting for EOSE' })
    expect(await p.query('ws://127.0.0.1:1', {})).toMatchObject({ complete: false, closedReason: expect.stringMatching(/^error: /) })
  })
})

describe('BoardPool.subscribeLive', () => {
  it('subscribes from two days and ten minutes back and processes prechecked items in order', async () => {
    const b = await board()
    const processed: string[] = []
    const live = pool().subscribeLive<NostrEvent>([b.url], {
      precheck: (raw) => ((raw as NostrEvent).content === 'skip' ? null : (raw as NostrEvent)),
      process: async (e) => {
        processed.push(e.content)
      },
    })
    await until(() => reqCount(b) === 1)
    expect(b.frames.find((f) => f[0] === 'REQ')![2]).toEqual({ kinds: [1059], '#p': [me.publicKey], since: NOW - NOSTR.liveSinceSeconds })
    b.inject(fake(1))
    b.inject({ ...fake(2), content: 'skip' })
    b.inject(fake(3))
    await until(() => processed.length === 2)
    expect(processed).toEqual(['1', '3'])
    await live.close()
  })

  it('holds a flood at the queue limit without losing anything', async () => {
    const b = await board()
    const waiting: boolean[] = []
    let processed = 0
    const total = NOSTR.receiveQueueMax * 2 + 50
    const live = pool({ onPressure: (_relay, w) => waiting.push(w) }).subscribeLive<NostrEvent>([b.url], {
      precheck: (raw) => raw as NostrEvent,
      process: async () => {
        await new Promise((r) => setTimeout(r, 2))
        processed++
      },
    })
    await until(() => reqCount(b) === 1)
    for (let n = 1; n <= total; n++) b.inject(fake(n))
    await until(() => processed === total, 3_000)
    expect(waiting).toContain(true)
    expect(waiting.at(-1)).toBe(false)
    await live.close()
  })

  it('reconnects after the relay drops the connection', async () => {
    const b = await board()
    const processed: string[] = []
    const live = pool().subscribeLive<NostrEvent>([b.url], {
      precheck: (raw) => raw as NostrEvent,
      process: async (e) => {
        processed.push(e.content)
      },
    })
    await until(() => reqCount(b) === 1)
    b.disconnectAll()
    await until(() => reqCount(b) === 2)
    b.inject(fake(9))
    await until(() => processed.includes('9'))
    await live.close()
  })

  it('stops reconnecting once the subscription is closed', async () => {
    const b = await board()
    const live = pool().subscribeLive<NostrEvent>([b.url], { precheck: () => null, process: async () => {} })
    await until(() => reqCount(b) === 1)
    await live.close()
    b.disconnectAll()
    await new Promise((r) => setTimeout(r, 200))
    expect(reqCount(b)).toBe(1)
  })

  it('closes its live subscriptions when the pool itself is closed', async () => {
    const b = await board()
    const p = pool()
    p.subscribeLive<NostrEvent>([b.url], { precheck: () => null, process: async () => {} })
    await until(() => reqCount(b) === 1)
    await p.close()
    await new Promise((r) => setTimeout(r, 200))
    expect(reqCount(b)).toBe(1)
  })
})
