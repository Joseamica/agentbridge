import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NOSTR,
  UserFacingError,
  admitQuestion,
  applyApproval,
  approveConnection,
  claimDue,
  claimRequestNoticeSlot,
  createOutboundQuestion,
  createOutboundRequest,
  getContact,
  getInboxQuestion,
  getOutboundQuestion,
  listRequests,
  markRequestNoticePending,
  openStore,
  recordIncomingRequest,
  regenerateRequestDecision,
  rejectConnection,
  revokeConnection,
  setProfile,
  type Store,
} from '@agentbridge/core'
import { testIdentity } from './support/keys'

const responder = testIdentity(41)
const asker = testIdentity(42)
const T0 = 2_000_000_000
const ASKER_RELAYS = ['wss://asker.example.com']
const MY_RELAYS = ['wss://mine.example.com']
const hex = (n: number) => n.toString(16).padStart(64, '0')
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const REQUEST_ID = uuid(7)
let store: Store

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-connections-')), 'home'))
})
afterEach(() => store.close())

function requestFrom(identity = asker, now = T0, requestId = REQUEST_ID): void {
  recordIncomingRequest(store, { pubkey: identity.publicKey, requestId, requestRumorId: hex(1), declaredName: 'Beto', note: 'Soy del equipo', relays: ASKER_RELAYS, now })
}

type Row = { recipient: string; rumor_id: string; label: string; relays: string; content: string }
const outbox = () =>
  store.db.prepare("SELECT recipient, rumor_id, label, relays, json_extract(rumor_json, '$.content') AS content FROM outbox ORDER BY rowid").all() as Row[]

describe('listRequests', () => {
  it('shows pending requests with an 8-character id, and drops them after 7 days', () => {
    requestFrom()
    expect(listRequests(store, T0 + 10)).toEqual([
      { id: asker.publicKey.slice(0, 8), pubkey: asker.publicKey, declaredName: 'Beto', note: 'Soy del equipo', requestedAt: T0 },
    ])
    expect(listRequests(store, T0 + NOSTR.requestMaxAgeSeconds)).toEqual([])
  })

  it('clears the pending request notice, because the person is looking at the list', () => {
    requestFrom()
    markRequestNoticePending(store, T0)
    listRequests(store, T0 + 1)
    expect(claimRequestNoticeSlot(store, T0 + 2)).toBe(false)
  })
})

