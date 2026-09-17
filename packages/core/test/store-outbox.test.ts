import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  NOSTR,
  claimDue,
  deleteUnclaimedFor,
  enqueue,
  hasDueOutbox,
  markFailed,
  markPublished,
  openStore,
  postpone,
  purgeOutbox,
  renewClaim,
  reservePublish,
  resolveOutboxMessage,
  stillClaimed,
  type EnqueueInput,
  type Store,
} from '@agentbridge/core'

const hex = (n: number) => n.toString(16).padStart(64, '0')
const RECIPIENT = hex(0xabc)
const OTHER = hex(0xdef)
const T0 = 2_000_000_000
const allow = () => true
let store: Store

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-outbox-')), 'home'))
})

function input(n: number, overrides: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    recipient: RECIPIENT,
    rumor: { id: hex(n), pubkey: hex(1), created_at: T0, kind: NOSTR.rumorKind, tags: [], content: `mensaje ${n}` },
    label: 'answer',
    powBits: 16,
    relays: ['wss://relay.primal.net'],
    policy: 'once',
    now: T0,
    ...overrides,
  }
}

const claimOne = (owner: string, now: number) => claimDue(store, { owner, now, limit: 10, authorize: allow })
const rowState = (n: number, recipient = RECIPIENT) =>
  store.db.prepare('SELECT state, attempts, next_attempt_at FROM outbox WHERE recipient = ? AND rumor_id = ?').get(recipient, hex(n)) as
    | { state: string; attempts: number; next_attempt_at: number }
    | undefined

describe('enqueue', () => {
  it('stores one row per logical message', () => {
    expect(enqueue(store, input(1))).toBe('enqueued')
    expect(enqueue(store, input(1))).toBe('already_pending')
    expect(store.db.prepare('SELECT count(*) AS n FROM outbox').get()?.n).toBe(1)
  })

  it('rejects malformed input as a programming error', () => {
    expect(() => enqueue(store, input(1, { relays: [] }))).toThrow(/relays/)
    expect(() => enqueue(store, input(1, { recipient: 'nope' }))).toThrow(/hex/)
  })

  it('regenerates a published response at most once every 10 minutes', () => {
    enqueue(store, input(1))
    claimOne('a', T0)
    expect(markPublished(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now: T0 })).toBe('ok')
    expect(enqueue(store, input(1, { now: T0 + 60 }))).toBe('regeneration_too_soon')
    expect(enqueue(store, input(1, { now: T0 + NOSTR.regenerationIntervalSeconds }))).toBe('regenerated')
    expect(claimOne('a', T0 + NOSTR.regenerationIntervalSeconds).map((i) => i.rumorId)).toEqual([hex(1)])
  })

  it('stores but postpones messages beyond the per-recipient byte cap', () => {
    const big = (n: number) => input(n, { rumor: { ...input(n).rumor, content: 'x'.repeat(300_000) } })
    expect([1, 2, 3].map((n) => enqueue(store, big(n)))).toEqual(['enqueued', 'enqueued', 'enqueued'])
    expect(enqueue(store, big(4))).toBe('postponed_cap')
    expect(claimOne('a', T0).map((i) => i.rumorId)).toEqual([hex(1), hex(2), hex(3)])
    for (const n of [1, 2, 3]) markPublished(store, { recipient: RECIPIENT, rumorId: hex(n), owner: 'a', now: T0 })
    expect(claimOne('b', T0 + NOSTR.capPostponeSeconds).map((i) => i.rumorId)).toEqual([hex(4)])
  })
})

