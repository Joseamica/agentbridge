import { describe, expect, it } from 'vitest'
import {
  ClientMessageSchema,
  HandleSchema,
  LIMITS,
  QuestionCodeSchema,
  ServerMessageSchema,
} from '@agentbridge/core'

const uuid = '3b241101-e2bb-4255-8caf-4136c566a962'

describe('protocol', () => {
  it('accepts valid handles and rejects unsafe ones', () => {
    expect(HandleSchema.safeParse('amieva').success).toBe(true)
    expect(HandleSchema.safeParse('dev-ejemplo').success).toBe(true)
    expect(HandleSchema.safeParse('A').success).toBe(false)
    expect(HandleSchema.safeParse('-bad').success).toBe(false)
    expect(HandleSchema.safeParse('has space').success).toBe(false)
  })

  it('accepts only unambiguous 4-character question codes', () => {
    expect(QuestionCodeSchema.safeParse('Q7K2').success).toBe(true)
    expect(QuestionCodeSchema.safeParse('Q0K2').success).toBe(false)
    expect(QuestionCodeSchema.safeParse('QIK2').success).toBe(false)
    expect(QuestionCodeSchema.safeParse('Q7K').success).toBe(false)
  })

  it('parses a question message from the relay', () => {
    const msg = ServerMessageSchema.parse({
      type: 'question',
      attemptId: uuid,
      code: 'Q7K2',
      from: { handle: 'amieva', displayName: 'Amieva' },
      question: '¿Ya quedó el fix?',
    })
    expect(msg.type).toBe('question')
  })

  it('rejects an answer longer than the limit', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'answer',
      attemptId: uuid,
      code: 'Q7K2',
      text: 'x'.repeat(LIMITS.answerMaxChars + 1),
      source: 'CHANGELOG.md',
      confidence: 'seguro',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown confidence value', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'answer',
      attemptId: uuid,
      code: 'Q7K2',
      text: 'ok',
      source: 'x',
      confidence: 'maybe',
    })
    expect(result.success).toBe(false)
  })
})