describe('approveConnection', () => {
  it('needs the responder’s name first', () => {
    requestFrom()
    expect(() => approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })).toThrow(UserFacingError)
    expect(getContact(store, asker.publicKey, 'inbound')?.state).toBe('requested')
  })

  it('approves once, stores the decision rumor and enqueues connect_approved', () => {
    setProfile(store, { name: 'Ana', relays: MY_RELAYS, now: T0 })
    requestFrom()
    const first = approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8).toUpperCase(), now: T0 + 1 })
    expect(first.changed).toBe(true)
    expect(first.contact).toMatchObject({ state: 'approved', generation: 1, localName: 'beto' })
    const rows = outbox()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ recipient: asker.publicKey, label: 'connect_approved', relays: JSON.stringify(ASKER_RELAYS) })
    expect(JSON.parse(rows[0]!.content)).toEqual({ v: 1, type: 'connect_approved', requestId: REQUEST_ID, generation: 1, name: 'Ana', relays: MY_RELAYS })
    const stored = store.db.prepare('SELECT decision_rumor_json AS j FROM requests WHERE request_id = ?').get(REQUEST_ID)?.j as string
    expect(JSON.parse(stored).id).toBe(rows[0]!.rumor_id)
    expect(approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 + 2 }).changed).toBe(false)
    expect(outbox()).toHaveLength(1)
  })

  it('explains bad, unknown and ambiguous identifiers', () => {
    setProfile(store, { name: 'Ana', now: T0 })
    expect(() => approveConnection(store, { identity: responder, idPrefix: 'abc', now: T0 })).toThrow(/al menos 8/)
    expect(() => approveConnection(store, { identity: responder, idPrefix: 'ffffffff', now: T0 })).toThrow(/ninguna solicitud/)
    const twin = testIdentity(43)
    requestFrom()
    requestFrom(twin, T0, uuid(8))
    store.db.prepare("UPDATE contacts SET pubkey = ? || substr(pubkey, 9) WHERE pubkey = ?").run(asker.publicKey.slice(0, 8), twin.publicKey)
    expect(() => approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })).toThrow(/varias/)
  })

  it('refuses to approve a request with no relays to answer at', () => {
    setProfile(store, { name: 'Ana', now: T0 })
    recordIncomingRequest(store, { pubkey: asker.publicKey, requestId: REQUEST_ID, requestRumorId: hex(1), declaredName: 'Beto', note: 'Soy del equipo', relays: [], now: T0 })
    expect(() => approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 + 1 })).toThrow(
      'Esa solicitud no trae tableros donde responder, así que no se puede aprobar. Pídele a esa persona que te envíe una solicitud nueva.',
    )
    expect(getContact(store, asker.publicKey, 'inbound')?.state).toBe('requested')
    expect(outbox()).toEqual([])
    const stored = store.db.prepare('SELECT decision_rumor_json AS j FROM requests WHERE request_id = ?').get(REQUEST_ID)?.j
    expect(stored).toBeNull()
  })

  it('re-approves after a revocation with a fresh generation', () => {
    setProfile(store, { name: 'Ana', relays: MY_RELAYS, now: T0 })
    requestFrom()
    approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })
    revokeConnection(store, { identity: responder, name: 'beto', now: T0 + 1 })
    requestFrom(asker, T0 + 2, uuid(50))
    store.db.prepare('DELETE FROM outbox').run()
    const result = approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 + 3 })
    expect(result.contact).toMatchObject({ state: 'approved', generation: 3 })
    const [row] = outbox()
    expect(JSON.parse(row!.content)).toMatchObject({ type: 'connect_approved', generation: 3 })
  })

  // I2: a prefix that matches a real contact whose decision already went the other way must not
  // collapse into the same "no encontrada" a genuinely unknown id gets — that would be the one kind
  // of lie a person can't debug (there IS a decision on file, just not the one being asked for).
  it('tells the truth when the contact already went the other way, instead of "no encontrada"', () => {
    setProfile(store, { name: 'Ana', relays: MY_RELAYS, now: T0 })
    requestFrom()
    rejectConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })
    expect(() => approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 + 1 })).toThrow(/ya le dijiste que no/i)
  })

  it('tells the truth when the contact was already revoked, instead of "no encontrada"', () => {
    setProfile(store, { name: 'Ana', relays: MY_RELAYS, now: T0 })
    requestFrom()
    approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })
    revokeConnection(store, { identity: responder, name: 'beto', now: T0 + 1 })
    // revokeInbound leaves request_id untouched, so the same prefix still matches this contact —
    // findInbound must recognize the 'revoked' state and say so, not report it as never having existed.
    expect(() => approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 + 2 })).toThrow(/retiraste el permiso/i)
  })
})

describe('rejectConnection', () => {
  it('rejects once and enqueues connect_rejected with the stored rumor', () => {
    requestFrom()
    const result = rejectConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 + 1 })
    expect(result).toMatchObject({ changed: true, contact: { state: 'rejected' } })
    expect(outbox().map((r) => JSON.parse(r.content))).toEqual([{ v: 1, type: 'connect_rejected', requestId: REQUEST_ID }])
    expect(rejectConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 + 2 }).changed).toBe(false)
  })

  // I2's other direction: rejecting a prefix that belongs to a contact already approved must say so,
  // not claim no such solicitud ever existed.
  it('tells the truth when the contact was already approved, instead of "no encontrada"', () => {
    setProfile(store, { name: 'Ana', relays: MY_RELAYS, now: T0 })
    requestFrom()
    approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })
    expect(() => rejectConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 + 1 })).toThrow(/ya le diste permiso/i)
  })

  it('tells the truth when the contact was already revoked, instead of "no encontrada"', () => {
    setProfile(store, { name: 'Ana', relays: MY_RELAYS, now: T0 })
    requestFrom()
    approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })
    revokeConnection(store, { identity: responder, name: 'beto', now: T0 + 1 })
    expect(() => rejectConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 + 2 })).toThrow(/retiraste el permiso/i)
  })
})

