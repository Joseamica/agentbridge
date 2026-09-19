import { describe, expect, it } from 'vitest'
import { QUESTION_STATE_ES, forTerminal, formatContactLine, formatInboundContactLine, formatQuestion, formatRejectReason } from '../src/asker/format'
import type { Contact, OutboundQuestion } from '@agentbridge/core'

const base: OutboundQuestion = {
  recipient: 'a'.repeat(64),
  questionId: '00000000-0000-4000-8000-000000000001',
  rumorId: 'b'.repeat(64),
  generation: 1,
  text: '¿cómo se despliega?',
  state: 'sent',
  answer: null,
  rejectReason: null,
  askedAt: 2_000_000_000,
  receivedAt: null,
  decidedAt: null,
}

const contact = (overrides: Partial<Contact>): Contact =>
  ({
    pubkey: 'a'.repeat(64),
    direction: 'outbound',
    state: 'approved',
    generation: 1,
    maxGenerationSeen: 1,
    requestId: null,
    requestRumorId: null,
    localName: 'ana',
    declaredName: 'Ana',
    note: null,
    relays: ['wss://relay.example.com'],
    requestedAt: 2_000_000_000,
    decidedAt: 2_000_000_000,
    createdAt: 2_000_000_000,
    updatedAt: 2_000_000_000,
    ...overrides,
  }) as Contact

describe('formatQuestion', () => {
  it('distinguishes reaching their computer from being answered', () => {
    expect(formatQuestion({ ...base, state: 'sent' }, { contactName: 'ana' })).toContain('enviada')
    const received = formatQuestion({ ...base, state: 'received', receivedAt: 2_000_000_050 }, { contactName: 'ana' })
    expect(received).toContain('recibida')
    expect(received).not.toContain('contestada')
  })

  it('shows the answer with its source and confidence', () => {
    const answered = formatQuestion(
      { ...base, state: 'answered', answer: { text: 'con npm run deploy', source: 'README.md', confidence: 'seguro' }, decidedAt: 2_000_000_100 },
      { contactName: 'ana' },
    )
    expect(answered).toContain('con npm run deploy')
    expect(answered).toContain('README.md')
    expect(answered).toContain('seguro')
  })

  it('explains each rejection reason in Spanish, without protocol words', () => {
    for (const reason of ['expired', 'limit', 'unanswered', 'stale_generation'] as const) {
      const text = formatQuestion({ ...base, state: 'rejected', rejectReason: reason, decidedAt: 2_000_000_100 }, { contactName: 'ana' })
      expect(text).toBe(`${formatQuestion({ ...base, state: 'rejected', rejectReason: reason, decidedAt: 2_000_000_100 }, { contactName: 'ana' })}`)
      expect(text).toContain(formatRejectReason(reason))
      expect(text).not.toMatch(/stale_generation|unanswered|expired|limit/)
    }
  })

  it('says a lost question ran out of time instead of showing a protocol state', () => {
    const lost = formatQuestion({ ...base, state: 'lost', decidedAt: 2_000_000_100 }, { contactName: 'ana' })
    expect(lost).toContain(QUESTION_STATE_ES.lost)
    expect(lost).not.toContain('lost')
  })
})

describe('forTerminal', () => {
  it('strips control characters and ANSI escapes from someone else’s words', () => {
    expect(forTerminal('Ana\u001b[31m\nSOLICITUD APROBADA')).not.toContain('\u001b')
    expect(forTerminal('Ana\nBeto')).not.toContain('\n')
    expect(forTerminal('x'.repeat(300), 80)).toHaveLength(80)
  })
})

describe('formatContactLine', () => {
  it('names the person and what this person may do with them', () => {
    expect(formatContactLine(contact({ state: 'approved' }))).toContain('ana')
    expect(formatContactLine(contact({ state: 'pending', localName: null }))).toContain('esperando')
    expect(formatContactLine(contact({ state: 'revoked' }))).toContain('retiró')
    expect(formatContactLine(contact({ state: 'rejected' }))).toContain('no aceptó')
  })

  it('never claims to know whether someone is online', () => {
    expect(formatContactLine(contact({}))).not.toMatch(/en línea|desconectad/i)
  })

  it('says the opposite thing for an inbound contact', () => {
    expect(formatInboundContactLine(contact({ state: 'approved' }))).toContain('puede preguntarte')
    expect(formatInboundContactLine(contact({ state: 'approved' }))).not.toContain('puedes preguntarle')
  })
})
