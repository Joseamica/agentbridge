import { describe, expect, it } from 'vitest'
import {
  MessageSchema,
  NOSTR,
  isFutureDated,
  isQuestionExpired,
  isRequestTooOld,
  powBitsFor,
  questionExpiresAt,
  type Message,
} from '@agentbridge/core'

const id = '3b241101-e2bb-4255-8caf-4136c566a962'

const valid: Message[] = [
  { v: 1, type: 'connect_request', requestId: id, name: 'Ana', note: 'Hola', relays: ['wss://nos.lol'] },
  { v: 1, type: 'connect_approved', requestId: id, generation: 1, name: 'Dev', relays: ['wss://relay.primal.net'] },
  { v: 1, type: 'connect_rejected', requestId: id },
  { v: 1, type: 'connect_revoked', generation: 2 },
  { v: 1, type: 'question', questionId: id, generation: 1, text: '¿Qué timeout aplica?' },
  { v: 1, type: 'receipt', questionId: id },
  { v: 1, type: 'answer', questionId: id, text: '30 s', source: 'README.md', confidence: 'seguro' },
  { v: 1, type: 'rejected', questionId: id, reason: 'stale_generation' },
]

describe('MessageSchema', () => {
  it.each(valid)('accepts $type', (message) => {
    expect(MessageSchema.parse(message)).toEqual(message)
  })

  it.each([
    [{ v: 2, type: 'receipt', questionId: id }, 'unknown version'],
    [{ v: 1, type: 'ping' }, 'unknown type'],
    [{ v: 1, type: 'receipt', questionId: id, extra: true }, 'extra field'],
    [{ v: 1, type: 'receipt', questionId: 'not-a-uuid' }, 'bad uuid'],
    [{ v: 1, type: 'connect_revoked', generation: 0 }, 'generation zero'],
    [{ v: 1, type: 'question', questionId: id, generation: 1, text: '   ' }, 'blank text'],
    [{ v: 1, type: 'question', questionId: id, generation: 1, text: 'x'.repeat(4001) }, 'question too long'],
    [{ v: 1, type: 'answer', questionId: id, text: 'x'.repeat(8001), source: 's', confidence: 'creo' }, 'answer too long'],
    [{ v: 1, type: 'answer', questionId: id, text: 'ok', source: 's'.repeat(501), confidence: 'creo' }, 'source too long'],
    [{ v: 1, type: 'answer', questionId: id, text: '€'.repeat(6000), source: 's', confidence: 'creo' }, 'within chars but over 16 KB'],
    [{ v: 1, type: 'answer', questionId: id, text: 'ok', source: 's', confidence: 'quizas' }, 'bad confidence'],
    [{ v: 1, type: 'connect_request', requestId: id, name: 'Ana', note: '', relays: Array(6).fill('wss://a.example.com') }, 'too many relays'],
    [{ v: 1, type: 'connect_request', requestId: id, name: 'Ana', note: '', relays: [] }, 'request without relays'],
    [{ v: 1, type: 'connect_approved', requestId: id, generation: 1, name: 'Dev', relays: [] }, 'approval without relays'],
    [{ v: 1, type: 'rejected', questionId: id, reason: 'because' }, 'bad reason'],
  ])('rejects %j (%s)', (message, _description) => {
    expect(MessageSchema.safeParse(message).success).toBe(false)
  })

  it('requires 22 bits of proof of work only for connection requests', () => {
    expect(powBitsFor('connect_request')).toBe(22)
    for (const m of valid.filter((m) => m.type !== 'connect_request')) expect(powBitsFor(m.type)).toBe(16)
  })
})

describe('time rules', () => {
  const now = 1_800_000_000

  it('allows at most ten minutes of clock skew into the future', () => {
    expect(isFutureDated(now + NOSTR.futureToleranceSeconds, now)).toBe(false)
    expect(isFutureDated(now + NOSTR.futureToleranceSeconds + 1, now)).toBe(true)
  })

  it('expires a question exactly 24 hours after the rumor was created', () => {
    expect(questionExpiresAt(now)).toBe(now + 86_400)
    expect(isQuestionExpired(now, now + 86_399)).toBe(false)
    expect(isQuestionExpired(now, now + 86_400)).toBe(true)
  })

  it('accepts connection requests up to seven days old', () => {
    expect(isRequestTooOld(now, now + 7 * 86_400)).toBe(false)
    expect(isRequestTooOld(now, now + 7 * 86_400 + 1)).toBe(true)
  })
})
