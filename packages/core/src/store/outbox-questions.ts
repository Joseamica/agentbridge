import { randomUUID } from 'node:crypto'
import { createRumor, type Rumor } from '../envelope/seal'
import type { Identity } from '../identity'
import { NOSTR } from '../nostr-constants'
import type { Confidence } from '../protocol'
import { UserFacingError } from '../errors'
import { CLI_COMMAND } from '../published'
import { askPermission, getContact } from './contacts'
import type { Store } from './db'
import type { RejectReason } from './inbox'
import { enqueue, resolveOutboxMessage } from './outbox'

export type OutboundQuestionState = 'sending' | 'sent' | 'received' | 'answered' | 'rejected' | 'lost'
export type OutboundAnswer = { text: string; source: string; confidence: Confidence }

export type OutboundQuestion = {
  recipient: string
  questionId: string
  rumorId: string
  generation: number
  text: string | null
  state: OutboundQuestionState
  answer: OutboundAnswer | null
  rejectReason: RejectReason | null
  askedAt: number
  receivedAt: number | null
  decidedAt: number | null
}

type QuestionRow = {
  recipient: string
  question_id: string
  rumor_id: string
  generation: number
  text: string | null
  state: OutboundQuestionState
  answer_text: string | null
  answer_source: string | null
  answer_confidence: Confidence | null
  reject_reason: RejectReason | null
  asked_at: number
  received_at: number | null
  decided_at: number | null
  updated_at: number
}

// A prefix shorter than this matches too much to be a useful handle for a person retyping an id.
export const MIN_QUESTION_PREFIX = 6

const toQuestion = (row: QuestionRow): OutboundQuestion => ({
  recipient: row.recipient,
  questionId: row.question_id,
  rumorId: row.rumor_id,
  generation: row.generation,
  text: row.text,
  state: row.state,
  answer:
    row.answer_text !== null && row.answer_source !== null && row.answer_confidence !== null
      ? { text: row.answer_text, source: row.answer_source, confidence: row.answer_confidence }
      : null,
  rejectReason: row.reject_reason,
  askedAt: row.asked_at,
  receivedAt: row.received_at,
  decidedAt: row.decided_at,
})

const selectRow = (store: Store, recipient: string, questionId: string) =>
  store.db.prepare('SELECT * FROM outbox_questions WHERE recipient = ? AND question_id = ?').get(recipient, questionId) as QuestionRow | undefined

export function getOutboundQuestion(store: Store, recipient: string, questionId: string): OutboundQuestion | null {
  const row = selectRow(store, recipient, questionId)
  return row ? toQuestion(row) : null
}

export function listOutboundQuestions(store: Store, options: { limit?: number } = {}): OutboundQuestion[] {
  const rows = store.db
    .prepare('SELECT * FROM outbox_questions ORDER BY asked_at DESC, rowid DESC LIMIT ?')
    .all(options.limit ?? 20) as QuestionRow[]
  return rows.map(toQuestion)
}

// The prefix is matched with a bound parameter and only after it passes the hex-ish shape below, so
// it can never carry a LIKE wildcard.
export function findOutboundQuestions(store: Store, prefix: string): OutboundQuestion[] {
  const normalized = prefix.trim().toLowerCase()
  if (normalized.length < MIN_QUESTION_PREFIX || !/^[0-9a-f-]+$/.test(normalized)) return []
  const rows = store.db
    .prepare('SELECT * FROM outbox_questions WHERE question_id LIKE ? ORDER BY asked_at DESC, rowid DESC')
    .all(`${normalized}%`) as QuestionRow[]
  return rows.map(toQuestion)
}

export function createOutboundQuestion(
  store: Store,
  input: { identity: Identity; recipient: string; text: string; now: number; newQuestionId?: () => string },
): { question: OutboundQuestion; rumor: Rumor } {
  return store.tx(() => {
    const permission = askPermission(store, input.recipient)
    if (!permission) {
      throw new UserFacingError(`Esa persona todavía no te dio permiso para preguntarle. Pídeselo con ${CLI_COMMAND} connect y espera a que apruebe.`)
    }
    const contact = getContact(store, input.recipient, 'outbound')!
    if (contact.relays.length === 0) {
      throw new UserFacingError('No tienes ningún tablero donde dejarle la pregunta a esa persona. Pídele que te envíe un enlace nuevo.')
    }
    const questionId = (input.newQuestionId ?? randomUUID)()
    // createRumor throws EnvelopeSizeError (a UserFacingError, in Spanish) for a question that is
    // too long, before anything is written.
    const rumor = createRumor({ v: 1, type: 'question', questionId, generation: permission.generation, text: input.text }, input.identity, input.now)
    store.db
      .prepare(
        `INSERT INTO outbox_questions (recipient, question_id, rumor_id, generation, text, state, asked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'sending', ?, ?)`,
      )
      .run(input.recipient, questionId, rumor.id, permission.generation, input.text, input.now, input.now)
    enqueue(store, {
      recipient: input.recipient,
      rumor,
      label: 'question',
      powBits: 16,
      relays: contact.relays.slice(0, NOSTR.maxRelaysPerContact),
      policy: 'retry_until_resolved',
      now: input.now,
    })
    return { question: toQuestion(selectRow(store, input.recipient, questionId)!), rumor }
  })
}

const OPEN_STATES = "('sending', 'sent', 'received')"

