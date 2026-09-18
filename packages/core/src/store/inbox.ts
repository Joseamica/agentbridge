import { createRumor, type Rumor } from '../envelope/seal'
import { isQuestionExpired } from '../envelope/time'
import type { Identity } from '../identity'
import { NOSTR } from '../nostr-constants'
import { LIMITS } from '../protocol'
import { getContact } from './contacts'
import type { Store } from './db'
import { enqueue, type EnqueueOutcome } from './outbox'

export type InboxState = 'queued' | 'dispatched' | 'answered' | 'rejected'
export type RejectReason = 'expired' | 'limit' | 'unanswered' | 'stale_generation'

export type InboxQuestion = {
  senderPubkey: string
  questionId: string
  rumorId: string
  rumorCreatedAt: number
  generation: number
  text: string | null
  state: InboxState
  admitted: boolean
  decision: 'answer' | 'rejected' | null
  rejectReason: RejectReason | null
  expiredAttempts: number
  receivedAt: number
  decidedAt: number | null
}

export type AdmissionInput = {
  identity: Identity
  senderPubkey: string
  questionId: string
  rumorId: string
  rumorCreatedAt: number
  generation: number
  text: string
  now: number
}

export type AdmissionOutcome =
  | { kind: 'queued' }
  | { kind: 'rejected'; reason: RejectReason }
  | { kind: 'regenerated' }
  | { kind: 'regeneration_too_soon' }
  | { kind: 'dropped'; reason: 'unrelated' | 'conflict' | 'answered_after_revocation' | 'no_relays' | 'purged' | 'abandoned' }

type InboxRow = {
  sender_pubkey: string
  question_id: string
  rumor_id: string
  rumor_created_at: number
  generation: number
  text: string | null
  state: InboxState
  admitted: 0 | 1
  receipt_rumor_json: string | null
  decision: 'answer' | 'rejected' | null
  reject_reason: RejectReason | null
  decision_rumor_json: string | null
  expired_attempts: number
  received_at: number
  regenerated_at: number | null
  decided_at: number | null
  updated_at: number
}

const DAY_SECONDS = 86_400

const selectRow = (store: Store, sender: string, questionId: string) =>
  store.db.prepare('SELECT * FROM inbox_questions WHERE sender_pubkey = ? AND question_id = ?').get(sender, questionId) as InboxRow | undefined

const toQuestion = (row: InboxRow): InboxQuestion => ({
  senderPubkey: row.sender_pubkey,
  questionId: row.question_id,
  rumorId: row.rumor_id,
  rumorCreatedAt: row.rumor_created_at,
  generation: row.generation,
  text: row.text,
  state: row.state,
  admitted: row.admitted === 1,
  decision: row.decision,
  rejectReason: row.reject_reason,
  expiredAttempts: row.expired_attempts,
  receivedAt: row.received_at,
  decidedAt: row.decided_at,
})

const decisionLabel = (row: Pick<InboxRow, 'decision' | 'reject_reason'>) => (row.decision === 'answer' ? 'answer' : `rejected:${row.reject_reason ?? 'unknown'}`)

export function getInboxQuestion(store: Store, senderPubkey: string, questionId: string): InboxQuestion | null {
  const row = selectRow(store, senderPubkey, questionId)
  return row ? toQuestion(row) : null
}

// Stored response rumors are resent unchanged, so the asker recognizes a repeat by its rumor id.
// Nothing is sent without relays (a contact that never gave usable ones) or once the rumor was purged
// — that case, and any other reason enqueue itself declined the rumor, is reported as 'nothing' so a
// caller can tell "nothing to send" apart from "the outbox refused it."
function resend(store: Store, input: { recipient: string; relays: readonly string[]; rumorJson: string | null; label: string; now: number }): EnqueueOutcome | 'nothing' {
  if (input.rumorJson === null || input.relays.length === 0) return 'nothing'
  return enqueue(store, {
    recipient: input.recipient,
    rumor: JSON.parse(input.rumorJson) as Rumor,
    label: input.label,
    powBits: 16,
    relays: input.relays,
    policy: 'once',
    now: input.now,
  })
}

// Of everything enqueue can answer, only these outcomes mean the outbox now actually holds the rumor
// to send. 'abandoned' (the row was written off, e.g. an unauthorized retry) and
// 'regeneration_too_soon' (the outbox's own clock, distinct from the question's) do not.
// 'already_pending' counts as sent here, and the caller below advances the question's own
// regeneration clock on it: the gate that decides whether to attempt a resend at all already runs
// before resend() is ever called (the `regenerated_at` check further down), so by the time an
// outcome comes back the interval has already elapsed, and a send still in flight reaches the asker
// just as much as a fresh one — there is no separate "still pending" outcome for admitQuestion to
// report. `regenerateRequestDecision` in responder/connections.ts makes the opposite call on the
// same 'already_pending' outcome, deliberately: it leaves its own resend clock (`decision_resent_at`)
// untouched, because that clock's only job is to record the last time something actually changed,
// and a row still waiting behind a slow relay is not that.
const SENT_OUTCOMES: ReadonlySet<EnqueueOutcome> = new Set(['enqueued', 'postponed_cap', 'regenerated', 'already_pending'])
const wasSent = (outcome: EnqueueOutcome | 'nothing'): boolean => outcome !== 'nothing' && SENT_OUTCOMES.has(outcome)

