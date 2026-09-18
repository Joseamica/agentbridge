import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireChannelLock,
  admitQuestion,
  approveRequest,
  getInboxQuestion,
  openStore,
  recordIncomingRequest,
  reserveNextQuestion,
  revokeConnection,
  type Store,
} from '@agentbridge/core'
import { Dispatcher, type CancelReason, type QuestionNotice } from '../src/dispatcher'
import { testIdentity } from '../../core/test/support/keys'

const responder = testIdentity(101)
const asker = testIdentity(102)
const T0 = 2_000_000_000
const hex = (n: number) => n.toString(16).padStart(64, '0')
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
let store: Store
let epoch: number
let clock: { ms: number }
let delivered: QuestionNotice[]
let cancelled: Array<{ code: string; reason: CancelReason }>
let enqueued: number
let fenced: number
const dispatchers: Dispatcher[] = []

const until = async (check: () => boolean, ms = 5_000) => {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-dispatcher-')), 'home'))
  const lock = acquireChannelLock(store, { self: { pid: 1, start: 'test' }, isAlive: () => false, now: T0 })
  if (lock.kind !== 'acquired') throw new Error('lock not acquired')
  epoch = lock.epoch
  recordIncomingRequest(store, { pubkey: asker.publicKey, requestId: uuid(9000), requestRumorId: hex(9000), declaredName: 'Beto', note: '', relays: ['wss://relay.example.com'], now: T0 })
  approveRequest(store, { pubkey: asker.publicKey, now: T0 })
  clock = { ms: T0 * 1000 }
  delivered = []
  cancelled = []
  enqueued = 0
  fenced = 0
})

afterEach(async () => {
  for (const d of dispatchers.splice(0)) await d.stop()
  store.close()
})

function dispatcher(attemptTimeoutMs = 60_000): Dispatcher {
  const d = new Dispatcher({
    store,
    identity: responder,
    epoch,
    deliver: async (q) => {
      delivered.push(q)
    },
    cancel: async (code, reason) => {
      cancelled.push({ code, reason })
    },
    onEnqueued: () => enqueued++,
    onFenced: () => fenced++,
    attemptTimeoutMs,
    pollMs: 10,
    nowMs: () => clock.ms,
  })
  dispatchers.push(d)
  return d
}

const admit = (n: number) =>
  admitQuestion(store, { identity: responder, senderPubkey: asker.publicKey, questionId: uuid(n), rumorId: hex(100 + n), rumorCreatedAt: T0, generation: 1, text: `pregunta ${n}`, now: T0 + n })
const reply = (d: Dispatcher, code: string) => d.reply({ code, answer: 'Listo.', source: 'notas.md', confidence: 'seguro' })

