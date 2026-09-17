import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LIMITS,
  NOSTR,
  admitQuestion,
  approveRequest,
  claimDue,
  getInboxQuestion,
  markPublished,
  openStore,
  purgeInbox,
  recordIncomingRequest,
  rejectUnansweredFor,
  revokeInbound,
  type AdmissionInput,
  type Store,
} from '@agentbridge/core'
import { testIdentity } from './support/keys'

const responder = testIdentity(21)
const asker = testIdentity(22)
const stranger = testIdentity(23)
const T0 = 2_000_000_000
const RELAYS = ['wss://relay.example.com']
const hex = (n: number) => n.toString(16).padStart(64, '0')
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
let store: Store

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-inbox-')), 'home'))
})
afterEach(() => store.close())

function approveAsker(now = T0): void {
  recordIncomingRequest(store, { pubkey: asker.publicKey, requestId: uuid(9999), requestRumorId: hex(9999), declaredName: 'Beto', note: '', relays: RELAYS, now })
  approveRequest(store, { pubkey: asker.publicKey, now })
}

const question = (n: number, over: Partial<AdmissionInput> = {}): AdmissionInput => ({
  identity: responder,
  senderPubkey: asker.publicKey,
  questionId: uuid(n),
  rumorId: hex(100 + n),
  rumorCreatedAt: T0,
  generation: 1,
  text: `pregunta ${n}`,
  now: T0,
  ...over,
})

type OutboxView = { label: string; rumor_id: string; state: string; content: string }
const outbox = () =>
  store.db.prepare("SELECT label, rumor_id, state, json_extract(rumor_json, '$.content') AS content FROM outbox ORDER BY rowid").all() as OutboxView[]
const messages = () => outbox().map((row) => JSON.parse(row.content) as { type: string; questionId?: string; reason?: string })

describe('admitQuestion', () => {
  it('queues a new question from an approved contact and enqueues one receipt', () => {
    approveAsker()
    expect(admitQuestion(store, question(1))).toEqual({ kind: 'queued' })
    expect(getInboxQuestion(store, asker.publicKey, uuid(1))).toMatchObject({ state: 'queued', admitted: true, text: 'pregunta 1', decision: null })
    expect(outbox().map((r) => r.label)).toEqual(['receipt'])
    expect(messages()).toEqual([{ v: 1, type: 'receipt', questionId: uuid(1) }])
  })

  it('answers a retry with the same stored receipt rumor, within the regeneration limit', () => {
    approveAsker()
    admitQuestion(store, question(1))
    const [receipt] = outbox()
    expect(admitQuestion(store, question(1, { now: T0 + 60 }))).toEqual({ kind: 'regeneration_too_soon' })
    expect(outbox()).toHaveLength(1)
    const [claimed] = claimDue(store, { owner: 'o', now: T0, limit: 10, authorize: () => true })
    markPublished(store, { recipient: asker.publicKey, rumorId: claimed!.rumorId, owner: 'o', now: T0 })
    expect(admitQuestion(store, question(1, { now: T0 + NOSTR.regenerationIntervalSeconds }))).toEqual({ kind: 'regenerated' })
    expect(outbox()).toEqual([{ ...receipt!, state: 'pending' }])
  })

  it('keeps the regeneration limit even when its outbox rows were deleted', () => {
    approveAsker()
    admitQuestion(store, question(1))
    store.db.prepare('DELETE FROM outbox').run()
    expect(admitQuestion(store, question(1, { now: T0 + 60 }))).toEqual({ kind: 'regeneration_too_soon' })
    expect(outbox()).toEqual([])
    const later = T0 + NOSTR.regenerationIntervalSeconds
    expect(admitQuestion(store, question(1, { now: later }))).toEqual({ kind: 'regenerated' })
    expect(outbox().map((r) => r.label)).toEqual(['receipt'])
    store.db.prepare('DELETE FROM outbox').run()
    expect(admitQuestion(store, question(1, { now: later + 60 }))).toEqual({ kind: 'regeneration_too_soon' })
  })

  it('says so when nothing stored is left to resend', () => {
    approveAsker()
    admitQuestion(store, question(1))
    store.db.prepare('UPDATE inbox_questions SET receipt_rumor_json = NULL').run()
    expect(admitQuestion(store, question(1, { now: T0 + NOSTR.regenerationIntervalSeconds }))).toEqual({ kind: 'dropped', reason: 'purged' })
  })

  it('drops a different rumor that reuses a known question id', () => {
    approveAsker()
    admitQuestion(store, question(1))
    expect(admitQuestion(store, question(1, { rumorId: hex(555), text: 'otra' }))).toEqual({ kind: 'dropped', reason: 'conflict' })
    expect(getInboxQuestion(store, asker.publicKey, uuid(1))?.text).toBe('pregunta 1')
  })

  it('stores nothing for a sender who never had a relationship', () => {
    expect(admitQuestion(store, question(1, { senderPubkey: stranger.publicKey }))).toEqual({ kind: 'dropped', reason: 'unrelated' })
    recordIncomingRequest(store, { pubkey: stranger.publicKey, requestId: uuid(8888), requestRumorId: hex(8888), declaredName: 'X', note: '', relays: RELAYS, now: T0 })
    expect(admitQuestion(store, question(2, { senderPubkey: stranger.publicKey }))).toEqual({ kind: 'dropped', reason: 'unrelated' })
    expect(store.db.prepare('SELECT count(*) AS n FROM inbox_questions').get()?.n).toBe(0)
    expect(outbox()).toEqual([])
  })

  it('rejects a question for a generation that is not the current approval', () => {
    approveAsker()
    expect(admitQuestion(store, question(1, { generation: 2 }))).toEqual({ kind: 'rejected', reason: 'stale_generation' })
    expect(getInboxQuestion(store, asker.publicKey, uuid(1))).toMatchObject({ state: 'rejected', admitted: false, decision: 'rejected', rejectReason: 'stale_generation', text: null })
    expect(messages()).toEqual([{ v: 1, type: 'rejected', questionId: uuid(1), reason: 'stale_generation' }])
  })

  it('rejects an expired question', () => {
    approveAsker()
    const outcome = admitQuestion(store, question(1, { rumorCreatedAt: T0 - NOSTR.questionTtlSeconds }))
    expect(outcome).toEqual({ kind: 'rejected', reason: 'expired' })
  })

  it('rejects past five open questions and repeats that decision on a retry', () => {
    approveAsker()
    for (let n = 1; n <= LIMITS.maxOpenTicketsPerPair; n++) expect(admitQuestion(store, question(n))).toEqual({ kind: 'queued' })
    expect(admitQuestion(store, question(6))).toEqual({ kind: 'rejected', reason: 'limit' })
    store.db.prepare("UPDATE inbox_questions SET state = 'answered', decision = 'answer' WHERE question_id = ?").run(uuid(1))
    expect(admitQuestion(store, question(6, { now: T0 + NOSTR.regenerationIntervalSeconds }))).toEqual({ kind: 'regenerated' })
    expect(getInboxQuestion(store, asker.publicKey, uuid(6))?.rejectReason).toBe('limit')
  })

  it('rejects past twenty admitted questions in a day', () => {
    approveAsker()
    for (let n = 1; n <= LIMITS.maxTicketsPerPairPerDay; n++) {
      expect(admitQuestion(store, question(n))).toEqual({ kind: 'queued' })
      store.db.prepare("UPDATE inbox_questions SET state = 'answered', decision = 'answer' WHERE question_id = ?").run(uuid(n))
    }
    expect(admitQuestion(store, question(21))).toEqual({ kind: 'rejected', reason: 'limit' })
    expect(admitQuestion(store, question(22, { now: T0 + 86_400, rumorCreatedAt: T0 + 86_400 }))).toEqual({ kind: 'queued' })
  })

  it('after revocation, regenerates only a stored rejection and drops retries of answered questions', () => {
    approveAsker()
    admitQuestion(store, question(1))
    admitQuestion(store, question(2, { generation: 5 }))
    store.db.prepare("UPDATE inbox_questions SET state = 'answered', decision = 'answer', decision_rumor_json = '{}' WHERE question_id = ?").run(uuid(1))
    revokeInbound(store, { pubkey: asker.publicKey, now: T0 + 10 })
    expect(admitQuestion(store, question(1, { now: T0 + 20 }))).toEqual({ kind: 'dropped', reason: 'answered_after_revocation' })
    expect(admitQuestion(store, question(2, { generation: 5, now: T0 + NOSTR.regenerationIntervalSeconds }))).toEqual({ kind: 'regenerated' })
  })
})

