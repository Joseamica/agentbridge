import { randomUUID } from 'node:crypto'
import { EnvelopeSizeError, createRumor, type Rumor } from '../envelope/seal'
import type { Identity } from '../identity'
import type { Confidence } from '../protocol'
import { newQuestionCode } from '../secrets'
import { verifyChannelLock } from './channel-lock'
import { getContact, type Contact } from './contacts'
import type { Store } from './db'
import { rejectQuestion } from './inbox'
import { enqueue } from './outbox'

export const MAX_EXPIRED_ATTEMPTS = 2

export type ActiveAttempt = {
  attemptId: string
  code: string
  senderPubkey: string
  questionId: string
  fromName: string
  text: string
  deadlineMs: number
  epoch: number
}
export type AttemptState = 'active' | 'answered' | 'expired' | 'cancelled'
export type AttemptCancelReason = 'revoked' | 'recovered' | 'purged'
export type ReserveOutcome = { kind: 'reserved'; attempt: ActiveAttempt } | { kind: 'busy' } | { kind: 'empty' } | { kind: 'fenced' }
export type ExpireOutcome = { kind: 'requeued' } | { kind: 'rejected_unanswered' } | { kind: 'not_due' } | { kind: 'not_active' } | { kind: 'fenced' }
export type AnswerInput = { epoch: number; code: string; nowMs: number; identity: Identity; text: string; source: string; confidence: Confidence }
export type AnswerOutcome =
  | { kind: 'answered'; fromName: string; code: string }
  | { kind: 'no_active' }
  | { kind: 'wrong_code'; activeCode: string }
  | { kind: 'cancelled'; activeCode: string | null }
  | { kind: 'late' }
  | { kind: 'revoked' }
  | { kind: 'too_large' }
  | { kind: 'fenced' }

type AttemptRow = {
  attempt_id: string
  sender_pubkey: string
  question_id: string
  code: string
  epoch: number
  deadline_ms: number
  state: AttemptState
  cancel_reason: AttemptCancelReason | null
}

const seconds = (ms: number) => Math.floor(ms / 1000)
// Shared with the channel, which echoes a typed code back in its Spanish tool text: the same
// normalization on both sides means an answer's code and the store's own match can never drift.
export const normalizeCode = (code: string) => code.trim().toUpperCase()
const displayName = (contact: Contact) => contact.localName ?? contact.declaredName ?? 'contacto'
const isCurrent = (contact: Contact | null, generation: number): contact is Contact => contact?.state === 'approved' && contact.generation === generation

const activeAttempt = (store: Store) => store.db.prepare("SELECT * FROM attempts WHERE state = 'active' LIMIT 1").get() as AttemptRow | undefined

export function reserveNextQuestion(
  store: Store,
  input: { epoch: number; nowMs: number; attemptTimeoutMs: number; identity: Identity; newCode?: () => string; newAttemptId?: () => string },
): ReserveOutcome {
  const now = seconds(input.nowMs)
  return store.tx((): ReserveOutcome => {
    if (!verifyChannelLock(store, input.epoch)) return { kind: 'fenced' }
    if (activeAttempt(store)) return { kind: 'busy' }
    const queued = store.db
      .prepare("SELECT sender_pubkey, question_id, generation, text FROM inbox_questions WHERE state = 'queued' AND text IS NOT NULL ORDER BY received_at, rowid")
      .all() as Array<{ sender_pubkey: string; question_id: string; generation: number; text: string }>
    for (const question of queued) {
      const contact = getContact(store, question.sender_pubkey, 'inbound')
      if (!isCurrent(contact, question.generation)) {
        rejectQuestion(store, { identity: input.identity, senderPubkey: question.sender_pubkey, questionId: question.question_id, reason: 'stale_generation', now, send: false })
        continue
      }
      const attemptId = (input.newAttemptId ?? randomUUID)()
      // question_codes is never purged: a code handed out once is never handed out again, so a late
      // reply meant for an older question (even one purged long ago) can never match a newer one.
      const draw = input.newCode ?? newQuestionCode
      const codeTaken = store.db.prepare('SELECT 1 FROM question_codes WHERE code = ?')
      let code = draw()
      for (let tries = 1; codeTaken.get(code) !== undefined; tries++) {
        if (tries >= 50) throw new Error('dispatch: could not draw an unused question code')
        code = draw()
      }
      store.db.prepare('INSERT INTO question_codes (code, first_used_at) VALUES (?, ?)').run(code, now)
      const deadlineMs = input.nowMs + input.attemptTimeoutMs
      store.db
        .prepare(
          "INSERT INTO attempts (attempt_id, sender_pubkey, question_id, code, epoch, deadline_ms, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
        )
        .run(attemptId, question.sender_pubkey, question.question_id, code, input.epoch, deadlineMs, now)
      store.db
        .prepare("UPDATE inbox_questions SET state = 'dispatched', updated_at = ? WHERE sender_pubkey = ? AND question_id = ?")
        .run(now, question.sender_pubkey, question.question_id)
      return {
        kind: 'reserved',
        attempt: {
          attemptId,
          code,
          senderPubkey: question.sender_pubkey,
          questionId: question.question_id,
          fromName: displayName(contact),
          text: question.text,
          deadlineMs,
          epoch: input.epoch,
        },
      }
    }
    return { kind: 'empty' }
  })
}