describe('claims', () => {
  it('gives a due row to exactly one owner until its claim expires', () => {
    enqueue(store, input(1))
    expect(claimOne('a', T0)).toHaveLength(1)
    expect(claimOne('b', T0 + 1)).toHaveLength(0)
    expect(stillClaimed(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now: T0 + 1 })).toBe(true)
    expect(stillClaimed(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'b', now: T0 + 1 })).toBe(false)
    const expired = T0 + NOSTR.claimSeconds
    expect(stillClaimed(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now: expired })).toBe(false)
    expect(claimOne('b', expired)).toHaveLength(1)
    expect(markPublished(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now: expired + 1 })).toBe('claim_lost')
    expect(markPublished(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'b', now: expired + 1 })).toBe('ok')
  })

  it('asks authorize inside the claim and abandons what it refuses', () => {
    enqueue(store, input(1))
    enqueue(store, input(2, { recipient: OTHER }))
    const claimed = claimDue(store, { owner: 'a', now: T0, limit: 10, authorize: (item) => item.recipient === RECIPIENT })
    expect(claimed.map((i) => i.recipient)).toEqual([RECIPIENT])
    expect(rowState(2, OTHER)?.state).toBe('abandoned')
    expect(claimDue(store, { owner: 'b', now: T0 + 1_000, limit: 10, authorize: allow }).map((i) => i.recipient)).toEqual([RECIPIENT])
  })
})

describe('byte caps enforced at claim time', () => {
  const big = (n: number, overrides: Partial<EnqueueInput> = {}) =>
    input(n, { rumor: { ...input(n).rumor, content: 'x'.repeat(300_000) }, ...overrides })

  it('keeps postponing an over-cap row while the older rows it would exceed the cap with remain pending', () => {
    expect([1, 2, 3].map((n) => enqueue(store, big(n)))).toEqual(['enqueued', 'enqueued', 'enqueued'])
    expect(enqueue(store, big(4))).toBe('postponed_cap')
    expect(claimOne('a', T0).map((i) => i.rumorId)).toEqual([hex(1), hex(2), hex(3)])
    // 'a' never publishes rows 1-3: their claims expire just as row 4 becomes due for the first time.
    const t1 = T0 + NOSTR.capPostponeSeconds
    expect(claimDue(store, { owner: 'b', now: t1, limit: 10, authorize: allow }).map((i) => i.rumorId)).toEqual([hex(1), hex(2), hex(3)])
    expect(rowState(4)?.next_attempt_at).toBe(t1 + NOSTR.capPostponeSeconds)
    for (const n of [1, 2, 3]) markPublished(store, { recipient: RECIPIENT, rumorId: hex(n), owner: 'b', now: t1 })
    expect(claimDue(store, { owner: 'b', now: t1 + NOSTR.capPostponeSeconds, limit: 10, authorize: allow }).map((i) => i.rumorId)).toEqual([hex(4)])
  })

  it('always claims the oldest pending row of a scope even if it alone exceeds the per-recipient cap', () => {
    const huge = input(1, { rumor: { ...input(1).rumor, content: 'x'.repeat(1_100_000) } })
    expect(enqueue(store, huge)).toBe('postponed_cap')
    expect(claimOne('a', T0)).toHaveLength(0)
    expect(claimOne('a', T0 + NOSTR.capPostponeSeconds)).toHaveLength(1)
  })

  it('does not let regenerating a published message bypass the per-recipient byte cap', () => {
    expect([1, 2, 3].map((n) => enqueue(store, big(n)))).toEqual(['enqueued', 'enqueued', 'enqueued'])
    expect(claimOne('a', T0)).toHaveLength(3)
    for (const n of [1, 2, 3]) markPublished(store, { recipient: RECIPIENT, rumorId: hex(n), owner: 'a', now: T0 })

    expect(enqueue(store, big(5))).toBe('enqueued')
    expect(claimOne('b', T0)).toHaveLength(1)
    markPublished(store, { recipient: RECIPIENT, rumorId: hex(5), owner: 'b', now: T0 })

    const t1 = T0 + NOSTR.regenerationIntervalSeconds
    for (const n of [1, 2, 3, 5]) expect(enqueue(store, big(n, { now: t1 }))).toBe('regenerated')

    expect(claimDue(store, { owner: 'c', now: t1, limit: 10, authorize: allow }).map((i) => i.rumorId)).toEqual([hex(1), hex(2), hex(3)])
    expect(rowState(5)).toMatchObject({ state: 'pending', next_attempt_at: t1 + NOSTR.capPostponeSeconds })
    for (const n of [1, 2, 3]) expect(rowState(n)?.state).toBe('pending')
  })
})

