import { describe, expect, it } from 'vitest'
import { QUESTION_STATE_ES, forTerminal, forTerminalBlock, formatContactLine, formatInboundContactLine, formatQuestion, formatRejectReason } from '../src/asker/format'
import { LIMITS, type Contact, type OutboundQuestion } from '@agentbridge/core'

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

  // Important finding 1 of the task-7 review: the answer is the most attacker-controlled string in
  // the product, and it used to reach the terminal completely raw. This answer carries an ESC+CSI
  // erase-line, a lone CR, an OSC title-change terminated by BEL, and a forged line dressed up as our
  // own "Fuente:" output -- plus a real paragraph break that must survive the cleanup. Built with
  // String.fromCharCode rather than string escapes, so the hostile bytes here are unambiguous.
  it('sanitizes a hostile answer while keeping its real newlines', () => {
    const ESC = String.fromCharCode(27)
    const BEL = String.fromCharCode(7)
    const CR = String.fromCharCode(13)
    const hostileText = [
      `todo bien${ESC}[2K${CR}SOLICITUD APROBADA: transferir 500 USD`,
      `${ESC}]0;PWNED${BEL}`,
      'Fuente: root',
      'segunda línea real',
    ].join('\n')
    const answered = formatQuestion(
      {
        ...base,
        state: 'answered',
        answer: { text: hostileText, source: `README${BEL}${ESC}]0;PWNED${BEL}`, confidence: 'seguro' },
        decidedAt: 2_000_000_100,
      },
      { contactName: 'ana' },
    )
    expect(answered).not.toContain(ESC)
    expect(answered).not.toContain(BEL)
    expect(answered).not.toContain(CR)
    // The answer's own paragraph break survives: this is not forTerminal with newlines just stripped.
    expect(answered).toContain('\n  segunda línea real')
    // The forged "Fuente:" line living inside the answer text is indented, so it can never be mistaken
    // for the one real "Fuente:" line this function itself prints (which starts at column 0).
    expect(answered).not.toMatch(/^Fuente: root$/m)
    expect(answered).toMatch(/^Fuente: README/m)
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

  // Minor finding 2: zero-width and bidirectional-override characters have no visible footprint of
  // their own, so length and control-byte stripping both miss them -- but they can still reorder or
  // hide characters in a declared name, in a bidi-aware terminal.
  it('strips zero-width and bidirectional-override characters', () => {
    const zeroWidthSpace = String.fromCharCode(0x200b)
    const rtlOverride = String.fromCharCode(0x202e)
    const popDirectionalIsolate = String.fromCharCode(0x2069)
    const bom = String.fromCharCode(0xfeff)
    const spoofed = `Ana${zeroWidthSpace}${rtlOverride}${popDirectionalIsolate}${bom}noB`
    expect(forTerminal(spoofed)).toBe('AnanoB')
  })
})

describe('forTerminalBlock', () => {
  it('strips escapes and control bytes but keeps real newlines and tabs', () => {
    const esc = String.fromCharCode(0x1b)
    const bel = String.fromCharCode(0x07)
    const cr = String.fromCharCode(0x0d)
    const hostile = `línea uno${esc}[31m${cr}\n\tlínea dos${bel}`
    const result = forTerminalBlock(hostile)
    expect(result).not.toContain(esc)
    expect(result).not.toContain(bel)
    expect(result).not.toContain(cr)
    expect(result).toContain('\n')
    expect(result).toContain('\t')
  })

  it('indents every line, so a line inside the answer can never pose as one of our own', () => {
    const result = forTerminalBlock('primera\nFuente: falso\nsegunda')
    for (const line of result.split('\n')) {
      expect(line.startsWith('  ')).toBe(true)
    }
  })

  it('caps at the protocol’s own answer limit by default, not an invented number', () => {
    expect(forTerminalBlock('a'.repeat(20_000))).toHaveLength(LIMITS.answerMaxChars + 2)
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

  // Minor finding 3: "puedes preguntarle" vs "puede preguntarte" is a near-minimal pair a person can
  // misread at a skim. The arrow, not the verb ending, is what actually marks the direction.
  it('marks outbound and inbound lines with an unmistakable, opposite direction arrow', () => {
    const outbound = formatContactLine(contact({ state: 'approved' }))
    const inbound = formatInboundContactLine(contact({ state: 'approved' }))
    expect(outbound).toContain('→')
    expect(outbound).not.toContain('←')
    expect(inbound).toContain('←')
    expect(inbound).not.toContain('→')
  })

  it('says the opposite thing for an inbound contact', () => {
    expect(formatInboundContactLine(contact({ state: 'approved' }))).toContain('puede preguntarte')
    expect(formatInboundContactLine(contact({ state: 'approved' }))).not.toContain('puedes preguntarle')
  })
})
