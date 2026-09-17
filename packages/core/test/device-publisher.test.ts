import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NostrEvent } from 'nostr-tools/pure'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardPool,
  NOSTR,
  SeenIds,
  createRumor,
  enqueue,
  nowSeconds,
  openStore,
  openWrap,
  precheckWrap,
  publishDue,
  type Store,
} from '@agentbridge/core'
import { plainSocketFactory, startFakeBoard, type FakeBoard, type FakeBoardOptions } from './support/fake-board'
import { testIdentity } from './support/keys'

const me = testIdentity(81)
const asker = testIdentity(82)
const uuid = (k: number) => `00000000-0000-4000-8000-${k.toString(16).padStart(12, '0')}`
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function setup(boardOptions: FakeBoardOptions[] = [{}, {}]) {
  const boards: FakeBoard[] = []
  for (const options of boardOptions) boards.push(await startFakeBoard(options))
  const store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-publisher-')), 'home'), {
    relayPolicy: (inputs) => inputs.filter((x): x is string => typeof x === 'string'),
  })
  const pool = new BoardPool({ identity: me, createSocket: plainSocketFactory, timeoutMs: 2_000 })
  cleanups.push(...boards.map((b) => () => b.close()), () => store.close(), () => pool.close())
  const now = nowSeconds()
  const rumor = createRumor({ v: 1, type: 'receipt', questionId: uuid(1) }, me, now)
  enqueue(store, { recipient: asker.publicKey, rumor, label: 'receipt', powBits: 16, relays: boards.map((b) => b.url), policy: 'once', now })
  return { boards, store, pool, rumor, now }
}

const allowAll = () => true
const row = (store: Store) =>
  store.db.prepare('SELECT state, attempts, next_attempt_at, claimed_by FROM outbox').get() as {
    state: string
    attempts: number
    next_attempt_at: number
    claimed_by: string | null
  }

function openAsAsker(event: NostrEvent) {
  const now = nowSeconds()
  const seen = new SeenIds()
  const pre = precheckWrap(JSON.parse(JSON.stringify(event)), { identity: asker, now, seen })
  if (!pre.ok) throw new Error(`precheck failed: ${pre.stage}`)
  const opened = openWrap(pre, { identity: asker, now, seen })
  if (!opened.ok) throw new Error(`open failed: ${opened.stage}`)
  return opened
}

describe('publishDue', () => {
  it('publishes a due row to every relay and marks it published', async () => {
    const { boards, store, pool, rumor } = await setup()
    expect(await publishDue({ store, identity: me, pool, authorize: allowAll })).toEqual({ published: 1, failed: 0, postponed: 0, lost: 0 })
    for (const board of boards) {
      expect(board.events).toHaveLength(1)
      expect(openAsAsker(board.events[0]!).rumor.id).toBe(rumor.id)
    }
    expect(row(store)).toMatchObject({ state: 'published', claimed_by: null })
    expect(store.db.prepare('SELECT count(*) AS n FROM publish_log').get()?.n).toBe(1)
  })

  it('takes one publishing slot per message even when every relay first asks for authentication', async () => {
    const { store, pool } = await setup([{ requireAuthToWrite: true }, { requireAuthToWrite: true }])
    expect((await publishDue({ store, identity: me, pool, authorize: allowAll })).published).toBe(1)
    expect(store.db.prepare('SELECT count(*) AS n FROM publish_log').get()?.n).toBe(1)
  })

  it('postpones a minute without writing anything when the per-minute budget is spent', async () => {
    const { boards, store, pool, now } = await setup()
    const insert = store.db.prepare('INSERT INTO publish_log (at) VALUES (?)')
    for (let i = 0; i < NOSTR.maxPublishesPerMinute; i++) insert.run(now)
    const report = await publishDue({ store, identity: me, pool, authorize: allowAll, now: () => now })
    expect(report).toEqual({ published: 0, failed: 0, postponed: 1, lost: 0 })
    expect(row(store)).toMatchObject({ state: 'pending', next_attempt_at: now + 60, claimed_by: null })
    for (const board of boards) expect(board.frames.filter((f) => f[0] === 'EVENT')).toHaveLength(0)
  })

  it('records a failure when no relay accepts the wrap', async () => {
    const { store, pool } = await setup([{ maxFrameBytes: 300 }])
    expect(await publishDue({ store, identity: me, pool, authorize: allowAll })).toEqual({ published: 0, failed: 1, postponed: 0, lost: 0 })
    expect(row(store)).toMatchObject({ state: 'pending', attempts: 1, claimed_by: null })
  })

  it('abandons what authorization refuses, without mining or connecting', async () => {
    const { boards, store, pool } = await setup()
    expect(await publishDue({ store, identity: me, pool, authorize: () => false })).toEqual({ published: 0, failed: 0, postponed: 0, lost: 0 })
    expect(row(store).state).toBe('abandoned')
    for (const board of boards) expect(board.frames).toHaveLength(0)
  })

  it('authorizes with the store rules by default', async () => {
    const { store, pool } = await setup()
    await publishDue({ store, identity: me, pool })
    expect(row(store).state).toBe('abandoned')
  })

  it('keeps going past a row it had to abandon', async () => {
    const { boards, store, pool, now } = await setup()
    const revoked = createRumor({ v: 1, type: 'connect_revoked', generation: 2 }, me, now)
    enqueue(store, { recipient: asker.publicKey, rumor: revoked, label: 'connect_revoked', powBits: 16, relays: boards.map((b) => b.url), policy: 'once', now })
    expect(await publishDue({ store, identity: me, pool })).toEqual({ published: 1, failed: 0, postponed: 0, lost: 0 })
    expect(store.db.prepare('SELECT label, state FROM outbox ORDER BY rowid').all()).toEqual([
      { label: 'receipt', state: 'abandoned' },
      { label: 'connect_revoked', state: 'published' },
    ])
  })

  it('writes nothing once the deadline passed while it was connecting', async () => {
    const { store, now } = await setup()
    const controller = new AbortController()
    // A pool that reaches the write only after the deadline has passed.
    const lateWriter = {
      publish: async (relays: readonly string[], _event: NostrEvent, beforeSend: () => boolean) => {
        controller.abort()
        return beforeSend() ? { accepted: [...relays], rejected: [] } : { accepted: [], rejected: relays.map((relay) => ({ relay, reason: 'error: publish guard refused' })) }
      },
    } as unknown as BoardPool
    const report = await publishDue({ store, identity: me, pool: lateWriter, authorize: allowAll, signal: controller.signal, now: () => now })
    expect(report).toEqual({ published: 0, failed: 0, postponed: 1, lost: 0 })
    expect(store.db.prepare('SELECT count(*) AS n FROM publish_log').get()?.n).toBe(0)
    expect(row(store)).toMatchObject({ state: 'pending', next_attempt_at: now, claimed_by: null })
  })

  it('does nothing once aborted', async () => {
    const { boards, store, pool } = await setup()
    const controller = new AbortController()
    controller.abort()
    expect(await publishDue({ store, identity: me, pool, authorize: allowAll, signal: controller.signal })).toEqual({ published: 0, failed: 0, postponed: 0, lost: 0 })
    expect(row(store).state).toBe('pending')
    for (const board of boards) expect(board.frames).toHaveLength(0)
  })
})