// C1: revokeConnection revokes the INBOUND relationship (whether that same pubkey may ask this
// person), but the outbox is a single shared table keyed only by recipient. Before the fix,
// deleteUnclaimedFor deleted every unclaimed row for that pubkey regardless of label, including this
// person's own OUTBOUND question to the same pubkey — the exact P11 violation, from the other
// direction, that this plan's tests otherwise guard against.
describe('revokeConnection — outbound survival across the same pubkey (P11 / C1)', () => {
  it('never deletes this person’s own in-flight outbound question to the pubkey whose inbound permission is revoked', () => {
    setProfile(store, { name: 'Ana', relays: MY_RELAYS, now: T0 })
    // Beto may ask me (inbound, about to be revoked) AND I may ask Beto (outbound, untouched) — an
    // ordinary bidirectional relationship, the kind `contacts` is built to display.
    createOutboundRequest(store, { pubkey: asker.publicKey, requestId: uuid(60), relays: ASKER_RELAYS, now: T0 })
    applyApproval(store, { pubkey: asker.publicKey, requestId: uuid(60), generation: 1, name: 'Beto', relays: ASKER_RELAYS, now: T0 })
    const { question } = createOutboundQuestion(store, { identity: responder, recipient: asker.publicKey, text: '¿sigues ahí?', now: T0 })

    requestFrom()
    approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 + 1 })
    const result = revokeConnection(store, { identity: responder, name: 'beto', now: T0 + 2 })
    expect(result.changed).toBe(true)

    const rows = outbox()
    expect(rows.map((r) => r.label)).toContain('question')
    expect(rows.find((r) => r.label === 'question')?.recipient).toBe(asker.publicKey)
    // The outbox row is the only retry mechanism a 'sending' question has (P11) — if it survived,
    // the question row itself must still say so too.
    expect(getOutboundQuestion(store, asker.publicKey, question.questionId)).toMatchObject({ state: 'sending' })
  })
})

describe('revokeConnection', () => {
  it('revokes in one transaction: decisions stored, unclaimed rows deleted, claimed rows kept, connect_revoked enqueued', () => {
    setProfile(store, { name: 'Ana', relays: MY_RELAYS, now: T0 })
    requestFrom()
    approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })
    const question = (n: number) =>
      admitQuestion(store, { identity: responder, senderPubkey: asker.publicKey, questionId: uuid(n), rumorId: hex(100 + n), rumorCreatedAt: T0, generation: 1, text: `p${n}`, now: T0 })
    question(1)
    question(2)
    const [claimed] = claimDue(store, { owner: 'publisher', now: T0, limit: 1, authorize: () => true })
    expect(claimed?.label).toBe('connect_approved')

    const result = revokeConnection(store, { identity: responder, name: ' BETO ', now: T0 + 5 })
    expect(result).toMatchObject({ changed: true, rejectedQuestions: 2, contact: { state: 'revoked', generation: 2 } })
    for (const n of [1, 2]) expect(getInboxQuestion(store, asker.publicKey, uuid(n))).toMatchObject({ state: 'rejected', rejectReason: 'stale_generation' })
    const rows = outbox()
    expect(rows.map((r) => r.label)).toEqual(['connect_approved', 'connect_revoked'])
    expect(JSON.parse(rows[1]!.content)).toEqual({ v: 1, type: 'connect_revoked', generation: 2 })
    expect(revokeConnection(store, { identity: responder, name: 'beto', now: T0 + 6 }).changed).toBe(false)
  })

  it('explains an unknown name', () => {
    expect(() => revokeConnection(store, { identity: responder, name: 'nadie', now: T0 })).toThrow(/ningún contacto/)
  })
})

