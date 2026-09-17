import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireChannelLock,
  getChannelLock,
  openStore,
  releaseChannelLock,
  verifyChannelLock,
  type ProcessIdentity,
  type Store,
} from '@agentbridge/core'

const T0 = 2_000_000_000
const me: ProcessIdentity = { pid: 1111, start: 'Thu Sep 17 09:00:00 2026' }
const other: ProcessIdentity = { pid: 2222, start: 'Thu Sep 17 08:00:00 2026' }
const alive = () => true
const dead = () => false
let store: Store

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-lock-')), 'home'))
})
afterEach(() => store.close())

function seedDispatched(): void {
  const sender = 'a'.repeat(64)
  store.db
    .prepare(
      `INSERT INTO inbox_questions (sender_pubkey, question_id, rumor_id, rumor_created_at, generation, text, state, admitted, received_at, updated_at)
       VALUES (?, 'q1', ?, ?, 1, 'hola', 'dispatched', 1, ?, ?)`,
    )
    .run(sender, 'b'.repeat(64), T0, T0, T0)
  store.db
    .prepare("INSERT INTO attempts (attempt_id, sender_pubkey, question_id, code, epoch, deadline_ms, state, created_at) VALUES ('att', ?, 'q1', 'ABCD', 1, 0, 'active', ?)")
    .run(sender, T0)
}

describe('channel lock', () => {
  it('is free at first and taken with epoch 1', () => {
    expect(getChannelLock(store)).toBeNull()
    expect(acquireChannelLock(store, { self: me, isAlive: alive, now: T0 })).toEqual({ kind: 'acquired', epoch: 1, requeued: 0 })
    expect(getChannelLock(store)).toEqual({ pid: me.pid, start: me.start, epoch: 1, acquiredAt: T0 })
    expect(verifyChannelLock(store, 1)).toBe(true)
  })

  it('refuses while another live process holds it', () => {
    acquireChannelLock(store, { self: other, isAlive: alive, now: T0 })
    expect(acquireChannelLock(store, { self: me, isAlive: alive, now: T0 + 1 })).toEqual({
      kind: 'held',
      holder: { pid: other.pid, start: other.start, epoch: 1, acquiredAt: T0 },
    })
  })

  it('takes it from a dead owner with a greater epoch and recovers the dispatch state', () => {
    acquireChannelLock(store, { self: other, isAlive: alive, now: T0 })
    seedDispatched()
    const probed: ProcessIdentity[] = []
    const outcome = acquireChannelLock(store, {
      self: me,
      isAlive: (holder) => {
        probed.push(holder)
        return false
      },
      now: T0 + 5,
    })
    expect(probed).toEqual([other])
    expect(outcome).toEqual({ kind: 'acquired', epoch: 2, requeued: 1 })
    expect(verifyChannelLock(store, 1)).toBe(false)
    expect(store.db.prepare("SELECT state FROM inbox_questions WHERE question_id = 'q1'").get()?.state).toBe('queued')
    expect(store.db.prepare("SELECT state, cancel_reason FROM attempts WHERE attempt_id = 'att'").get()).toEqual({ state: 'cancelled', cancel_reason: 'recovered' })
  })

  it('never probes itself', () => {
    acquireChannelLock(store, { self: me, isAlive: alive, now: T0 })
    const again = acquireChannelLock(store, {
      self: me,
      isAlive: () => {
        throw new Error('must not probe its own process')
      },
      now: T0 + 1,
    })
    expect(again).toEqual({ kind: 'acquired', epoch: 2, requeued: 0 })
  })

  it('keeps the epoch growing across a release', () => {
    acquireChannelLock(store, { self: me, isAlive: alive, now: T0 })
    expect(releaseChannelLock(store, { epoch: 2 })).toBe(false)
    expect(releaseChannelLock(store, { epoch: 1 })).toBe(true)
    expect(getChannelLock(store)).toBeNull()
    expect(verifyChannelLock(store, 1)).toBe(false)
    expect(acquireChannelLock(store, { self: other, isAlive: dead, now: T0 + 1 })).toEqual({ kind: 'acquired', epoch: 2, requeued: 0 })
  })

  it('re-reads the lock when it changed while the owner was being probed', () => {
    acquireChannelLock(store, { self: other, isAlive: alive, now: T0 })
    const third: ProcessIdentity = { pid: 3333, start: 'Thu Sep 17 10:00:00 2026' }
    let probes = 0
    const outcome = acquireChannelLock(store, {
      self: me,
      isAlive: () => {
        probes++
        if (probes === 1) {
          store.db.prepare('UPDATE channel_lock SET pid = ?, process_start = ?, epoch = epoch + 1 WHERE id = 1').run(third.pid, third.start)
          return false
        }
        return true
      },
      now: T0 + 1,
    })
    expect(outcome).toEqual({ kind: 'held', holder: { pid: third.pid, start: third.start, epoch: 2, acquiredAt: T0 } })
  })
})
