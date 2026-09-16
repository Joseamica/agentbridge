import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { DAY_SECONDS, NOSTR, historyWindows, markWindowComplete, openStore, purgeCursors, type Store } from '@agentbridge/core'

const RELAY = 'wss://relay.primal.net'
const NOW = 20_000 * DAY_SECONDS + 43_200
let store: Store

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-cursors-')), 'home'))
})

describe('historyWindows', () => {
  it('covers nine days back in aligned, inclusive day windows, newest first', () => {
    const windows = historyWindows(store, { relay: RELAY, role: 'responder', now: NOW })
    expect(windows).toHaveLength(NOSTR.historyDays + 1)
    expect(windows[0]).toEqual({ since: 20_000 * DAY_SECONDS, until: 20_000 * DAY_SECONDS + DAY_SECONDS - 1 })
    expect(windows.at(-1)).toEqual({ since: (20_000 - 9) * DAY_SECONDS, until: (20_000 - 9) * DAY_SECONDS + DAY_SECONDS - 1 })
  })

  it('skips completed windows, per relay and per role', () => {
    const old = (20_000 - 5) * DAY_SECONDS
    expect(markWindowComplete(store, { relay: RELAY, role: 'responder', since: old, readStartedAt: NOW, now: NOW })).toBe(true)
    expect(historyWindows(store, { relay: RELAY, role: 'responder', now: NOW }).map((w) => w.since)).not.toContain(old)
    expect(historyWindows(store, { relay: RELAY, role: 'asker', now: NOW }).map((w) => w.since)).toContain(old)
    expect(historyWindows(store, { relay: 'wss://nos.lol', role: 'responder', now: NOW }).map((w) => w.since)).toContain(old)
  })
})

describe('markWindowComplete', () => {
  it('refuses windows a newly published wrap could still be dated into', () => {
    const yesterday = (20_000 - 1) * DAY_SECONDS
    const twoDaysAgo = (20_000 - 2) * DAY_SECONDS
    const threeDaysAgo = (20_000 - 3) * DAY_SECONDS
    expect(markWindowComplete(store, { relay: RELAY, role: 'asker', since: yesterday, readStartedAt: NOW, now: NOW })).toBe(false)
    expect(markWindowComplete(store, { relay: RELAY, role: 'asker', since: twoDaysAgo, readStartedAt: NOW, now: NOW })).toBe(false)
    expect(markWindowComplete(store, { relay: RELAY, role: 'asker', since: threeDaysAgo, readStartedAt: NOW, now: NOW })).toBe(true)
  })

  it('rejects windows that are not aligned to a day', () => {
    expect(() => markWindowComplete(store, { relay: RELAY, role: 'asker', since: 123, readStartedAt: NOW, now: NOW })).toThrow(/aligned/)
  })
})

describe('purgeCursors', () => {
  it('drops windows older than the history horizon', () => {
    const ancient = (20_000 - 30) * DAY_SECONDS
    markWindowComplete(store, { relay: RELAY, role: 'asker', since: ancient, readStartedAt: NOW, now: NOW })
    markWindowComplete(store, { relay: RELAY, role: 'asker', since: (20_000 - 4) * DAY_SECONDS, readStartedAt: NOW, now: NOW })
    expect(purgeCursors(store, NOW)).toBe(1)
  })
})
