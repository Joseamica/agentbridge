import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_RELAYS,
  MIGRATIONS,
  REQUEST_NOTICE_INTERVAL_SECONDS,
  UserFacingError,
  claimRequestNoticeSlot,
  clearRequestNoticePending,
  getProfile,
  getSetting,
  markRequestNoticePending,
  openStore,
  setProfile,
  setSetting,
  type Store,
} from '@agentbridge/core'

const T0 = 2_000_000_000
const stores: Store[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
})

async function newStore(options: Parameters<typeof openStore>[1] = {}): Promise<Store> {
  const store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-settings-')), 'home'), options)
  stores.push(store)
  return store
}

describe('schema v2', () => {
  it('adds the responder tables and the request decision rumor column', async () => {
    const store = await newStore()
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3])
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name)
    expect(tables).toEqual(expect.arrayContaining(['settings', 'inbox_questions', 'attempts', 'channel_lock', 'question_codes']))
    const columns = (store.db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(columns).toEqual(expect.arrayContaining(['decision_rumor_json', 'decision_resent_at']))
    const inboxColumns = (store.db.prepare('PRAGMA table_info(inbox_questions)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(inboxColumns).toContain('regenerated_at')
  })

  it('deletes a question’s attempts together with the question', async () => {
    const store = await newStore()
    const sender = 'a'.repeat(64)
    store.db
      .prepare(
        `INSERT INTO inbox_questions (sender_pubkey, question_id, rumor_id, rumor_created_at, generation, text, state, admitted, received_at, updated_at)
         VALUES (?, 'q', ?, ?, 1, 'hola', 'dispatched', 1, ?, ?)`,
      )
      .run(sender, 'b'.repeat(64), T0, T0, T0)
    store.db
      .prepare("INSERT INTO attempts (attempt_id, sender_pubkey, question_id, code, epoch, deadline_ms, state, created_at) VALUES ('x', ?, 'q', 'ABCD', 1, 0, 'active', ?)")
      .run(sender, T0)
    store.db.prepare('DELETE FROM inbox_questions').run()
    expect(store.db.prepare('SELECT count(*) AS n FROM attempts').get()?.n).toBe(0)
  })
})

describe('settings', () => {
  it('stores and overwrites values', async () => {
    const store = await newStore()
    expect(getSetting(store, 'k')).toBeNull()
    setSetting(store, 'k', 'uno', T0)
    setSetting(store, 'k', 'dos', T0 + 1)
    expect(getSetting(store, 'k')).toBe('dos')
  })
})

describe('profile', () => {
  it('starts with no name and the default relays', async () => {
    const store = await newStore()
    expect(getProfile(store)).toEqual({ name: null, relays: [...DEFAULT_RELAYS] })
    expect(DEFAULT_RELAYS).toHaveLength(5)
  })

  it('trims the name and keeps only valid relays', async () => {
    const store = await newStore()
    const profile = setProfile(store, { name: '  Ana López ', relays: ['ws://inseguro.example.com', 'wss://relay.damus.io', 'wss://relay.damus.io'], now: T0 })
    expect(profile).toEqual({ name: 'Ana López', relays: ['wss://relay.damus.io'] })
    expect(getProfile(store)).toEqual(profile)
  })

  it('refuses a blank or too long name and a relay list with nothing valid', async () => {
    const store = await newStore()
    expect(() => setProfile(store, { name: '   ', now: T0 })).toThrow(UserFacingError)
    expect(() => setProfile(store, { name: 'x'.repeat(81), now: T0 })).toThrow(UserFacingError)
    expect(() => setProfile(store, { relays: ['http://no.example.com'], now: T0 })).toThrow(UserFacingError)
    expect(getProfile(store)).toEqual({ name: null, relays: [...DEFAULT_RELAYS] })
  })

  it('falls back to the default relays when the stored list is unusable', async () => {
    const store = await newStore()
    setSetting(store, 'profile.relays', 'not json', T0)
    expect(getProfile(store).relays).toEqual([...DEFAULT_RELAYS])
    setSetting(store, 'profile.relays', JSON.stringify(['ws://127.0.0.1:1']), T0)
    expect(getProfile(store).relays).toEqual([...DEFAULT_RELAYS])
  })

  it('uses the store relay policy, so tests can point a profile at local boards', async () => {
    const store = await newStore({ relayPolicy: (inputs) => inputs.filter((x): x is string => typeof x === 'string') })
    expect(setProfile(store, { relays: ['ws://127.0.0.1:7777'], now: T0 }).relays).toEqual(['ws://127.0.0.1:7777'])
  })
})

describe('request notice slot', () => {
  it('grants nothing while no request is waiting for a notice', async () => {
    const store = await newStore()
    expect(claimRequestNoticeSlot(store, T0)).toBe(false)
  })

  it('grants one notice per pending mark, at most once per interval', async () => {
    const store = await newStore()
    markRequestNoticePending(store, T0)
    expect(claimRequestNoticeSlot(store, T0)).toBe(true)
    expect(claimRequestNoticeSlot(store, T0 + 1)).toBe(false)
    markRequestNoticePending(store, T0 + 2)
    expect(claimRequestNoticeSlot(store, T0 + REQUEST_NOTICE_INTERVAL_SECONDS - 1)).toBe(false)
    expect(claimRequestNoticeSlot(store, T0 + REQUEST_NOTICE_INTERVAL_SECONDS)).toBe(true)
  })

  it('forgets a pending notice once the requests were listed', async () => {
    const store = await newStore()
    markRequestNoticePending(store, T0)
    clearRequestNoticePending(store, T0 + 1)
    expect(claimRequestNoticeSlot(store, T0 + REQUEST_NOTICE_INTERVAL_SECONDS)).toBe(false)
  })
})