export function rejectQuestion(
  store: Store,
  input: { identity: Identity; senderPubkey: string; questionId: string; reason: RejectReason; now: number; send: boolean },
): boolean {
  return store.tx(() => {
    const row = selectRow(store, input.senderPubkey, input.questionId)
    if (!row || row.decision !== null) return false
    const rumor = createRumor({ v: 1, type: 'rejected', questionId: input.questionId, reason: input.reason }, input.identity, input.now)
    const rumorJson = JSON.stringify(rumor)
    store.db
      .prepare(
        `UPDATE inbox_questions SET state = 'rejected', decision = 'rejected', reject_reason = ?, decision_rumor_json = ?, decided_at = ?, updated_at = ?
         WHERE sender_pubkey = ? AND question_id = ?`,
      )
      .run(input.reason, rumorJson, input.now, input.now, input.senderPubkey, input.questionId)
    const cancelReason = input.reason === 'unanswered' && !input.send ? 'purged' : 'revoked'
    store.db
      .prepare("UPDATE attempts SET state = 'cancelled', cancel_reason = ?, ended_at = ? WHERE sender_pubkey = ? AND question_id = ? AND state = 'active'")
      .run(cancelReason, input.now, input.senderPubkey, input.questionId)
    if (input.send) {
      const contact = getContact(store, input.senderPubkey, 'inbound')
      resend(store, { recipient: input.senderPubkey, relays: contact?.relays ?? [], rumorJson, label: `rejected:${input.reason}`, now: input.now })
    }
    return true
  })
}

function insertRejected(store: Store, input: AdmissionInput, reason: RejectReason, relays: readonly string[]): AdmissionOutcome {
  const rumor = createRumor({ v: 1, type: 'rejected', questionId: input.questionId, reason }, input.identity, input.now)
  const rumorJson = JSON.stringify(rumor)
  store.db
    .prepare(
      `INSERT INTO inbox_questions (sender_pubkey, question_id, rumor_id, rumor_created_at, generation, text, state, admitted,
         decision, reject_reason, decision_rumor_json, received_at, decided_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'rejected', 0, 'rejected', ?, ?, ?, ?, ?)`,
    )
    .run(input.senderPubkey, input.questionId, input.rumorId, input.rumorCreatedAt, input.generation, reason, rumorJson, input.now, input.now, input.now)
  resend(store, { recipient: input.senderPubkey, relays, rumorJson, label: `rejected:${reason}`, now: input.now })
  return { kind: 'rejected', reason }
}

