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
  type Identity,
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

  // Task 5: the deadline decides whether to *start* another row, not whether to throw away one
  // already claimed and mined. This row is already mined and claimed by the time the deadline
  // passes (simulated here as the pool reaching the write only after `controller.abort()`), so the
  // write still goes through — otherwise a connection request that costs seconds of mining would be
  // discarded and re-mined on every command.
  it('still writes a row it already mined even though the deadline passed while it was connecting', async () => {
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
    expect(report).toEqual({ published: 1, failed: 0, postponed: 0, lost: 0 })
    expect(store.db.prepare('SELECT count(*) AS n FROM publish_log').get()?.n).toBe(1)
    expect(row(store)).toMatchObject({ state: 'published', claimed_by: null })
  })

  it('does nothing once aborted', async () => {
    const { boards, store, pool } = await setup()
    const controller = new AbortController()
    controller.abort()
    expect(await publishDue({ store, identity: me, pool, authorize: allowAll, signal: controller.signal })).toEqual({ published: 0, failed: 0, postponed: 0, lost: 0 })
    expect(row(store).state).toBe('pending')
    for (const board of boards) expect(board.frames).toHaveLength(0)
  })

  it('counts a claim stolen right before the bookkeeping as lost, not published', async () => {
    const { store, now } = await setup()
    // A pool whose relay accepts the write, but the row's claim is stolen (another owner takes it)
    // in the gap between the accepted write and publishDue's own markPublished call.
    const thief = {
      publish: async (relays: readonly string[], _event: NostrEvent, beforeSend: () => boolean) => {
        const ok = beforeSend()
        store.db.prepare("UPDATE outbox SET claimed_by = 'thief' WHERE recipient = ?").run(asker.publicKey)
        return ok ? { accepted: [...relays], rejected: [] } : { accepted: [], rejected: relays.map((relay) => ({ relay, reason: 'error: publish guard refused' })) }
      },
    } as unknown as BoardPool
    const report = await publishDue({ store, identity: me, pool: thief, authorize: allowAll, now: () => now })
    expect(report).toEqual({ published: 0, failed: 0, postponed: 0, lost: 1 })
    expect(row(store).state).toBe('pending')
  })

  it('counts every relay refusing after a lapsed claim as lost, not failed', async () => {
    const { store, now } = await setup()
    // The first beforeSend call reserves a publish slot; the claim is then stolen, so every later
    // recheck (this or another relay) refuses the write, and nobody ever accepts it.
    const stolenMidSend = {
      publish: async (relays: readonly string[], _event: NostrEvent, beforeSend: () => boolean) => {
        expect(beforeSend()).toBe(true)
        store.db.prepare("UPDATE outbox SET claimed_by = 'thief' WHERE recipient = ?").run(asker.publicKey)
        expect(beforeSend()).toBe(false)
        return { accepted: [], rejected: relays.map((relay) => ({ relay, reason: 'error: no OK from relay' })) }
      },
    } as unknown as BoardPool
    const report = await publishDue({ store, identity: me, pool: stolenMidSend, authorize: allowAll, now: () => now })
    expect(report).toEqual({ published: 0, failed: 0, postponed: 0, lost: 1 })
  })

  it('logs a seal failure with the error’s type and code, never its message', async () => {
    const { store, pool } = await setup()
    const boom = Object.assign(new Error('secret store failed near PRIVATE_CANARY'), { code: 'ERR_KEY_LOCKED' })
    const trap: Identity = {
      publicKey: me.publicKey,
      get secretKey(): Uint8Array {
        throw boom
      },
    }
    const lines: string[] = []
    const report = await publishDue({ store, identity: trap, pool, authorize: allowAll, log: (line) => lines.push(line) })
    expect(report).toEqual({ published: 0, failed: 1, postponed: 0, lost: 0 })
    const sealLine = lines.find((line) => line.includes('could not seal'))
    expect(sealLine).toContain('Error (ERR_KEY_LOCKED)')
    expect(lines.some((line) => line.includes('PRIVATE_CANARY'))).toBe(false)
  })

  // Task 5: proof of work is CPU, not network, so it gets its own budget (`miningMs`) separate from
  // the sync's own deadline (`signal`). `setup()`'s default receipt row is cleared first so this test
  // controls exactly the one row it seeds. (The complementary rule — a row already mined and claimed
  // is still published even after the sync's own deadline expires — is covered above by "still writes
  // a row it already mined even though the deadline passed while it was connecting"; a second version
  // of it here would only add the cost of another real 22-bit mine without proving anything new.)
  describe('mining budget', () => {
    it('leaves a row pending when mining runs past its own budget', async () => {
      // A 1 ms budget cannot finish (spinning up even one mining worker already costs more than
      // that): the row is postponed, not failed, and stays pending for the next round.
      const { store, pool, now } = await setup([{}])
      store.db.exec('DELETE FROM outbox')
      const rumor = createRumor({ v: 1, type: 'connect_request', requestId: uuid(70), name: 'Ana', note: '', relays: ['wss://relay.example.com'] }, me, now)
      enqueue(store, { recipient: asker.publicKey, rumor, label: 'connect_request', powBits: 22, relays: ['wss://relay.example.com'], policy: 'once', now })
      // limit: 1 bounds this to a single round — with a fixed `now`, a postponed row's retryAt
      // equals `now` too, so it would otherwise be reclaimed and postponed again on every round.
      const report = await publishDue({ store, identity: me, pool, authorize: allowAll, now: () => now, miningMs: 1, limit: 1 })
      expect(report.published).toBe(0)
      expect(report.postponed).toBe(1)
      expect(report.failed).toBe(0)
      expect(row(store)).toMatchObject({ state: 'pending' })
    })
  })

  it('logs an abandoned row without leaking the thrown error message', async () => {
    const { store, pool } = await setup()
    const lines: string[] = []
    const boom = new Error('crashed while reading PRIVATE_CANARY')
    const report = await publishDue({
      store,
      identity: me,
      pool,
      authorize: () => {
        throw boom
      },
      log: (line) => lines.push(line),
    })
    expect(report).toEqual({ published: 0, failed: 0, postponed: 0, lost: 0 })
    expect(row(store).state).toBe('abandoned')
    const abandonLine = lines.find((line) => line.includes('abandoned'))
    expect(abandonLine).toContain('receipt')
    expect(abandonLine).toContain('Error')
    expect(lines.some((line) => line.includes('PRIVATE_CANARY'))).toBe(false)
  })
})
