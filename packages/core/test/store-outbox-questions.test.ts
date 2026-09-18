import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LIMITS,
  NOSTR,
  UserFacingError,
  applyAnswer,
  applyApproval,
  applyReceipt,
  applyRejected,
  applyRevocation,
  authorizeOutboxItem,
  claimDue,
  createOutboundQuestion,
  createOutboundRequest,
  expireOutboundQuestions,
  findOutboundQuestions,
  getOutboundQuestion,
  listOutboundQuestions,
  markPublished,
  markSentQuestions,
  openStore,
  purgeOutboundQuestions,
  type Store,
} from '@agentbridge/core'
import { testIdentity } from './support/keys'

const me = testIdentity(31)
const them = testIdentity(32)
const T0 = 2_000_000_000
const RELAYS = ['wss://relay.example.com']
// Distinct in their *first* characters, because the prefix lookup below is about what a person
// retypes: ids that differ only in their last digits would make every prefix ambiguous.
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
let store: Store

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-outq-')), 'home'))
})
afterEach(() => store.close())

// The asker's side of a finished handshake: a request this person sent, approved by the other.
function approved(generation = 1, now = T0): void {
  createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: RELAYS, now })
  applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation, name: 'Ana', relays: RELAYS, now })
}

const outbox = () => store.db.prepare('SELECT * FROM outbox').all() as Array<Record<string, unknown>>

// Publishes the one pending outbox row the way the real publisher does: claim it, then record
// that a relay accepted it.
function publishOne(now = T0): void {
  const owner = 'test-owner'
  const [item] = claimDue(store, { owner, now, limit: 1, authorize: () => true })
  if (!item) throw new Error('expected a due outbox row')
  markPublished(store, { recipient: item.recipient, rumorId: item.rumorId, owner, now })
}

function ask(id: number, now = T0): string {
  const { question } = createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: `pregunta ${id}`, now, newQuestionId: () => uuid(id) })
  return question.questionId
}

describe('createOutboundQuestion', () => {
  it('stores the question as sending and enqueues its wrap for retries', () => {
    approved()
    const { question, rumor } = createOutboundQuestion(store, {
      identity: me,
      recipient: them.publicKey,
      text: '¿cómo se despliega?',
      now: T0,
      newQuestionId: () => uuid(7),
    })
    expect(question).toMatchObject({
      recipient: them.publicKey,
      questionId: uuid(7),
      rumorId: rumor.id,
      generation: 1,
      text: '¿cómo se despliega?',
      state: 'sending',
      answer: null,
      rejectReason: null,
      askedAt: T0,
      receivedAt: null,
      decidedAt: null,
    })
    expect(JSON.parse(rumor.content)).toMatchObject({ type: 'question', questionId: uuid(7), generation: 1, text: '¿cómo se despliega?' })
    const rows = outbox()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ recipient: them.publicKey, rumor_id: rumor.id, label: 'question', pow_bits: 16, policy: 'retry_until_resolved' })
  })

  it('refuses to ask someone who never approved this person', () => {
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: RELAYS, now: T0 })
    expect(() => createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'hola', now: T0 })).toThrow(UserFacingError)
    expect(outbox()).toHaveLength(0)
    expect(listOutboundQuestions(store)).toEqual([])
  })

  it('refuses a question that is too large, without storing anything', () => {
    approved()
    const long = 'a'.repeat(LIMITS.questionMaxChars + 1)
    expect(() => createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: long, now: T0 })).toThrow(UserFacingError)
    expect(outbox()).toHaveLength(0)
    expect(listOutboundQuestions(store)).toEqual([])
  })

  it('carries the generation of the latest approval', () => {
    // A second approval only applies to a *pending* request, so the real sequence is the one a
    // person lives through: approved, revoked, asked again, approved again with a higher generation.
    approved(1)
    expect(applyRevocation(store, { pubkey: them.publicKey, generation: 2, now: T0 + 1 })).toBe('applied')
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(2), relays: RELAYS, now: T0 + 2 })
    expect(applyApproval(store, { pubkey: them.publicKey, requestId: uuid(2), generation: 3, name: 'Ana', relays: RELAYS, now: T0 + 3 })).toBe('applied')

    const { rumor } = createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'hola', now: T0 + 4, newQuestionId: () => uuid(8) })
    expect(JSON.parse(rumor.content)).toMatchObject({ generation: 3 })
    expect(getOutboundQuestion(store, them.publicKey, uuid(8))?.generation).toBe(3)
  })

  it('sends to the relays stored for that contact, capped at the protocol maximum', () => {
    const many = ['wss://a.example.com', 'wss://b.example.com', 'wss://c.example.com', 'wss://d.example.com', 'wss://e.example.com', 'wss://f.example.com']
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: many, now: T0 })
    applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: many, now: T0 })
    createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'hola', now: T0, newQuestionId: () => uuid(9) })
    const relays = JSON.parse(String(outbox()[0]!.relays)) as string[]
    expect(relays).toHaveLength(NOSTR.maxRelaysPerContact)
  })
})

