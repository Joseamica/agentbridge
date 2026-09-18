import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyApproval,
  createOutboundQuestion,
  createOutboundRequest,
  createRumor,
  getContact,
  getOutboundQuestion,
  handleAskerMessage,
  openStore,
  type Message,
  type OpenedMessage,
  type Store,
} from '@agentbridge/core'
import { testIdentity } from './support/keys'

const me = testIdentity(41)
const them = testIdentity(42)
const stranger = testIdentity(43)
const T0 = 2_000_000_000
const RELAYS = ['wss://relay.example.com']
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
let store: Store

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-ask-in-')), 'home'))
})
afterEach(() => store.close())

// An opened message exactly as the receive pipeline hands it over. Built by hand (rather than by
// wrapping and opening for real) so these tests stay fast, but with every field `OpenedMessage`
// declares, including the ones the router never reads.
function opened(message: Message, sender = them, createdAt = T0): OpenedMessage {
  const rumor = createRumor(message, sender, createdAt)
  return { ok: true, wrapId: rumor.id, senderPubkey: sender.publicKey, rumor, message, powBits: 16 }
}

// `satisfies Message` keeps `v: 1` and every `type` as the literal the discriminated union needs;
// a plain object literal would widen them to `number` and `string` and fail to type-check.
const handle = (message: Message, sender = them, now = T0) =>
  handleAskerMessage(store, { identity: me, opened: opened(message, sender), now })

function pendingRequest(): void {
  createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: RELAYS, now: T0 })
}

function approvedContact(generation = 1): void {
  pendingRequest()
  applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation, name: 'Ana', relays: RELAYS, now: T0 })
}

describe('handleAskerMessage — permissions', () => {
  it('applies an approval for the pending request', () => {
    pendingRequest()
    const result = handle({ v: 1, type: 'connect_approved', requestId: uuid(1), generation: 1, name: 'Ana', relays: RELAYS } satisfies Message)
    expect(result).toEqual({ kind: 'permission', type: 'connect_approved', outcome: 'applied' })
    expect(getContact(store, them.publicKey, 'outbound')).toMatchObject({ state: 'approved', generation: 1, declaredName: 'Ana' })
  })

  it('ignores an approval whose relays are all unusable, without storing anything', () => {
    pendingRequest()
    const result = handle({ v: 1, type: 'connect_approved', requestId: uuid(1), generation: 1, name: 'Ana', relays: ['http://x.example.com'] } satisfies Message)
    expect(result).toEqual({ kind: 'ignored', reason: 'no_relays' })
    expect(getContact(store, them.publicKey, 'outbound')?.state).toBe('pending')
  })

  it('ignores an approval for a request id that is not the pending one', () => {
    pendingRequest()
    const result = handle({ v: 1, type: 'connect_approved', requestId: uuid(2), generation: 1, name: 'Ana', relays: RELAYS } satisfies Message)
    expect(result).toEqual({ kind: 'permission', type: 'connect_approved', outcome: 'ignored' })
    expect(getContact(store, them.publicKey, 'outbound')?.state).toBe('pending')
  })

  it('applies a rejection and then ignores a stale revocation', () => {
    approvedContact(3)
    expect(handle({ v: 1, type: 'connect_revoked', generation: 2 } satisfies Message)).toEqual({ kind: 'permission', type: 'connect_revoked', outcome: 'ignored' })
    expect(getContact(store, them.publicKey, 'outbound')?.state).toBe('approved')

    expect(handle({ v: 1, type: 'connect_revoked', generation: 4 } satisfies Message)).toEqual({ kind: 'permission', type: 'connect_revoked', outcome: 'applied' })
    expect(getContact(store, them.publicKey, 'outbound')).toMatchObject({ state: 'revoked', maxGenerationSeen: 4 })
  })

  it('applies a rejection of the pending request', () => {
    pendingRequest()
    expect(handle({ v: 1, type: 'connect_rejected', requestId: uuid(1) } satisfies Message)).toEqual({ kind: 'permission', type: 'connect_rejected', outcome: 'applied' })
    expect(getContact(store, them.publicKey, 'outbound')?.state).toBe('rejected')
  })
})

describe('handleAskerMessage — answers to my questions', () => {
  function askOne(id: number): string {
    approvedContact()
    const { question } = createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'hola', now: T0, newQuestionId: () => uuid(id) })
    return question.questionId
  }

  it('records a receipt, then an answer', () => {
    const id = askOne(10)
    expect(handle({ v: 1, type: 'receipt', questionId: id } satisfies Message)).toEqual({ kind: 'question', type: 'receipt', questionId: id, outcome: 'applied' })
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('received')

    const answer = { v: 1, type: 'answer', questionId: id, text: 'así se hace', source: 'README.md', confidence: 'seguro' } satisfies Message
    expect(handle(answer)).toEqual({ kind: 'question', type: 'answer', questionId: id, outcome: 'applied' })
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({
      state: 'answered',
      answer: { text: 'así se hace', source: 'README.md', confidence: 'seguro' },
    })
  })

  it('records a rejection with its reason', () => {
    const id = askOne(11)
    expect(handle({ v: 1, type: 'rejected', questionId: id, reason: 'limit' } satisfies Message)).toEqual({
      kind: 'question',
      type: 'rejected',
      questionId: id,
      outcome: 'applied',
    })
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({ state: 'rejected', rejectReason: 'limit' })
  })

  it('never lets a third party answer a question sent to someone else', () => {
    const id = askOne(12)
    const answer = { v: 1, type: 'answer', questionId: id, text: 'soy otro', source: 'x', confidence: 'seguro' } satisfies Message
    expect(handle(answer, stranger)).toEqual({ kind: 'question', type: 'answer', questionId: id, outcome: 'ignored' })
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('sending')
  })

  it('reports a second decision as ignored instead of overwriting the first', () => {
    const id = askOne(13)
    handle({ v: 1, type: 'rejected', questionId: id, reason: 'expired' } satisfies Message)
    const answer = { v: 1, type: 'answer', questionId: id, text: 'tarde', source: 'x', confidence: 'seguro' } satisfies Message
    expect(handle(answer)).toEqual({ kind: 'question', type: 'answer', questionId: id, outcome: 'ignored' })
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('rejected')
  })
})

describe('handleAskerMessage — the responder role', () => {
  it('ignores every message that belongs to the other role and stores nothing', () => {
    const before = store.db.prepare('SELECT count(*) AS n FROM contacts').get() as { n: number }
    expect(handle({ v: 1, type: 'connect_request', requestId: uuid(3), name: 'Ana', note: '', relays: RELAYS } satisfies Message)).toEqual({
      kind: 'ignored',
      reason: 'other_role',
    })
    expect(handle({ v: 1, type: 'question', questionId: uuid(4), generation: 1, text: 'hola' } satisfies Message)).toEqual({ kind: 'ignored', reason: 'other_role' })
    expect(store.db.prepare('SELECT count(*) AS n FROM contacts').get()).toEqual(before)
  })
})