describe('rejectUnansweredFor', () => {
  it('stores stale_generation on waiting questions without sending, and cancels the active attempt', () => {
    approveAsker()
    admitQuestion(store, question(1))
    admitQuestion(store, question(2))
    store.db.prepare("UPDATE inbox_questions SET state = 'dispatched' WHERE question_id = ?").run(uuid(2))
    store.db
      .prepare("INSERT INTO attempts (attempt_id, sender_pubkey, question_id, code, epoch, deadline_ms, state, created_at) VALUES ('att', ?, ?, 'ABCD', 1, 0, 'active', ?)")
      .run(asker.publicKey, uuid(2), T0)
    const before = outbox().length
    expect(rejectUnansweredFor(store, { identity: responder, senderPubkey: asker.publicKey, now: T0 + 5 })).toBe(2)
    for (const n of [1, 2]) {
      expect(getInboxQuestion(store, asker.publicKey, uuid(n))).toMatchObject({ state: 'rejected', decision: 'rejected', rejectReason: 'stale_generation' })
    }
    expect(outbox()).toHaveLength(before)
    expect(store.db.prepare("SELECT state, cancel_reason FROM attempts WHERE attempt_id = 'att'").get()).toEqual({ state: 'cancelled', cancel_reason: 'revoked' })
  })
})

describe('purgeInbox', () => {
  it('clears content at 7 days but keeps decisions, which are still resent until they are forgotten at 9', () => {
    approveAsker()
    admitQuestion(store, question(1))
    admitQuestion(store, question(2, { generation: 5 }))
    const sevenDays = T0 + NOSTR.contentRetentionSeconds
    expect(purgeInbox(store, sevenDays - 1)).toEqual({ rejectedWaiting: 0, contentCleared: 0, forgotten: 0 })
    expect(purgeInbox(store, sevenDays)).toEqual({ rejectedWaiting: 1, contentCleared: 1, forgotten: 0 })
    expect(getInboxQuestion(store, asker.publicKey, uuid(1))).toMatchObject({ state: 'rejected', rejectReason: 'unanswered', text: null })
    store.db.prepare('DELETE FROM outbox').run()
    expect(admitQuestion(store, question(2, { generation: 5, now: sevenDays + 1 }))).toEqual({ kind: 'regenerated' })
    expect(messages()).toEqual([{ v: 1, type: 'rejected', questionId: uuid(2), reason: 'stale_generation' }])
    expect(purgeInbox(store, T0 + NOSTR.decisionRetentionSeconds)).toEqual({ rejectedWaiting: 0, contentCleared: 0, forgotten: 2 })
    expect(getInboxQuestion(store, asker.publicKey, uuid(1))).toBeNull()
  })
})
