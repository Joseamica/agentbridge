import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LIMITS,
  MAX_EXPIRED_ATTEMPTS,
  acquireChannelLock,
  admitQuestion,
  answerQuestion,
  approveRequest,
  expireAttempt,
  getAttemptState,
  getInboxQuestion,
  normalizeCode,
  openStore,
  recordIncomingRequest,
  rejectUnansweredFor,
  reserveNextQuestion,
  revokeInbound,
  type AnswerInput,
  type Store,
} from '@agentbridge/core'
import { testIdentity } from './support/keys'

const responder = testIdentity(31)
const asker = testIdentity(32)
const T0 = 2_000_000_000
const T0_MS = T0 * 1000
const TIMEOUT = LIMITS.attemptTimeoutMs
const hex = (n: number) => n.toString(16).padStart(64, '0')
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
let store: Store
let epoch: number

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-dispatch-')), 'home'))
  const lock = acquireChannelLock(store, { self: { pid: 1, start: 'test' }, isAlive: () => false, now: T0 })
  if (lock.kind !== 'acquired') throw new Error('lock not acquired')
  epoch = lock.epoch
  recordIncomingRequest(store, { pubkey: asker.publicKey, requestId: uuid(9000), requestRumorId: hex(9000), declaredName: 'Beto Díaz', note: '', relays: ['wss://relay.example.com'], now: T0 })
  approveRequest(store, { pubkey: asker.publicKey, now: T0 })
})
afterEach(() => store.close())

const admit = (n: number, now = T0) =>
  admitQuestion(store, { identity: responder, senderPubkey: asker.publicKey, questionId: uuid(n), rumorId: hex(100 + n), rumorCreatedAt: now, generation: 1, text: `pregunta ${n}`, now })

let codes = ['AAAA', 'BBBB', 'CCCC', 'DDDD']
const reserve = (nowMs = T0_MS) =>
  reserveNextQuestion(store, { epoch, nowMs, attemptTimeoutMs: TIMEOUT, identity: responder, newCode: () => codes.shift() ?? 'ZZZZ' })

const answer = (over: Partial<AnswerInput> = {}) =>
  answerQuestion(store, { epoch, code: 'AAAA', nowMs: T0_MS + 1000, identity: responder, text: 'El viernes.', source: 'plan.md', confidence: 'seguro', ...over })

const outboxLabels = () => (store.db.prepare('SELECT label FROM outbox ORDER BY rowid').all() as Array<{ label: string }>).map((r) => r.label)

beforeEach(() => {
  codes = ['AAAA', 'BBBB', 'CCCC', 'DDDD']
})