// The outbox is the only place that knows a relay accepted a wrap: `markPublished` stamps
// last_published_at. Deriving the promotion from that column (instead of a callback in the
// publisher) means it also happens when another process did the publishing, and that a crash
// between the publish and this update loses nothing — the next sync promotes it.
export function markSentQuestions(store: Store, now: number): number {
  return store.tx(() => {
    const result = store.db
      .prepare(
        `UPDATE outbox_questions SET state = 'sent', updated_at = ?
           WHERE state = 'sending'
             AND EXISTS (SELECT 1 FROM outbox WHERE outbox.recipient = outbox_questions.recipient
                           AND outbox.rumor_id = outbox_questions.rumor_id AND outbox.last_published_at IS NOT NULL)`,
      )
      .run(now)
    return Number(result.changes)
  })
}

export function applyReceipt(store: Store, input: { recipient: string; questionId: string; now: number }): 'applied' | 'ignored' {
  // A receipt for a question this person does not have is the common case for anything unrelated
  // that arrives addressed to them: answering it with a write transaction would make an unrelated
  // message able to fail a sync on a read-only database.
  if (!getOutboundQuestion(store, input.recipient, input.questionId)) return 'ignored'
  return store.tx(() => {
    // Re-read inside the transaction: another process sharing this home may have changed the row
    // between the check above and this write, and only the row as it stands right now decides
    // whether there is still something to do.
    const row = selectRow(store, input.recipient, input.questionId)
    if (!row || (row.state !== 'sending' && row.state !== 'sent')) return 'ignored'
    store.db
      .prepare("UPDATE outbox_questions SET state = 'received', received_at = ?, updated_at = ? WHERE recipient = ? AND question_id = ?")
      .run(input.now, input.now, input.recipient, input.questionId)
    // The receipt deliberately does not resolve the outbox row: the spec keeps retrying until the
    // question has an answer or a rejection.
    return 'applied'
  })
}

function decide(
  store: Store,
  input: { recipient: string; questionId: string; now: number },
  apply: (row: QuestionRow) => void,
): 'applied' | 'ignored' {
  return store.tx(() => {
    const row = selectRow(store, input.recipient, input.questionId)
    // A final state never changes: a second decision for the same question is the caller's to log.
    if (!row || (row.state !== 'sending' && row.state !== 'sent' && row.state !== 'received')) return 'ignored'
    apply(row)
    // The question is settled, so its retries stop here.
    resolveOutboxMessage(store, { recipient: row.recipient, rumorId: row.rumor_id })
    return 'applied'
  })
}

export function applyAnswer(
  store: Store,
  input: { recipient: string; questionId: string; answer: OutboundAnswer; now: number },
): 'applied' | 'ignored' {
  return decide(store, input, () => {
    store.db
      .prepare(
        `UPDATE outbox_questions SET state = 'answered', answer_text = ?, answer_source = ?, answer_confidence = ?, decided_at = ?, updated_at = ?
           WHERE recipient = ? AND question_id = ?`,
      )
      .run(input.answer.text, input.answer.source, input.answer.confidence, input.now, input.now, input.recipient, input.questionId)
  })
}

export function applyRejected(
  store: Store,
  input: { recipient: string; questionId: string; reason: RejectReason; now: number },
): 'applied' | 'ignored' {
  return decide(store, input, () => {
    store.db
      .prepare(
        `UPDATE outbox_questions SET state = 'rejected', reject_reason = ?, decided_at = ?, updated_at = ?
           WHERE recipient = ? AND question_id = ?`,
      )
      .run(input.reason, input.now, input.now, input.recipient, input.questionId)
  })
}

// A question that never reached a final state inside the retry window can no longer be answered:
// the other side stopped hearing about it. Its outbox row goes too, so nothing keeps mining for it.
export function expireOutboundQuestions(store: Store, now: number): number {
  return store.tx(() => {
    const horizon = now - NOSTR.retryWindowSeconds
    const rows = store.db
      .prepare(`SELECT recipient, rumor_id FROM outbox_questions WHERE state IN ${OPEN_STATES} AND asked_at <= ?`)
      .all(horizon) as Array<{ recipient: string; rumor_id: string }>
    if (rows.length === 0) return 0
    store.db
      .prepare(`UPDATE outbox_questions SET state = 'lost', decided_at = ?, updated_at = ? WHERE state IN ${OPEN_STATES} AND asked_at <= ?`)
      .run(now, now, horizon)
    for (const row of rows) resolveOutboxMessage(store, { recipient: row.recipient, rumorId: row.rumor_id })
    return rows.length
  })
}

// Content (the question text and the answer) follows the 7-day retention; the row itself, which is
// what says the question ended and how, stays until 9 days.
export function purgeOutboundQuestions(store: Store, now: number): { contentCleared: number; forgotten: number } {
  return store.tx(() => {
    const contentCleared = store.db
      .prepare(
        `UPDATE outbox_questions SET text = NULL, answer_text = NULL, answer_source = NULL, answer_confidence = NULL, updated_at = ?
           WHERE asked_at <= ? AND (text IS NOT NULL OR answer_text IS NOT NULL)`,
      )
      .run(now, now - NOSTR.contentRetentionSeconds)
    const forgotten = store.db.prepare('DELETE FROM outbox_questions WHERE asked_at <= ?').run(now - NOSTR.decisionRetentionSeconds)
    return { contentCleared: Number(contentCleared.changes), forgotten: Number(forgotten.changes) }
  })
}
