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
  contentRetentionMs: 7 * 24 * 60 * 60 * 1000,
  auditRetentionMs: 30 * 24 * 60 * 60 * 1000,
  authTimeoutMs: 5000,
} as const

export const HandleSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/)

export const ConfidenceSchema = z.enum(['seguro', 'creo', 'no_se'])
export type Confidence = z.infer<typeof ConfidenceSchema>

export const QUESTION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
