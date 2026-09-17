import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardPool, NOSTR, type PoolOptions } from '@agentbridge/core'
import { sanitizeRelayText } from '../src/boards/pool'
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
    // 1_500 tries * 10ms = 15s, safely under the 20s test timeout (3_000 tries would poll for up
    // to 30s).
    await until(() => processed === total, 1_500)
    expect(waiting).toContain(true)
    expect(waiting.at(-1)).toBe(false)
    await live.close()
  })

  it('close() finishes every event already accepted while producers wait on a full queue', async () => {
    const b = await board()
    const waiting: boolean[] = []
    const processed: number[] = []
    let accepted = 0
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    let heldFirst = false
    const live = pool({ onPressure: (_relay, w) => waiting.push(w) }).subscribeLive<NostrEvent>([b.url], {
      precheck: (raw) => {
        accepted++
        return raw as NostrEvent
      },
      process: async (e) => {
        if (!heldFirst) {
          heldFirst = true
          await firstGate
        }
        processed.push(Number(e.content))
      },
    })
    await until(() => reqCount(b) === 1)
    const total = NOSTR.receiveQueueMax + 20
    for (let n = 1; n <= total; n++) b.inject(fake(n))
    await until(() => waiting.includes(true))
    const closing = live.close()
    releaseFirst()
    await closing
    expect(processed).toHaveLength(accepted)
    expect(new Set(processed).size).toBe(accepted)
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

  // Ruling 13: each reconnect cycle used to attach a new .then() reaction to a `stop` promise
  // that never settled until close(), retaining roughly 460 B per cycle for as long as the
  // subscription kept reconnecting. A direct leak assertion is impractical here, so this test
  // instead makes many reconnect cycles happen quickly and checks that close() still resolves
  // cleanly afterwards — the structural fix (per-cycle stoppers, removed in a finally) does not
  // need this test to fail before the fix; it is a regression guard, not a repro.
  it('does not pile up retained reactions across many reconnect cycles', async () => {
    const b = await board({ rejectReads: true })
    const live = pool({ reconnectDelaysMs: [5] }).subscribeLive<NostrEvent>([b.url], {
      precheck: () => null,
      process: async () => {},
    })
    await until(() => reqCount(b) >= 20)
    await expect(live.close()).resolves.toBeUndefined()
  })

  it('keeps backing off when a relay ends the subscription right after EOSE', async () => {
    const b = await board()
    const live = pool({ reconnectDelaysMs: [20, 400] }).subscribeLive<NostrEvent>([b.url], {
      precheck: () => null,
      process: async () => {},
    })
    await until(() => reqCount(b) === 1)
    // The fake board sends EOSE right after REQ; give it a moment to arrive and be recorded.
    await new Promise((r) => setTimeout(r, 20))
    b.disconnectAll()
    await until(() => reqCount(b) === 2)
    // Disconnecting again this soon after EOSE means the subscription never stayed open for
    // STABLE_SUBSCRIPTION_MS, so the backoff must keep escalating to delays[1] (400ms), not reset
    // to delays[0] (20ms).
    b.disconnectAll()
    await new Promise((r) => setTimeout(r, 150))
    expect(reqCount(b)).toBe(2)
    await until(() => reqCount(b) === 3)
    await live.close()
  })

  it('treats an empty reconnect delay list as the default schedule', async () => {
    const b = await board({ rejectReads: true })
    const live = pool({ reconnectDelaysMs: [] }).subscribeLive<NostrEvent>([b.url], {
      precheck: () => null,
      process: async () => {},
    })
    await new Promise((r) => setTimeout(r, 300))
    expect(reqCount(b)).toBeLessThanOrEqual(2)
    await live.close()
  })
})

describe('sanitizeRelayText', () => {
  it('caps length at 200 characters and strips control characters', () => {
    expect(sanitizeRelayText('a'.repeat(250))).toBe('a'.repeat(200))
    expect(sanitizeRelayText('bad\x00\x01\x1f\x7fname')).toBe('bad    name')
  })

  it('bounds the CLOSED reason before it reaches the pool log', async () => {
    const b = await board({ rejectReads: true })
    const lines: string[] = []
    const live = pool({ log: (line) => lines.push(line) }).subscribeLive<NostrEvent>([b.url], {
      precheck: () => null,
      process: async () => {},
    })
    await until(() => lines.some((l) => l.includes('restricted: reads are disabled')))
    await live.close()
  })
})