describe('publish reservations', () => {
  it('allows at most 60 publishes per minute, reserved right before publishing', () => {
    for (let n = 1; n <= 70; n++) enqueue(store, input(n))
    expect(claimDue(store, { owner: 'a', now: T0, limit: 100, authorize: allow })).toHaveLength(70)
    const reserve = (n: number, now: number) => reservePublish(store, { recipient: RECIPIENT, rumorId: hex(n), owner: 'a', now })
    const first = Array.from({ length: 70 }, (_, i) => reserve(i + 1, T0))
    expect(first.filter((r) => r === 'reserved')).toHaveLength(60)
    expect(first.filter((r) => r === 'over_budget')).toHaveLength(10)
    expect(reserve(61, T0 + 60)).toBe('reserved')
  })

  it('refuses a reservation once the claim is lost', () => {
    enqueue(store, input(1))
    claimOne('a', T0)
    claimOne('b', T0 + NOSTR.claimSeconds)
    expect(reservePublish(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now: T0 + NOSTR.claimSeconds })).toBe('claim_lost')
  })

  it('postpones a claimed row without counting an attempt', () => {
    enqueue(store, input(1))
    claimOne('a', T0)
    expect(postpone(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', retryAt: T0 + 300 })).toBe('ok')
    expect(claimOne('a', T0 + 299)).toHaveLength(0)
    expect(claimOne('a', T0 + 300)).toHaveLength(1)
    expect(rowState(1)?.attempts).toBe(0)
  })
})

describe('schedules', () => {
  const retry = (n: number) => input(n, { policy: 'retry_until_resolved', label: 'question' })

  it('re-publishes retried messages every 5 minutes for an hour, then every 30 minutes, and never after 7 days', () => {
    enqueue(store, retry(1))
    const publishAt = (now: number) => {
      expect(claimOne('a', now)).toHaveLength(1)
      expect(markPublished(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now })).toBe('ok')
      return rowState(1)
    }
    expect(publishAt(T0)).toMatchObject({ state: 'pending', next_attempt_at: T0 + 300 })
    expect(claimOne('a', T0 + 299)).toHaveLength(0)
    expect(publishAt(T0 + 3_600)).toMatchObject({ state: 'pending', next_attempt_at: T0 + 3_600 + 1_800 })
    expect(claimOne('a', T0 + NOSTR.retryWindowSeconds)).toHaveLength(0)
    expect(rowState(1)?.state).toBe('abandoned')
  })

  it('abandons a response nobody could deliver for 9 days instead of publishing it late', () => {
    enqueue(store, input(1))
    expect(claimOne('a', T0 + NOSTR.decisionRetentionSeconds)).toHaveLength(0)
    expect(rowState(1)?.state).toBe('abandoned')
  })

  it('backs off failed attempts exponentially up to 30 minutes', () => {
    enqueue(store, input(1))
    let now = T0
    const delays: number[] = []
    for (let i = 0; i < 8; i++) {
      expect(claimOne('a', now)).toHaveLength(1)
      markFailed(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now })
      const next = rowState(1)!.next_attempt_at
      delays.push(next - now)
      now = next
    }
    expect(delays).toEqual([30, 60, 120, 240, 480, 960, 1_800, 1_800])
  })

  it('resolveOutboxMessage stops a retried message for good', () => {
    enqueue(store, retry(1))
    expect(resolveOutboxMessage(store, { recipient: RECIPIENT, rumorId: hex(1) })).toBe(true)
    expect(claimOne('a', T0)).toHaveLength(0)
  })
})

describe('cleanup', () => {
  it('deletes everything for a recipient except rows currently claimed', () => {
    enqueue(store, input(1))
    enqueue(store, input(2))
    enqueue(store, input(3))
    claimDue(store, { owner: 'a', now: T0, limit: 1, authorize: allow })
    expect(deleteUnclaimedFor(store, { recipient: RECIPIENT, now: T0 + 1 })).toBe(2)
    expect((store.db.prepare('SELECT rumor_id FROM outbox').all() as Array<{ rumor_id: string }>).map((r) => r.rumor_id)).toEqual([hex(1)])
  })

  it('purges message content 7 days after the rumor was created, whatever the row state', () => {
    enqueue(store, input(1))
    enqueue(store, input(2, { rumor: { ...input(2).rumor, created_at: T0 + 100 } }))
    expect(purgeOutbox(store, T0 + NOSTR.contentRetentionSeconds - 1)).toBe(0)
    expect(purgeOutbox(store, T0 + NOSTR.contentRetentionSeconds)).toBe(1)
    expect(rowState(2)?.state).toBe('pending')
  })
})

