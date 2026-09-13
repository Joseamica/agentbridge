import { z } from 'zod'

export const LIMITS = {
  questionMaxChars: 4000,
  answerMaxChars: 8000,
  sourceMaxChars: 500,
  maxOpenTicketsPerPair: 5,
  maxTicketsPerPairPerDay: 20,
  longPollMaxSeconds: 45,
  attemptTimeoutMs: 10 * 60 * 1000,
  ticketTtlMs: 24 * 60 * 60 * 1000,
  enrollmentTtlMs: 24 * 60 * 60 * 1000,
  inviteTtlMs: 24 * 60 * 60 * 1000,
  contentRetentionMs: 7 * 24 * 60 * 60 * 1000,
  auditRetentionMs: 30 * 24 * 60 * 60 * 1000,
  authTimeoutMs: 5000,
} as const

export const HandleSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/)

export const ConfidenceSchema = z.enum(['seguro', 'creo', 'no_se'])
export type Confidence = z.infer<typeof ConfidenceSchema>

export const TicketStatusSchema = z.enum(['queued', 'dispatched', 'answered', 'expired', 'cancelled'])
export type TicketStatus = z.infer<typeof TicketStatusSchema>

export const QUESTION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const QuestionCodeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{4}$/)

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth_ok'), handle: HandleSchema }),
  z.object({
    type: z.literal('question'),
    attemptId: z.uuid(),
    code: QuestionCodeSchema,
    from: z.object({ handle: HandleSchema, displayName: z.string() }),
    question: z.string(),
  }),
  z.object({
    type: z.literal('cancel'),
    attemptId: z.uuid(),
    reason: z.enum(['timeout', 'revoked', 'replaced']),
  }),
  z.object({ type: z.literal('answer_accepted'), attemptId: z.uuid() }),
  z.object({
    type: z.literal('answer_rejected'),
    attemptId: z.uuid(),
    reason: z.enum(['not_in_flight', 'wrong_code', 'invalid']),
  }),
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(20) }),
  z.object({
    type: z.literal('answer'),
    attemptId: z.uuid(),
    code: QuestionCodeSchema,
    text: z.string().min(1).max(LIMITS.answerMaxChars),
    source: z.string().min(1).max(LIMITS.sourceMaxChars),
    confidence: ConfidenceSchema,
  }),
  z.object({ type: z.literal('ping') }),
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>

export const TicketViewSchema = z.object({
  ticketId: z.uuid(),
  status: TicketStatusSchema,
  to: HandleSchema,
  question: z.string().nullable(),
  answer: z.string().nullable(),
  source: z.string().nullable(),
  confidence: ConfidenceSchema.nullable(),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
  latencyMs: z.number().nullable(),
})
export type TicketView = z.infer<typeof TicketViewSchema>

export const ContactsViewSchema = z.object({
  canAsk: z.array(z.object({ handle: HandleSchema, displayName: z.string(), online: z.boolean() })),
  canAskMe: z.array(z.object({ handle: HandleSchema, displayName: z.string() })),
})
export type ContactsView = z.infer<typeof ContactsViewSchema>