export function getAttemptState(store: Store, attemptId: string): { state: AttemptState; cancelReason: AttemptCancelReason | null } | null {
  const row = store.db.prepare('SELECT state, cancel_reason FROM attempts WHERE attempt_id = ?').get(attemptId) as
    | Pick<AttemptRow, 'state' | 'cancel_reason'>
    | undefined
  return row ? { state: row.state, cancelReason: row.cancel_reason } : null
}

export function expireAttempt(store: Store, input: { epoch: number; attemptId: string; nowMs: number; identity: Identity }): ExpireOutcome {
  const now = seconds(input.nowMs)
  return store.tx((): ExpireOutcome => {
    if (!verifyChannelLock(store, input.epoch)) return { kind: 'fenced' }
    const attempt = store.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(input.attemptId) as AttemptRow | undefined
    if (attempt?.state !== 'active') return { kind: 'not_active' }
    if (attempt.deadline_ms > input.nowMs) return { kind: 'not_due' }
    store.db.prepare("UPDATE attempts SET state = 'expired', ended_at = ? WHERE attempt_id = ?").run(now, attempt.attempt_id)
    store.db
      .prepare('UPDATE inbox_questions SET expired_attempts = expired_attempts + 1, updated_at = ? WHERE sender_pubkey = ? AND question_id = ?')
      .run(now, attempt.sender_pubkey, attempt.question_id)
    const expired = Number(
      store.db
        .prepare('SELECT expired_attempts AS n FROM inbox_questions WHERE sender_pubkey = ? AND question_id = ?')
        .get(attempt.sender_pubkey, attempt.question_id)?.n ?? 0,
    )
    if (expired >= MAX_EXPIRED_ATTEMPTS) {
      rejectQuestion(store, { identity: input.identity, senderPubkey: attempt.sender_pubkey, questionId: attempt.question_id, reason: 'unanswered', now, send: true })
      return { kind: 'rejected_unanswered' }
    }
    store.db
      .prepare("UPDATE inbox_questions SET state = 'queued', updated_at = ? WHERE sender_pubkey = ? AND question_id = ? AND state = 'dispatched'")
      .run(now, attempt.sender_pubkey, attempt.question_id)
    return { kind: 'requeued' }
  })
}

export function answerQuestion(store: Store, input: AnswerInput): AnswerOutcome {
  const now = seconds(input.nowMs)
  const code = normalizeCode(input.code)
  return store.tx((): AnswerOutcome => {
    if (!verifyChannelLock(store, input.epoch)) return { kind: 'fenced' }
    const endedWithCode = () =>
      store.db.prepare("SELECT 1 FROM attempts WHERE code = ? AND state IN ('expired', 'cancelled') LIMIT 1").get(code) !== undefined
    const active = activeAttempt(store)
    if (!active) return endedWithCode() ? { kind: 'cancelled', activeCode: null } : { kind: 'no_active' }
    if (active.code !== code) return endedWithCode() ? { kind: 'cancelled', activeCode: active.code } : { kind: 'wrong_code', activeCode: active.code }
    if (active.deadline_ms <= input.nowMs) return { kind: 'late' }
    const question = store.db
      .prepare('SELECT generation FROM inbox_questions WHERE sender_pubkey = ? AND question_id = ?')
      .get(active.sender_pubkey, active.question_id) as { generation: number } | undefined
    const contact = getContact(store, active.sender_pubkey, 'inbound')
    if (!question || !isCurrent(contact, question.generation)) return { kind: 'revoked' }

    let rumor: Rumor
    try {
      rumor = createRumor(
        { v: 1, type: 'answer', questionId: active.question_id, text: input.text, source: input.source, confidence: input.confidence },
        input.identity,
        now,
      )
    } catch (err) {
      // Contract with the caller: `text` and `source` arrive already trimmed and non-blank (the
      // channel's `reply` tool schema enforces this before it ever calls answerQuestion), so the
      // only createRumor rejection this function maps to an outcome is the size refusal. Any other
      // rejection (for example a blank field slipping through) is a caller bug, not something a
      // Claude-facing answer outcome exists for — it rolls this transaction back with nothing stored.
      if (err instanceof EnvelopeSizeError) return { kind: 'too_large' }
      throw err
    }
    store.db.prepare("UPDATE attempts SET state = 'answered', ended_at = ? WHERE attempt_id = ?").run(now, active.attempt_id)
    store.db
      .prepare(
        `UPDATE inbox_questions SET state = 'answered', decision = 'answer', decision_rumor_json = ?, decided_at = ?, updated_at = ?
         WHERE sender_pubkey = ? AND question_id = ?`,
      )
      .run(JSON.stringify(rumor), now, now, active.sender_pubkey, active.question_id)
    if (contact.relays.length > 0) {
      enqueue(store, { recipient: active.sender_pubkey, rumor, label: 'answer', powBits: 16, relays: contact.relays, policy: 'once', now })
    }
    return { kind: 'answered', fromName: displayName(contact), code }
  })
}
