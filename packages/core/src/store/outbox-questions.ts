import { randomUUID } from 'node:crypto'
import { createRumor, type Rumor } from '../envelope/seal'
import type { Identity } from '../identity'
import { NOSTR } from '../nostr-constants'
import type { Confidence } from '../protocol'
import { UserFacingError } from '../errors'
import { askPermission, getContact } from './contacts'
import type { Store } from './db'
import type { RejectReason } from './inbox'
import { enqueue } from './outbox'

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
      throw new UserFacingError('Esa persona todavía no te dio permiso para preguntarle. Pídeselo con connect y espera a que apruebe.')
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