describe('reserveNextQuestion', () => {
  it('reserves the oldest queued question and stays busy while it is active', () => {
    admit(1, T0)
    admit(2, T0 + 1)
    const reserved = reserve()
    expect(reserved).toMatchObject({
      kind: 'reserved',
      attempt: { code: 'AAAA', senderPubkey: asker.publicKey, questionId: uuid(1), fromName: 'beto-diaz', text: 'pregunta 1', deadlineMs: T0_MS + TIMEOUT, epoch },
    })
    expect(getInboxQuestion(store, asker.publicKey, uuid(1))?.state).toBe('dispatched')
    expect(reserve()).toEqual({ kind: 'busy' })
  })

  it('never reuses a code, even after the question that used it was purged', () => {
    admit(1)
    const first = reserveNextQuestion(store, { epoch, nowMs: T0_MS, attemptTimeoutMs: TIMEOUT, identity: responder, newCode: () => 'AAAA' })
    if (first.kind !== 'reserved') throw new Error('expected a reservation')
    answer({ code: 'AAAA' })
    store.db.prepare('DELETE FROM inbox_questions').run()
    admit(2, T0 + 1)
    const draws = ['AAAA', 'CCCC']
    const second = reserveNextQuestion(store, { epoch, nowMs: T0_MS, attemptTimeoutMs: TIMEOUT, identity: responder, newCode: () => draws.shift() ?? 'ZZZZ' })
    expect(second).toMatchObject({ kind: 'reserved', attempt: { code: 'CCCC' } })
    expect(answer({ code: 'AAAA' })).toEqual({ kind: 'wrong_code', activeCode: 'CCCC' })
  })

  it('never reuses a code an earlier attempt still holds', () => {
    admit(1)
    admit(2, T0 + 1)
    const draws = ['AAAA', 'AAAA', 'BBBB']
    const reserveWith = () =>
      reserveNextQuestion(store, { epoch, nowMs: T0_MS, attemptTimeoutMs: TIMEOUT, identity: responder, newCode: () => draws.shift() ?? 'ZZZZ' })
    const first = reserveWith()
    if (first.kind !== 'reserved') throw new Error('expected a reservation')
    expect(answer({ code: first.attempt.code })).toMatchObject({ kind: 'answered' })
    const second = reserveWith()
    expect(second).toMatchObject({ kind: 'reserved', attempt: { code: 'BBBB', questionId: uuid(2) } })
    expect(answer({ code: 'AAAA' })).toEqual({ kind: 'wrong_code', activeCode: 'BBBB' })
  })

  it('reports an empty queue', () => {
    expect(reserve()).toEqual({ kind: 'empty' })
  })

  it('is fenced once another channel took the lock', () => {
    admit(1)
    acquireChannelLock(store, { self: { pid: 2, start: 'other' }, isAlive: () => false, now: T0 + 1 })
    expect(reserve()).toEqual({ kind: 'fenced' })
    expect(getInboxQuestion(store, asker.publicKey, uuid(1))?.state).toBe('queued')
  })

  it('never hands Claude a question whose permission changed without a revocation transaction', () => {
    admit(1)
    store.db.prepare("UPDATE contacts SET state = 'revoked', generation = 2 WHERE pubkey = ?").run(asker.publicKey)
    expect(reserve()).toEqual({ kind: 'empty' })
    expect(getInboxQuestion(store, asker.publicKey, uuid(1))).toMatchObject({ state: 'rejected', rejectReason: 'stale_generation' })
    expect(outboxLabels()).toEqual(['receipt'])
  })

  it('gives up after 50 draws that all collide with an already-used code', () => {
    admit(1)
    const first = reserveNextQuestion(store, { epoch, nowMs: T0_MS, attemptTimeoutMs: TIMEOUT, identity: responder, newCode: () => 'AAAA' })
    if (first.kind !== 'reserved') throw new Error('expected a reservation')
    answer({ code: 'AAAA' })
    admit(2, T0 + 1)
    expect(() =>
      reserveNextQuestion(store, { epoch, nowMs: T0_MS, attemptTimeoutMs: TIMEOUT, identity: responder, newCode: () => 'AAAA' }),
    ).toThrow('dispatch: could not draw an unused question code')
  })
})

describe('getAttemptState', () => {
  it('returns null for an attempt id that does not exist', () => {
    expect(getAttemptState(store, uuid(9999))).toBeNull()
  })
})

describe('expireAttempt', () => {
  it('requeues after the deadline and rejects as unanswered after the second expiry', () => {
    admit(1)
    const first = reserve()
    if (first.kind !== 'reserved') throw new Error('expected a reservation')
    expect(expireAttempt(store, { epoch, attemptId: first.attempt.attemptId, nowMs: T0_MS + TIMEOUT - 1, identity: responder })).toEqual({ kind: 'not_due' })
    expect(expireAttempt(store, { epoch, attemptId: first.attempt.attemptId, nowMs: T0_MS + TIMEOUT, identity: responder })).toEqual({ kind: 'requeued' })
    expect(getAttemptState(store, first.attempt.attemptId)).toEqual({ state: 'expired', cancelReason: null })
    expect(getInboxQuestion(store, asker.publicKey, uuid(1))).toMatchObject({ state: 'queued', expiredAttempts: 1 })

    const second = reserve(T0_MS + TIMEOUT)
    if (second.kind !== 'reserved') throw new Error('expected a second reservation')
    expect(second.attempt.code).toBe('BBBB')
    expect(expireAttempt(store, { epoch, attemptId: second.attempt.attemptId, nowMs: T0_MS + 2 * TIMEOUT, identity: responder })).toEqual({ kind: 'rejected_unanswered' })
    expect(getInboxQuestion(store, asker.publicKey, uuid(1))).toMatchObject({ state: 'rejected', rejectReason: 'unanswered', expiredAttempts: MAX_EXPIRED_ATTEMPTS })
    expect(outboxLabels()).toEqual(['receipt', 'rejected:unanswered'])
    expect(expireAttempt(store, { epoch, attemptId: second.attempt.attemptId, nowMs: T0_MS + 3 * TIMEOUT, identity: responder })).toEqual({ kind: 'not_active' })
  })

  it('is fenced for a stale epoch', () => {
    admit(1)
    const first = reserve()
    if (first.kind !== 'reserved') throw new Error('expected a reservation')
    expect(expireAttempt(store, { epoch: epoch + 1, attemptId: first.attempt.attemptId, nowMs: T0_MS + TIMEOUT, identity: responder })).toEqual({ kind: 'fenced' })
  })
})