describe('claimDue guards', () => {
  it('abandons only the row whose authorization throws', () => {
    enqueue(store, input(1))
    enqueue(store, input(2))
    const claimed = claimDue(store, {
      owner: 'a',
      now: T0,
      limit: 10,
      authorize: (item) => {
        if (item.rumorId === hex(1)) throw new Error('boom')
        return true
      },
    })
    expect(claimed.map((i) => i.rumorId)).toEqual([hex(2)])
    expect(rowState(1)?.state).toBe('abandoned')
    expect(rowState(2)?.state).toBe('pending')
  })

  it('calls onAbandon once with the row identity and the thrown error when authorization throws', () => {
    enqueue(store, input(1))
    enqueue(store, input(2))
    const boom = new Error('boom')
    const calls: Array<[{ recipient: string; rumorId: string; label: string }, unknown]> = []
    const claimed = claimDue(store, {
      owner: 'a',
      now: T0,
      limit: 10,
      authorize: (item) => {
        if (item.rumorId === hex(1)) throw boom
        return true
      },
      onAbandon: (row, err) => calls.push([row, err]),
    })
    expect(claimed.map((i) => i.rumorId)).toEqual([hex(2)])
    expect(calls).toEqual([[{ recipient: RECIPIENT, rumorId: hex(1), label: 'answer' }, boom]])
    expect(rowState(1)?.state).toBe('abandoned')
  })

  it('does not call onAbandon when authorize plainly refuses a row', () => {
    enqueue(store, input(1))
    let called = false
    const claimed = claimDue(store, { owner: 'a', now: T0, limit: 10, authorize: () => false, onAbandon: () => (called = true) })
    expect(claimed).toEqual([])
    expect(called).toBe(false)
    expect(rowState(1)?.state).toBe('abandoned')
  })

  it('still abandons the row and grants the others when onAbandon itself throws', () => {
    enqueue(store, input(1))
    enqueue(store, input(2))
    const claimed = claimDue(store, {
      owner: 'a',
      now: T0,
      limit: 10,
      authorize: (item) => {
        if (item.rumorId === hex(1)) throw new Error('boom')
        return true
      },
      onAbandon: () => {
        throw new Error('onAbandon boom')
      },
    })
    expect(claimed.map((i) => i.rumorId)).toEqual([hex(2)])
    expect(rowState(1)?.state).toBe('abandoned')
    expect(rowState(2)?.state).toBe('pending')
  })
})

describe('hasDueOutbox', () => {
  it('is true for a pending row that is due and unclaimed', () => {
    enqueue(store, input(1))
    expect(hasDueOutbox(store, T0)).toBe(true)
  })

  it('is false once the row is claimed with a live claim', () => {
    enqueue(store, input(1))
    claimOne('a', T0)
    expect(hasDueOutbox(store, T0)).toBe(false)
  })

  it('is false when there are no rows at all', () => {
    expect(hasDueOutbox(store, T0)).toBe(false)
  })
})

describe('renewClaim', () => {
  it('extends a claim still owned by the caller, even after it lapsed', () => {
    enqueue(store, input(1))
    claimOne('a', T0)
    const later = T0 + NOSTR.claimSeconds + 30
    expect(renewClaim(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now: later })).toBe('ok')
    expect(stillClaimed(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now: later + NOSTR.claimSeconds - 1 })).toBe(true)
  })

  it('refuses once another owner claimed the row', () => {
    enqueue(store, input(1))
    claimOne('a', T0)
    claimOne('b', T0 + NOSTR.claimSeconds)
    expect(renewClaim(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now: T0 + NOSTR.claimSeconds })).toBe('claim_lost')
  })

  it('refuses for a row that is no longer pending', () => {
    enqueue(store, input(1))
    claimOne('a', T0)
    markPublished(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now: T0 })
    expect(renewClaim(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now: T0 })).toBe('claim_lost')
  })
})