describe('reading questions back', () => {
  it('lists the newest first and finds one by a prefix', () => {
    approved()
    createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'primera', now: T0, newQuestionId: () => uuid(11) })
    createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'segunda', now: T0 + 5, newQuestionId: () => uuid(12) })
    expect(listOutboundQuestions(store).map((q) => q.text)).toEqual(['segunda', 'primera'])
    expect(findOutboundQuestions(store, uuid(12).slice(0, 8)).map((q) => q.questionId)).toEqual([uuid(12)])
    // Two ids that share a prefix are the ambiguous case the CLI must ask about.
    // Same first eight characters as uuid(12), still a well-formed UUID (createRumor validates it).
    createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'tercera', now: T0 + 6, newQuestionId: () => `${uuid(12).slice(0, 8)}-1111-4000-8000-000000000000` })
    expect(findOutboundQuestions(store, uuid(12).slice(0, 8)).length).toBeGreaterThan(1)
    expect(getOutboundQuestion(store, them.publicKey, uuid(11))?.text).toBe('primera')
    expect(getOutboundQuestion(store, them.publicKey, uuid(99))).toBeNull()
  })

  it('refuses a prefix that is too short to be worth matching', () => {
    approved()
    createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'primera', now: T0, newQuestionId: () => uuid(11) })
    expect(findOutboundQuestions(store, '000')).toEqual([])
  })
})

describe('markSentQuestions', () => {
  it('promotes a question to sent once a relay accepted its wrap', () => {
    approved()
    const id = ask(21)
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('sending')
    expect(markSentQuestions(store, T0 + 1)).toBe(0)

    publishOne(T0 + 2)
    expect(markSentQuestions(store, T0 + 3)).toBe(1)
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('sent')
    // Idempotent: a second sync does not move it again.
    expect(markSentQuestions(store, T0 + 4)).toBe(0)
  })

  it('leaves a question in sending while every publish is still failing', () => {
    approved()
    const id = ask(22)
    claimDue(store, { owner: 'test-owner', now: T0, limit: 1, authorize: () => true })
    expect(markSentQuestions(store, T0 + 1)).toBe(0)
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('sending')
  })
})

describe('incoming decisions', () => {
  it('moves through received and then answered, and stops the retries', () => {
    approved()
    const id = ask(23)
    publishOne()
    markSentQuestions(store, T0 + 1)

    expect(applyReceipt(store, { recipient: them.publicKey, questionId: id, now: T0 + 10 })).toBe('applied')
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({ state: 'received', receivedAt: T0 + 10 })
    // The receipt does not stop the retries: the row is still there.
    expect(outbox()).toHaveLength(1)

    const answer = { text: 'se despliega con npm run deploy', source: 'README.md', confidence: 'seguro' as const }
    expect(applyAnswer(store, { recipient: them.publicKey, questionId: id, answer, now: T0 + 20 })).toBe('applied')
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({ state: 'answered', answer, decidedAt: T0 + 20 })
    expect(outbox()).toHaveLength(0)
  })

  it('accepts an answer that arrives before the receipt ever does', () => {
    approved()
    const id = ask(24)
    const answer = { text: 'sí', source: 'notas.md', confidence: 'creo' as const }
    expect(applyAnswer(store, { recipient: them.publicKey, questionId: id, answer, now: T0 + 5 })).toBe('applied')
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('answered')
  })

  it('ignores a second decision for the same question', () => {
    approved()
    const id = ask(25)
    applyRejected(store, { recipient: them.publicKey, questionId: id, reason: 'limit', now: T0 + 5 })
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({ state: 'rejected', rejectReason: 'limit' })

    const answer = { text: 'tarde', source: 'x', confidence: 'seguro' as const }
    expect(applyAnswer(store, { recipient: them.publicKey, questionId: id, answer, now: T0 + 6 })).toBe('ignored')
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({ state: 'rejected', answer: null })
  })

  it('ignores a decision for a question this person never sent', () => {
    approved()
    expect(applyReceipt(store, { recipient: them.publicKey, questionId: uuid(404), now: T0 })).toBe('ignored')
    expect(applyRejected(store, { recipient: them.publicKey, questionId: uuid(404), reason: 'expired', now: T0 })).toBe('ignored')
  })
})