describe('regenerateRequestDecision', () => {
  it('resends the stored decision rumor to the relays of the retried request', () => {
    setProfile(store, { name: 'Ana', relays: MY_RELAYS, now: T0 })
    requestFrom()
    approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })
    const original = outbox()[0]!
    store.db.prepare('DELETE FROM outbox').run()
    const newRelays = ['wss://nuevo.example.com']
    expect(regenerateRequestDecision(store, { identity: responder, senderPubkey: asker.publicKey, requestId: REQUEST_ID, replyRelays: newRelays, now: T0 + 60 })).toBe(
      'too_soon',
    )
    expect(outbox()).toEqual([])
    const later = T0 + NOSTR.regenerationIntervalSeconds
    expect(regenerateRequestDecision(store, { identity: responder, senderPubkey: asker.publicKey, requestId: REQUEST_ID, replyRelays: newRelays, now: later })).toBe('enqueued')
    expect(outbox()).toEqual([{ ...original, relays: JSON.stringify(newRelays) }])
    store.db.prepare('DELETE FROM outbox').run()
    expect(regenerateRequestDecision(store, { identity: responder, senderPubkey: asker.publicKey, requestId: REQUEST_ID, replyRelays: newRelays, now: later + 60 })).toBe(
      'too_soon',
    )
  })

  it('creates and stores an approval for a request recorded as approved after the fact', () => {
    setProfile(store, { name: 'Ana', relays: MY_RELAYS, now: T0 })
    requestFrom()
    approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })
    store.db.prepare('DELETE FROM outbox').run()
    const again = uuid(99)
    expect(recordIncomingRequest(store, { pubkey: asker.publicKey, requestId: again, requestRumorId: hex(2), declaredName: 'Beto', note: '', relays: ASKER_RELAYS, now: T0 + 1 }).kind).toBe(
      'approved_already',
    )
    expect(regenerateRequestDecision(store, { identity: responder, senderPubkey: asker.publicKey, requestId: again, replyRelays: [], now: T0 + 1 })).toBe('enqueued')
    const [row] = outbox()
    expect(JSON.parse(row!.content)).toMatchObject({ type: 'connect_approved', requestId: again, generation: 1 })
    expect(row!.relays).toBe(JSON.stringify(ASKER_RELAYS))
  })

  it('does nothing for an undecided request', () => {
    requestFrom()
    expect(regenerateRequestDecision(store, { identity: responder, senderPubkey: asker.publicKey, requestId: REQUEST_ID, replyRelays: ASKER_RELAYS, now: T0 })).toBe('nothing')
  })

  it('reports abandoned and leaves the resend clock alone when the outbox row was abandoned', () => {
    setProfile(store, { name: 'Ana', relays: MY_RELAYS, now: T0 })
    requestFrom()
    approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })
    claimDue(store, { owner: 'someone-else', now: T0, limit: 10, authorize: () => false })
    const later = T0 + NOSTR.regenerationIntervalSeconds
    expect(regenerateRequestDecision(store, { identity: responder, senderPubkey: asker.publicKey, requestId: REQUEST_ID, replyRelays: ASKER_RELAYS, now: later })).toBe(
      'abandoned',
    )
    const resentAt = store.db.prepare('SELECT decision_resent_at AS r FROM requests WHERE request_id = ?').get(REQUEST_ID)?.r
    expect(resentAt).toBeNull()
  })

  it('reports enqueued but leaves the resend clock alone when the outbox row is still pending', () => {
    setProfile(store, { name: 'Ana', relays: MY_RELAYS, now: T0 })
    requestFrom()
    approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })
    const later = T0 + NOSTR.regenerationIntervalSeconds
    expect(regenerateRequestDecision(store, { identity: responder, senderPubkey: asker.publicKey, requestId: REQUEST_ID, replyRelays: ASKER_RELAYS, now: later })).toBe(
      'enqueued',
    )
    const resentAt = store.db.prepare('SELECT decision_resent_at AS r FROM requests WHERE request_id = ?').get(REQUEST_ID)?.r
    expect(resentAt).toBeNull()
    expect(outbox()).toHaveLength(1)
  })
})