describe('Dispatcher', () => {
  it('delivers the oldest question and holds the next one until it is answered', async () => {
    admit(1)
    admit(2)
    const d = dispatcher()
    d.start()
    await until(() => delivered.length === 1)
    expect(delivered[0]).toMatchObject({ fromName: 'beto', text: 'pregunta 1' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(delivered).toHaveLength(1)
    expect(reply(d, delivered[0]!.code)).toMatchObject({ kind: 'answered', fromName: 'beto' })
    expect(enqueued).toBe(1)
    await until(() => delivered.length === 2)
    expect(delivered[1]!.text).toBe('pregunta 2')
  })

  it('picks up a question admitted after it started when woken', async () => {
    const d = dispatcher()
    d.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    admit(1)
    d.wake()
    await until(() => delivered.length === 1)
  })

  it('cancels a question in Claude at its deadline, redelivers it once, then gives up', async () => {
    admit(1)
    const d = dispatcher(1_000)
    d.start()
    await until(() => delivered.length === 1)
    const firstCode = delivered[0]!.code
    clock.ms += 1_000
    await until(() => delivered.length === 2)
    expect(cancelled).toEqual([{ code: firstCode, reason: 'timeout' }])
    expect(reply(d, firstCode).kind).toBe('cancelled')
    clock.ms += 1_000
    await until(() => cancelled.length === 2)
    expect(cancelled[1]).toEqual({ code: delivered[1]!.code, reason: 'timeout' })
    expect(enqueued).toBe(1)
    expect(getInboxQuestion(store, asker.publicKey, uuid(1))).toMatchObject({ state: 'rejected', rejectReason: 'unanswered' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(delivered).toHaveLength(2)
  })

  it('tells Claude when a revocation from any process cancels the active question', async () => {
    admit(1)
    const d = dispatcher()
    d.start()
    await until(() => delivered.length === 1)
    revokeConnection(store, { identity: responder, name: 'beto', now: T0 + 50 })
    await until(() => cancelled.length === 1)
    expect(cancelled[0]).toEqual({ code: delivered[0]!.code, reason: 'revoked' })
    expect(reply(d, delivered[0]!.code).kind).toBe('cancelled')
  })

  it('keeps polling after a store error', async () => {
    admit(1)
    let failures = 1
    const flaky: Store = {
      ...store,
      tx: <T>(fn: () => T): T => {
        if (failures-- > 0) throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' })
        return store.tx(fn)
      },
    }
    const d = new Dispatcher({
      store: flaky,
      identity: responder,
      epoch,
      deliver: async (q) => {
        delivered.push(q)
      },
      cancel: async () => {},
      pollMs: 10,
      nowMs: () => clock.ms,
    })
    dispatchers.push(d)
    d.start()
    await until(() => delivered.length === 1)
  })

  it('keeps deadlines and shutdown working while a write to Claude never completes', async () => {
    admit(1)
    const stuck: QuestionNotice[] = []
    const d = new Dispatcher({
      store,
      identity: responder,
      epoch,
      deliver: (q) => {
        stuck.push(q)
        return new Promise<void>(() => {})
      },
      cancel: async (code, reason) => {
        cancelled.push({ code, reason })
      },
      attemptTimeoutMs: 1_000,
      pollMs: 10,
      nowMs: () => clock.ms,
    })
    dispatchers.push(d)
    d.start()
    await until(() => stuck.length === 1)
    clock.ms += 1_000
    await until(() => cancelled.length === 1)
    expect(cancelled[0]).toEqual({ code: stuck[0]!.code, reason: 'timeout' })
    await d.stop()
  })

  it('stops when another channel took the lock', async () => {
    const d = dispatcher()
    d.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    acquireChannelLock(store, { self: { pid: 2, start: 'other' }, isAlive: () => false, now: T0 + 1 })
    admit(1)
    await until(() => fenced === 1)
    expect(delivered).toEqual([])
    expect(reply(d, 'AAAA').kind).toBe('fenced')
  })

  it('keeps ticking, and lets stop() resolve, when the log sink itself throws', async () => {
    let failures = 1
    const flaky: Store = {
      ...store,
      tx: <T>(fn: () => T): T => {
        if (failures-- > 0) throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' })
        return store.tx(fn)
      },
    }
    const d = new Dispatcher({
      store: flaky,
      identity: responder,
      epoch,
      deliver: async (q) => {
        delivered.push(q)
      },
      cancel: async () => {},
      pollMs: 10,
      nowMs: () => clock.ms,
      log: () => {
        throw new Error('stderr write failed: EPIPE')
      },
    })
    dispatchers.push(d)
    d.start()
    // The very first tick throws (the flaky store) and the error handler's own log call also throws
    // (a closed stdio pipe). The chain must still advance to later ticks instead of wedging on the
    // rejected promise: a question admitted well after this point must still get delivered.
    await new Promise((resolve) => setTimeout(resolve, 50))
    admit(1)
    await until(() => delivered.length === 1)
    await d.stop()
  })

  it('logs a tick failure through describeError without leaking the question code or its text', async () => {
    admit(1)
    let failures = 1
    const flaky: Store = {
      ...store,
      tx: <T>(fn: () => T): T => {
        if (failures-- > 0) throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' })
        return store.tx(fn)
      },
    }
    const lines: string[] = []
    const d = new Dispatcher({
      store: flaky,
      identity: responder,
      epoch,
      deliver: async (q) => {
        delivered.push(q)
      },
      cancel: async () => {},
      pollMs: 10,
      nowMs: () => clock.ms,
      log: (line) => lines.push(line),
    })
    dispatchers.push(d)
    d.start()
    await until(() => delivered.length === 1)
    expect(lines).toEqual(['dispatch failed (Error (ERR_SQLITE_ERROR))'])
    expect(lines[0]).not.toContain(delivered[0]!.code)
    expect(lines[0]).not.toContain('pregunta 1')
  })

  it('answers fenced without touching the store once another channel has taken the lock', async () => {
    let txCalls = 0
    const counting: Store = {
      ...store,
      tx: <T>(fn: () => T): T => {
        txCalls++
        return store.tx(fn)
      },
    }
    const d = new Dispatcher({
      store: counting,
      identity: responder,
      epoch,
      deliver: async (q) => {
        delivered.push(q)
      },
      cancel: async () => {},
      onFenced: () => fenced++,
      pollMs: 10,
      nowMs: () => clock.ms,
    })
    dispatchers.push(d)
    d.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    acquireChannelLock(store, { self: { pid: 2, start: 'other' }, isAlive: () => false, now: T0 + 1 })
    admit(1)
    await until(() => fenced === 1)
    const callsAtFence = txCalls
    expect(d.reply({ code: 'AAAA', answer: 'Listo.', source: 'notas.md', confidence: 'seguro' })).toEqual({ kind: 'fenced' })
    expect(txCalls).toBe(callsAtFence)
  })

  it('still stores an answer after a graceful stop, since the epoch is still valid', async () => {
    admit(1)
    const d = dispatcher()
    d.start()
    await until(() => delivered.length === 1)
    const code = delivered[0]!.code
    await d.stop()
    const outcome = reply(d, code)
    expect(outcome.kind).toBe('answered')
    expect(getInboxQuestion(store, asker.publicKey, uuid(1))).toMatchObject({ state: 'answered' })
    const answerRow = store.db.prepare("SELECT 1 FROM outbox WHERE recipient = ? AND label = 'answer'").get(asker.publicKey)
    expect(answerRow).toBeTruthy()
  })

  it('logs once when the store already holds an active attempt this instance is not tracking', async () => {
    admit(1)
    // Simulates a leftover active attempt from before a restart, which recovery normally clears; this
    // dispatcher instance's own `tracked` field is null even though the store is not.
    reserveNextQuestion(store, { epoch, nowMs: clock.ms, attemptTimeoutMs: 60_000, identity: responder })
    const lines: string[] = []
    const d = new Dispatcher({
      store,
      identity: responder,
      epoch,
      deliver: async (q) => {
        delivered.push(q)
      },
      cancel: async () => {},
      pollMs: 10,
      nowMs: () => clock.ms,
      log: (line) => lines.push(line),
    })
    dispatchers.push(d)
    d.start()
    await until(() => lines.length > 0)
    expect(lines[0]).toMatch(/active attempt/)
    expect(lines[0]).not.toContain('pregunta')
    expect(delivered).toEqual([])
  })

  it('forgets a stale tracked attempt instead of spinning when expireAttempt reports it already moved on', async () => {
    admit(1)
    let txCalls = 0
    const wrapped: Store = {
      ...store,
      tx: <T>(fn: () => T): T => {
        txCalls++
        // Simulates a concurrent process (or clock skew) making expireAttempt report the attempt is no
        // longer active/due, forever, without ever really touching the underlying row.
        if (txCalls >= 2) return { kind: 'not_active' } as unknown as T
        return store.tx(fn)
      },
    }
    const d = new Dispatcher({
      store: wrapped,
      identity: responder,
      epoch,
      deliver: async (q) => {
        delivered.push(q)
      },
      cancel: async () => {},
      attemptTimeoutMs: 1_000,
      pollMs: 10,
      nowMs: () => clock.ms,
    })
    dispatchers.push(d)
    d.start()
    await until(() => delivered.length === 1)
    clock.ms += 1_000
    await new Promise((resolve) => setTimeout(resolve, 100))
    // Without clearing `tracked` on a not_due/not_active outcome, the deadline stays in the past and
    // the dispatcher reschedules itself at 0 ms forever, spinning far past a handful of polls.
    expect(txCalls).toBeLessThan(30)
  })
})
