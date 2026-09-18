import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NOSTR,
  admitQuestion,
  applyApproval,
  applyRejected,
  applyRevocation,
  approveRequest,
  authorizeOutboxItem,
  createOutboundQuestion,
  createOutboundRequest,
  openStore,
  recordIncomingRequest,
  revokeInbound,
  type Message,
  type OutboxItem,
  type Store,
} from '@agentbridge/core'
import { testIdentity } from './support/keys'

const me = testIdentity(71)
const asker = testIdentity(72)
const responder = testIdentity(73)
const T0 = 2_000_000_000
const RELAYS = ['wss://r.example.com']
const hex = (n: number) => n.toString(16).padStart(64, '0')
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
let store: Store
let n = 1

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-authorize-')), 'home'))
})
afterEach(() => store.close())

const item = (recipient: string, message: Message | { junk: true }): OutboxItem => ({
  recipient,
  rumorId: hex(n),
  rumor: { id: hex(n++), pubkey: me.publicKey, created_at: T0, kind: NOSTR.rumorKind, tags: [], content: JSON.stringify(message) },
  label: 'test',
  powBits: 16,
  relays: RELAYS,
  policy: 'once',
  attempts: 0,
  firstEnqueuedAt: T0,
})
const allowed = (recipient: string, message: Message | { junk: true }) => authorizeOutboxItem(store, item(recipient, message))

// A stored outbound question (approved contact, then a question this identity actually sent), built
// the same way the other tests in this file build their items: a synthetic OutboxItem carrying the
// real question's id and generation, so authorizeOutboxItem can look the row up.
function seedQuestionItem(options: { generation: number }): OutboxItem {
  createOutboundRequest(store, { pubkey: responder.publicKey, requestId: uuid(20), relays: RELAYS, now: T0 })
  applyApproval(store, { pubkey: responder.publicKey, requestId: uuid(20), generation: options.generation, name: 'Ana', relays: RELAYS, now: T0 })
  const { question } = createOutboundQuestion(store, { identity: me, recipient: responder.publicKey, text: 'hola', now: T0, newQuestionId: () => uuid(21) })
  return item(responder.publicKey, { v: 1, type: 'question', questionId: question.questionId, generation: question.generation, text: 'hola' })
}

function questionIdOf(seeded: OutboxItem): string {
  return (JSON.parse(seeded.rumor.content) as { questionId: string }).questionId
}

function approveAsker(): void {
  recordIncomingRequest(store, { pubkey: asker.publicKey, requestId: uuid(1), requestRumorId: hex(9000), declaredName: 'Beto', note: '', relays: RELAYS, now: T0 })
  approveRequest(store, { pubkey: asker.publicKey, now: T0 })
}

describe('authorizeOutboxItem', () => {
  it('lets rejections and revocations go to anyone', () => {
    expect(allowed(asker.publicKey, { v: 1, type: 'connect_rejected', requestId: uuid(1) })).toBe(true)
    expect(allowed(asker.publicKey, { v: 1, type: 'connect_revoked', generation: 2 })).toBe(true)
    expect(allowed(asker.publicKey, { v: 1, type: 'rejected', questionId: uuid(2), reason: 'stale_generation' })).toBe(true)
  })

  it('sends an approval only while it is the current one', () => {
    approveAsker()
    const approval: Message = { v: 1, type: 'connect_approved', requestId: uuid(1), generation: 1, name: 'Ana', relays: RELAYS }
    expect(allowed(asker.publicKey, approval)).toBe(true)
    expect(allowed(asker.publicKey, { ...approval, generation: 2 })).toBe(false)
    revokeInbound(store, { pubkey: asker.publicKey, now: T0 + 1 })
    expect(allowed(asker.publicKey, approval)).toBe(false)
  })

  it('sends receipts and answers only while the question’s generation is current', () => {
    approveAsker()
    admitQuestion(store, { identity: me, senderPubkey: asker.publicKey, questionId: uuid(3), rumorId: hex(3000), rumorCreatedAt: T0, generation: 1, text: 'hola', now: T0 })
    expect(allowed(asker.publicKey, { v: 1, type: 'receipt', questionId: uuid(3) })).toBe(true)
    expect(allowed(asker.publicKey, { v: 1, type: 'answer', questionId: uuid(3), text: 'sí', source: 'a.md', confidence: 'seguro' })).toBe(true)
    expect(allowed(asker.publicKey, { v: 1, type: 'receipt', questionId: uuid(4) })).toBe(false)
    revokeInbound(store, { pubkey: asker.publicKey, now: T0 + 1 })
    expect(allowed(asker.publicKey, { v: 1, type: 'answer', questionId: uuid(3), text: 'sí', source: 'a.md', confidence: 'seguro' })).toBe(false)
  })

  it('sends a request only while it is pending, and questions only for the current approval', () => {
    createOutboundRequest(store, { pubkey: responder.publicKey, requestId: uuid(10), relays: RELAYS, now: T0 })
    const request: Message = { v: 1, type: 'connect_request', requestId: uuid(10), name: 'Beto', note: '', relays: RELAYS }
    expect(allowed(responder.publicKey, request)).toBe(true)
    expect(allowed(responder.publicKey, { ...request, requestId: uuid(11) })).toBe(false)
    const question: Message = { v: 1, type: 'question', questionId: uuid(12), generation: 1, text: '¿Hola?' }
    expect(allowed(responder.publicKey, question)).toBe(false)
    applyApproval(store, { pubkey: responder.publicKey, requestId: uuid(10), generation: 1, name: 'Ana', relays: RELAYS, now: T0 + 1 })
    expect(allowed(responder.publicKey, question)).toBe(true)
    expect(allowed(responder.publicKey, request)).toBe(false)
    expect(allowed(responder.publicKey, { ...question, generation: 2 })).toBe(false)
  })

  it('refuses content that is not a protocol message', () => {
    expect(allowed(asker.publicKey, { junk: true })).toBe(false)
  })

  it('keeps authorizing a retry of a question that was sent before the contact revoked', () => {
    // Seeded as approved, one question sent, then the contact revoked.
    const item = seedQuestionItem({ generation: 1 })
    applyRevocation(store, { pubkey: responder.publicKey, generation: 2, now: T0 + 5 })
    expect(authorizeOutboxItem(store, item)).toBe(true)
  })

  it('refuses a question whose own row already ended, once the contact is no longer approved', () => {
    // Both halves of the rule have to be false for the answer to be false: while the contact is
    // still approved with that generation, the first check alone authorizes the row — which is the
    // ordinary case and not what this test is about.
    const item = seedQuestionItem({ generation: 1 })
    applyRevocation(store, { pubkey: responder.publicKey, generation: 2, now: T0 + 5 })
    applyRejected(store, { recipient: responder.publicKey, questionId: questionIdOf(item), reason: 'stale_generation', now: T0 + 6 })
    expect(authorizeOutboxItem(store, item)).toBe(false)
  })
})
