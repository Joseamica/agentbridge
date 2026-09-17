import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NostrEvent } from 'nostr-tools/pure'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardPool, DAY_SECONDS, historyWindows, openStore, recoverHistory } from '@agentbridge/core'
import { plainSocketFactory, startFakeBoard, type FakeBoard, type FakeBoardOptions } from './support/fake-board'
import { testIdentity } from './support/keys'

const me = testIdentity(9)
const TODAY = 20_000
const NOW = TODAY * DAY_SECONDS + 43_200
const dayStart = (daysAgo: number) => (TODAY - daysAgo) * DAY_SECONDS
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

let counter = 0
const event = (created_at: number): NostrEvent => ({
  id: (++counter).toString(16).padStart(64, '0'),
  pubkey: 'c'.repeat(64),
  created_at,
  kind: 1059,
  tags: [['p', me.publicKey]],
  content: '',
  sig: 'd'.repeat(128),
})

async function setup(options: FakeBoardOptions = {}) {
  const board = await startFakeBoard(options)
  const store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-history-')), 'home'))
  const pool = new BoardPool({ identity: me, createSocket: plainSocketFactory, timeoutMs: 2_000 })
  cleanups.push(() => board.close(), () => store.close(), () => pool.close())
  const handled: string[] = []
  const recover = (handle = async (raw: unknown) => void handled.push((raw as NostrEvent).id)) =>
    recoverHistory({ pool, store, relay: board.url, role: 'responder', recipientPubkey: me.publicKey, now: NOW, handle })
  const remaining = () => historyWindows(store, { relay: board.url, role: 'responder', now: NOW }).map((w) => w.since)
  return { board, handled, recover, remaining }
}

const reqCount = (board: FakeBoard) => board.frames.filter((f) => f[0] === 'REQ').length

describe('recoverHistory', () => {
  it('reads every event across pages and marks only windows that can no longer change', async () => {
    const { board, handled, recover } = await setup()
    for (let i = 0; i < 450; i++) board.inject(event(dayStart(5) + i * 10))
    for (let i = 0; i < 3; i++) board.inject(event(dayStart(1) + i))
    const result = await recover()
    expect(new Set(handled).size).toBe(453)
    expect(handled).toHaveLength(453)
    expect(result).toEqual({ windows: 10, completed: 7, pendingRecent: 3, incomplete: 0, events: 453 })
  })

  it('escalates same-second pages, and only trusts a short page once the relay has served a bigger one', async () => {
    const { board, handled, recover, remaining } = await setup({ maxLimit: 1_000 })
    for (let i = 0; i < 450; i++) board.inject(event(dayStart(4) + 100))
    for (let i = 0; i < 300; i++) board.inject(event(dayStart(5) + 100))
    const result = await recover()
    expect(result).toMatchObject({ completed: 6, pendingRecent: 3, incomplete: 1 })
    expect(handled).toHaveLength(750)
    expect(remaining()).toContain(dayStart(4))
    expect(remaining()).not.toContain(dayStart(5))
  })

  it('leaves an ambiguous same-second window incomplete instead of guessing', async () => {
    const { board, handled, recover, remaining } = await setup({ maxLimit: 1_000 })
    for (let i = 0; i < 150; i++) board.inject(event(dayStart(5) + 100))
    const result = await recover()
    expect(handled).toHaveLength(150)
    expect(result.incomplete).toBe(1)
    expect(remaining()).toContain(dayStart(5))
  })

  it('walks a relay that caps results below the page size when timestamps differ', async () => {
    const { board, handled, recover } = await setup({ maxLimit: 50 })
    for (let i = 0; i < 120; i++) board.inject(event(dayStart(5) + i * 10))
    const result = await recover()
    expect(handled).toHaveLength(120)
    expect(result.incomplete).toBe(0)
  })

  it('skips completed windows on the next run', async () => {
    const { board, recover } = await setup()
    await recover()
    const before = reqCount(board)
    const second = await recover()
    expect(second.windows).toBe(3)
    expect(reqCount(board) - before).toBe(3)
  })

  it('leaves every window incomplete when the relay refuses to be read', async () => {
    const { recover } = await setup({ rejectReads: true })
    expect(await recover()).toMatchObject({ completed: 0, pendingRecent: 0, incomplete: 10 })
  })

  it('never marks a window complete when handling an event fails', async () => {
    const { board, recover, remaining } = await setup()
    board.inject(event(dayStart(5) + 1))
    await expect(
      recover(async () => {
        throw new Error('disk full')
      }),
    ).rejects.toThrow('disk full')
    expect(remaining()).toContain(dayStart(5))
  })
})