export function admitQuestion(store: Store, input: AdmissionInput): AdmissionOutcome {
  return store.tx((): AdmissionOutcome => {
    const contact = getContact(store, input.senderPubkey, 'inbound')
    const existing = selectRow(store, input.senderPubkey, input.questionId)

    if (existing) {
      if (existing.rumor_id !== input.rumorId) return { kind: 'dropped', reason: 'conflict' }
      const relays = contact?.relays ?? []
      const stillAllowed = contact?.state === 'approved' && contact.generation === existing.generation
      if (!stillAllowed && existing.decision === 'answer') return { kind: 'dropped', reason: 'answered_after_revocation' }
      // The regeneration clock lives on the question: revocation and the 7-day outbox purge delete
      // outbox rows, and with them the outbox's own regeneration limit.
      if (input.now - (existing.regenerated_at ?? existing.received_at) < NOSTR.regenerationIntervalSeconds) {
        return { kind: 'regeneration_too_soon' }
      }
      // Revocation decides every unanswered question in its own transaction; this only covers a
      // contact whose permission changed some other way.
      if (!stillAllowed && existing.decision === null) {
        rejectQuestion(store, { identity: input.identity, senderPubkey: input.senderPubkey, questionId: input.questionId, reason: 'stale_generation', now: input.now, send: false })
      }
      const current = selectRow(store, input.senderPubkey, input.questionId)!
      const receiptOutcome: EnqueueOutcome | 'nothing' = stillAllowed
        ? resend(store, { recipient: input.senderPubkey, relays, rumorJson: current.receipt_rumor_json, label: 'receipt', now: input.now })
        : 'nothing'
      const decisionOutcome = resend(store, { recipient: input.senderPubkey, relays, rumorJson: current.decision_rumor_json, label: decisionLabel(current), now: input.now })
      if (!wasSent(receiptOutcome) && !wasSent(decisionOutcome)) {
        if (receiptOutcome === 'nothing' && decisionOutcome === 'nothing') return { kind: 'dropped', reason: 'purged' }
        if (receiptOutcome === 'regeneration_too_soon' || decisionOutcome === 'regeneration_too_soon') return { kind: 'regeneration_too_soon' }
        return { kind: 'dropped', reason: 'abandoned' }
      }
      store.db
        .prepare('UPDATE inbox_questions SET regenerated_at = ?, updated_at = ? WHERE sender_pubkey = ? AND question_id = ?')
        .run(input.now, input.now, input.senderPubkey, input.questionId)
      return { kind: 'regenerated' }
    }

    if (!contact || contact.generation === 0) return { kind: 'dropped', reason: 'unrelated' }
    if (contact.relays.length === 0) return { kind: 'dropped', reason: 'no_relays' }
    if (!(contact.state === 'approved' && contact.generation === input.generation)) return insertRejected(store, input, 'stale_generation', contact.relays)
    if (isQuestionExpired(input.rumorCreatedAt, input.now)) return insertRejected(store, input, 'expired', contact.relays)

    const open = Number(
      store.db.prepare("SELECT count(*) AS n FROM inbox_questions WHERE sender_pubkey = ? AND state IN ('queued', 'dispatched')").get(input.senderPubkey)?.n ?? 0,
    )
    const today = Number(
      store.db
        .prepare('SELECT count(*) AS n FROM inbox_questions WHERE sender_pubkey = ? AND admitted = 1 AND received_at > ?')
        .get(input.senderPubkey, input.now - DAY_SECONDS)?.n ?? 0,
    )
    if (open >= LIMITS.maxOpenTicketsPerPair || today >= LIMITS.maxTicketsPerPairPerDay) return insertRejected(store, input, 'limit', contact.relays)

    const receipt = createRumor({ v: 1, type: 'receipt', questionId: input.questionId }, input.identity, input.now)
    const receiptJson = JSON.stringify(receipt)
    store.db
      .prepare(
        `INSERT INTO inbox_questions (sender_pubkey, question_id, rumor_id, rumor_created_at, generation, text, state, admitted,
           receipt_rumor_json, received_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, ?)`,
      )
      .run(input.senderPubkey, input.questionId, input.rumorId, input.rumorCreatedAt, input.generation, input.text, receiptJson, input.now, input.now)
    resend(store, { recipient: input.senderPubkey, relays: contact.relays, rumorJson: receiptJson, label: 'receipt', now: input.now })
    return { kind: 'queued' }
  })
}

export function rejectUnansweredFor(store: Store, input: { identity: Identity; senderPubkey: string; now: number }): number {
  return store.tx(() => {
    const waiting = store.db
      .prepare("SELECT question_id FROM inbox_questions WHERE sender_pubkey = ? AND state IN ('queued', 'dispatched') ORDER BY received_at")
      .all(input.senderPubkey) as Array<{ question_id: string }>
    for (const { question_id } of waiting) {
      rejectQuestion(store, { identity: input.identity, senderPubkey: input.senderPubkey, questionId: question_id, reason: 'stale_generation', now: input.now, send: false })
    }
    return waiting.length
  })
}

// Content (question text and answer rumors) follows the 7-day retention by the question's own date. A
// question still waiting then can never be answered, so it is closed as unanswered — through
// rejectQuestion, so that decision keeps its own stored rumor and can still be resent later, the same
// as any other rejection, right up to the 9-day forgetting below. rejectQuestion also cancels the
// active attempt (as 'purged', since send is false), so there is nothing left to do for it here.
// Receipts and rejections are decisions, not content: they stay, and can still be resent, until the
// row is forgotten after 9 days.
export function purgeInbox(store: Store, input: { identity: Identity; now: number }): { rejectedWaiting: number; contentCleared: number; forgotten: number } {
  return store.tx(() => {
    const { identity, now } = input
    const contentHorizon = now - NOSTR.contentRetentionSeconds
    const waiting = store.db
      .prepare("SELECT sender_pubkey, question_id FROM inbox_questions WHERE state IN ('queued', 'dispatched') AND rumor_created_at <= ?")
      .all(contentHorizon) as Array<{ sender_pubkey: string; question_id: string }>
    let rejectedWaiting = 0
    for (const { sender_pubkey, question_id } of waiting) {
      const closed = rejectQuestion(store, { identity, senderPubkey: sender_pubkey, questionId: question_id, reason: 'unanswered', now, send: false })
      if (closed) rejectedWaiting++
    }
    const contentCleared = store.db
      .prepare(
        `UPDATE inbox_questions
           SET text = NULL, decision_rumor_json = CASE WHEN decision = 'answer' THEN NULL ELSE decision_rumor_json END, updated_at = ?
         WHERE rumor_created_at <= ? AND (text IS NOT NULL OR (decision = 'answer' AND decision_rumor_json IS NOT NULL))`,
      )
      .run(now, contentHorizon)
    const forgotten = store.db.prepare('DELETE FROM inbox_questions WHERE rumor_created_at <= ?').run(now - NOSTR.decisionRetentionSeconds)
    return { rejectedWaiting, contentCleared: Number(contentCleared.changes), forgotten: Number(forgotten.changes) }
  })
}
