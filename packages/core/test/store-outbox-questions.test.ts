import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LIMITS,
  NOSTR,
  UserFacingError,
  applyApproval,
  applyRevocation,
  createOutboundQuestion,
  createOutboundRequest,
  findOutboundQuestions,
  getOutboundQuestion,
  listOutboundQuestions,
  openStore,
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