describe('expireOutboundQuestions', () => {
  it('gives up after the retry window and stops the retries', () => {
    approved()
    const id = ask(26)
    publishOne()
    markSentQuestions(store, T0 + 1)

    expect(expireOutboundQuestions(store, T0 + NOSTR.retryWindowSeconds - 1)).toBe(0)
    expect(expireOutboundQuestions(store, T0 + NOSTR.retryWindowSeconds)).toBe(1)
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({ state: 'lost', decidedAt: T0 + NOSTR.retryWindowSeconds })
    expect(outbox()).toHaveLength(0)
  })

  it('never touches a question that already ended', () => {
    approved()
    const id = ask(27)
    applyAnswer(store, { recipient: them.publicKey, questionId: id, answer: { text: 'ok', source: 'x', confidence: 'seguro' }, now: T0 + 1 })
    expect(expireOutboundQuestions(store, T0 + NOSTR.retryWindowSeconds + 1)).toBe(0)
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('answered')
  })
})

describe('the publisher promotes a question as it goes out', () => {
  it('fires onPublished for the row it just published', async () => {
    approved()
    const id = ask(31)
    const published: string[] = []
    const { publishDue } = await import('@agentbridge/core')
    // A pool that accepts everything, so the round records a publish.
    const pool = { publish: async () => ({ accepted: ['wss://relay.example.com'], rejected: [] }) } as never
    // The hook only notifies; promoting the row is the caller's job (a persistent process wires this
    // straight to markSentQuestions, per P1), which is what this test stands in for.
    await publishDue({
      store,
      identity: me,
      pool,
      now: () => T0,
      onPublished: (item) => {
        published.push(item.rumorId)
        markSentQuestions(store, T0)
      },
    })
    expect(published).toHaveLength(1)
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('sent')
  })
})

describe('purgeOutboundQuestions', () => {
  it('clears the text and the answer at 7 days and forgets the row at 9', () => {
    approved()
    const id = ask(28)
    applyAnswer(store, { recipient: them.publicKey, questionId: id, answer: { text: 'respuesta', source: 'x', confidence: 'seguro' }, now: T0 + 1 })

    expect(purgeOutboundQuestions(store, T0 + NOSTR.contentRetentionSeconds)).toEqual({ contentCleared: 1, forgotten: 0 })
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({ state: 'answered', text: null, answer: null })

    expect(purgeOutboundQuestions(store, T0 + NOSTR.decisionRetentionSeconds)).toEqual({ contentCleared: 0, forgotten: 1 })
    expect(getOutboundQuestion(store, them.publicKey, id)).toBeNull()
  })
})

// P11 regression (Task 1's review): the retry of a question already open when the contact
// revoked must keep working, but a *new* question to that same revoked contact is refused just
// like one that never approved this person in the first place.
describe('a question already open when the contact revokes', () => {
  it('keeps authorizing its own retry while a brand-new question is refused', () => {
    approved()
    const id = ask(40)
    const [item] = claimDue(store, { owner: 'test-owner', now: T0, limit: 1, authorize: () => true })
    if (!item) throw new Error('expected the outbox row for the open question')

    expect(applyRevocation(store, { pubkey: them.publicKey, generation: 2, now: T0 + 1 })).toBe('applied')

    // A brand-new question to the now-revoked contact is refused exactly like a contact that
    // never approved this person.
    expect(() => createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'otra', now: T0 + 2 })).toThrow(UserFacingError)

    // The already-open row is what fetches the rejected/stale_generation decision the other side
    // stored when they revoked, so its retry must stay authorized despite the contact no longer
    // being approved.
    expect(authorizeOutboxItem(store, item)).toBe(true)
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('sending')
  })
})