describe('answerQuestion', () => {
  it('stores the answer, marks the question answered and enqueues it', () => {
    admit(1)
    reserve()
    expect(answer({ code: ' aaaa ' })).toEqual({ kind: 'answered', fromName: 'beto-diaz', code: 'AAAA' })
    expect(getInboxQuestion(store, asker.publicKey, uuid(1))).toMatchObject({ state: 'answered', decision: 'answer' })
    expect(outboxLabels()).toEqual(['receipt', 'answer'])
    const content = store.db.prepare("SELECT json_extract(rumor_json, '$.content') AS c FROM outbox WHERE label = 'answer'").get()?.c as string
    expect(JSON.parse(content)).toEqual({ v: 1, type: 'answer', questionId: uuid(1), text: 'El viernes.', source: 'plan.md', confidence: 'seguro' })
    expect(answer()).toEqual({ kind: 'no_active' })
  })

  it('names the active code when the code is wrong', () => {
    admit(1)
    reserve()
    expect(answer({ code: 'XXXX' })).toEqual({ kind: 'wrong_code', activeCode: 'AAAA' })
  })

  it('reports an expired attempt’s code as cancelled', () => {
    admit(1)
    const first = reserve()
    if (first.kind !== 'reserved') throw new Error('expected a reservation')
    expireAttempt(store, { epoch, attemptId: first.attempt.attemptId, nowMs: T0_MS + TIMEOUT, identity: responder })
    expect(answer({ nowMs: T0_MS + TIMEOUT })).toEqual({ kind: 'cancelled', activeCode: null })
    reserve(T0_MS + TIMEOUT)
    expect(answer({ nowMs: T0_MS + TIMEOUT + 1 })).toEqual({ kind: 'cancelled', activeCode: 'BBBB' })
  })

  it('refuses a late answer without storing it', () => {
    admit(1)
    reserve()
    expect(answer({ nowMs: T0_MS + TIMEOUT })).toEqual({ kind: 'late' })
    expect(getInboxQuestion(store, asker.publicKey, uuid(1))?.state).toBe('dispatched')
  })

  it('refuses once the contact lost permission', () => {
    admit(1)
    reserve()
    revokeInbound(store, { pubkey: asker.publicKey, now: T0 + 1 })
    expect(answer()).toEqual({ kind: 'revoked' })
    expect(outboxLabels()).toEqual(['receipt'])
  })

  it('reports a revoked attempt’s code as cancelled after the revocation transaction', () => {
    admit(1)
    reserve()
    revokeInbound(store, { pubkey: asker.publicKey, now: T0 + 1 })
    rejectUnansweredFor(store, { identity: responder, senderPubkey: asker.publicKey, now: T0 + 1 })
    expect(answer()).toEqual({ kind: 'cancelled', activeCode: null })
  })

  it('refuses an answer too large to send', () => {
    admit(1)
    reserve()
    expect(answer({ text: 'x'.repeat(LIMITS.answerMaxChars + 1) })).toEqual({ kind: 'too_large' })
    expect(getInboxQuestion(store, asker.publicKey, uuid(1))?.state).toBe('dispatched')
  })

  it('is fenced for a stale epoch', () => {
    admit(1)
    reserve()
    expect(answer({ epoch: epoch + 1 })).toEqual({ kind: 'fenced' })
  })
})

describe('normalizeCode', () => {
  it('trims and upper-cases a code, so the channel and the store can never drift on the same code', () => {
    expect(normalizeCode(' abcd ')).toBe('ABCD')
  })
})
