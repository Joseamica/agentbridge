import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  NOSTR,
  UserFacingError,
  applyApproval,
  applyRejection,
  applyRevocation,
  approveRequest,
  askPermission,
  createOutboundRequest,
  findRequestsByPrefix,
  getContact,
  isQuestionAllowed,
  listPendingRequests,
  openStore,
  purgeRequests,
  recordIncomingRequest,
  rejectRequest,
  revokeInbound,
  slugifyName,
  type Store,
} from '@agentbridge/core'

const pk = (n: number) => n.toString(16).padStart(64, '0')
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const rumorId = (n: number) => `f${n.toString(16).padStart(63, '0')}`
const DAY = 86_400
let store: Store

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-contacts-')), 'home'))
})

function request(n: number, overrides: Partial<Parameters<typeof recordIncomingRequest>[1]> = {}) {
  return recordIncomingRequest(store, {
    pubkey: pk(n),
    requestId: uuid(n),
    requestRumorId: rumorId(n),
    declaredName: `Persona ${n}`,
    note: 'hola',
    relays: ['wss://relay.primal.net/', 'ws://127.0.0.1:9'],
    now: 1_000_000 + n,
    ...overrides,
  })
}

describe('inbound requests', () => {
  it('stores a request with sanitized relays', () => {
    expect(request(1)).toEqual({ kind: 'stored', evictedPubkey: null })
    expect(getContact(store, pk(1), 'inbound')).toMatchObject({
      state: 'requested',
      generation: 0,
      requestId: uuid(1),
      relays: ['wss://relay.primal.net'],
    })
  })

  it('keeps one pending request per key: a retry is a duplicate, a newer request replaces it, a retry of the replaced one is stale', () => {
    request(1)
    expect(request(1)).toEqual({ kind: 'duplicate' })
    expect(request(1, { requestId: uuid(99), requestRumorId: rumorId(99), note: 'nueva' })).toEqual({ kind: 'stored', evictedPubkey: null })
    expect(getContact(store, pk(1), 'inbound')).toMatchObject({ requestId: uuid(99), note: 'nueva' })
    expect(request(1)).toEqual({ kind: 'ignored_stale' })
    expect(getContact(store, pk(1), 'inbound')?.requestId).toBe(uuid(99))
    expect(listPendingRequests(store)).toHaveLength(1)
  })

  it('reports a conflict when a known request id arrives inside a different rumor', () => {
    request(1)
    expect(request(1, { requestRumorId: rumorId(500) })).toEqual({ kind: 'conflict' })
  })

  it('evicts the oldest pending request when the list is full instead of refusing new ones', () => {
    for (let n = 1; n <= NOSTR.maxPendingRequests; n++) request(n)
    expect(request(500)).toEqual({ kind: 'stored', evictedPubkey: pk(1) })
    expect(getContact(store, pk(1), 'inbound')).toBeNull()
    expect(listPendingRequests(store)).toHaveLength(NOSTR.maxPendingRequests)
  })

  it('keeps the generation counter of a previously approved person when their new request is evicted', () => {
    request(1)
    approveRequest(store, { pubkey: pk(1), now: 2_000_000 })
    revokeInbound(store, { pubkey: pk(1), now: 2_000_001 })
    request(1, { requestId: uuid(77), requestRumorId: rumorId(77), now: 2_000_002 })
    for (let n = 2; n <= NOSTR.maxPendingRequests + 1; n++) request(n, { now: 3_000_000 + n })
    expect(getContact(store, pk(1), 'inbound')).toMatchObject({ state: 'revoked', generation: 2, requestId: null })
  })

  it('approves once, assigns unique local names, and treats a second approval as no change', () => {
    request(1, { declaredName: 'Ana' })
    request(2, { declaredName: 'Ana' })
    const first = approveRequest(store, { pubkey: pk(1), now: 2_000_000 })
    expect(first.changed).toBe(true)
    expect(first.contact).toMatchObject({ state: 'approved', generation: 1, maxGenerationSeen: 1, localName: 'ana' })
    expect(approveRequest(store, { pubkey: pk(2), now: 2_000_001 }).contact.localName).toBe('ana-2')
    expect(approveRequest(store, { pubkey: pk(1), now: 2_000_002 })).toMatchObject({ changed: false, contact: { generation: 1 } })
  })

  it('refuses to approve when there is no request, in Spanish', () => {
    expect(() => approveRequest(store, { pubkey: pk(9), now: 1 })).toThrow(UserFacingError)
  })

  it('repeats the approval for a retried request and for a brand-new request from an approved person', () => {
    request(1)
    approveRequest(store, { pubkey: pk(1), now: 2_000_000 })
    expect(request(1)).toMatchObject({ kind: 'approved_already', contact: { generation: 1 } })
    expect(request(1, { requestId: uuid(40), requestRumorId: rumorId(40) })).toMatchObject({ kind: 'approved_already', contact: { generation: 1 } })
    expect(request(1, { requestId: uuid(40), requestRumorId: rumorId(40) })).toMatchObject({ kind: 'approved_already' })
  })

  it('handles rejection: the same request repeats the decision, others are ignored for 7 days, then accepted again', () => {
    request(1, { now: 1_000_000 })
    expect(rejectRequest(store, { pubkey: pk(1), now: 1_000_100 }).contact.state).toBe('rejected')
    expect(request(1, { now: 1_000_200 })).toMatchObject({ kind: 'rejected_already' })
    expect(request(1, { requestId: uuid(50), requestRumorId: rumorId(50), now: 1_000_300 })).toEqual({ kind: 'ignored_recently_rejected' })
    expect(request(1, { requestId: uuid(51), requestRumorId: rumorId(51), now: 1_000_100 + 7 * DAY })).toEqual({ kind: 'stored', evictedPubkey: null })
  })

  it('revokes with a strictly higher generation and only allows questions carrying the current one', () => {
    request(1)
    approveRequest(store, { pubkey: pk(1), now: 2_000_000 })
    expect(isQuestionAllowed(store, pk(1), 1)).toBe(true)
    expect(revokeInbound(store, { pubkey: pk(1), now: 2_000_001 })).toMatchObject({ changed: true, contact: { state: 'revoked', generation: 2 } })
    expect(isQuestionAllowed(store, pk(1), 1)).toBe(false)
    expect(revokeInbound(store, { pubkey: pk(1), now: 2_000_002 }).changed).toBe(false)
    request(1, { requestId: uuid(60), requestRumorId: rumorId(60), now: 2_000_003 })
    expect(approveRequest(store, { pubkey: pk(1), now: 2_000_004 }).contact.generation).toBe(3)
    expect(isQuestionAllowed(store, pk(1), 3)).toBe(true)
    expect(isQuestionAllowed(store, pk(1), 1)).toBe(false)
  })

  it('never lets a retry of an old approved request displace a newer pending one', () => {
    request(1)
    approveRequest(store, { pubkey: pk(1), now: 2_000_000 })
    revokeInbound(store, { pubkey: pk(1), now: 2_000_001 })
    expect(request(1)).toEqual({ kind: 'ignored_stale' })
    request(1, { requestId: uuid(70), requestRumorId: rumorId(70), now: 2_000_002 })
    expect(request(1)).toEqual({ kind: 'ignored_stale' })
    expect(getContact(store, pk(1), 'inbound')).toMatchObject({ state: 'requested', requestId: uuid(70) })
  })

  it('refuses to revoke someone who never had permission', () => {
    request(1)
    expect(() => revokeInbound(store, { pubkey: pk(1), now: 1 })).toThrow(UserFacingError)
  })

  it('drops pending requests after 7 days and forgets request records after 9', () => {
    request(1, { now: 1_000_000 })
    request(2, { now: 1_000_000 + 6 * DAY })
    expect(purgeRequests(store, 1_000_001 + 7 * DAY)).toEqual({ droppedPending: 1, forgottenRecords: 0 })
    expect(listPendingRequests(store).map((c) => c.pubkey)).toEqual([pk(2)])
    expect(purgeRequests(store, 1_000_000 + 9 * DAY)).toEqual({ droppedPending: 0, forgottenRecords: 1 })
    expect(request(1, { now: 1_000_000 + 9 * DAY })).toEqual({ kind: 'stored', evictedPubkey: null })
  })

  it('finds pending requests by a key prefix of at least 8 hex characters', () => {
    request(0x1234abcd)
    expect(findRequestsByPrefix(store, pk(0x1234abcd).slice(0, 8))).toHaveLength(1)
    expect(() => findRequestsByPrefix(store, 'abc')).toThrow(UserFacingError)
    expect(() => findRequestsByPrefix(store, "'; DROP TABLE contacts; --")).toThrow(UserFacingError)
  })

  it('narrows or widens the match with an explicit states list', () => {
    request(0x1234abcd)
    approveRequest(store, { pubkey: pk(0x1234abcd), now: 1 })
    expect(findRequestsByPrefix(store, pk(0x1234abcd).slice(0, 8))).toHaveLength(0)
    expect(findRequestsByPrefix(store, pk(0x1234abcd).slice(0, 8), ['requested', 'approved'])).toHaveLength(1)
  })
})

describe('outbound requests', () => {
  const link = { relays: ['wss://nos.lol'] }

  it('creates one pending request per person and returns the same request id on retries', () => {
    const first = createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(1), ...link, now: 10 })
    expect(first).toMatchObject({ created: true, contact: { state: 'pending', requestId: uuid(1), relays: ['wss://nos.lol'] } })
    expect(createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(2), ...link, now: 11 })).toMatchObject({
      created: false,
      contact: { requestId: uuid(1) },
    })
  })

  it('refuses a link without any valid relay, in Spanish', () => {
    expect(() => createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(1), relays: ['ws://127.0.0.1:1'], now: 1 })).toThrow(UserFacingError)
  })

  it('applies approvals only for the pending request and a higher generation; late older messages are ignored', () => {
    createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(1), ...link, now: 10 })
    expect(applyApproval(store, { pubkey: pk(1), requestId: uuid(9), generation: 1, name: 'Dev', relays: [], now: 11 })).toBe('ignored')
    expect(applyApproval(store, { pubkey: pk(1), requestId: uuid(1), generation: 3, name: 'Dev Ejemplo', relays: ['wss://relay.primal.net'], now: 12 })).toBe('applied')
    expect(askPermission(store, pk(1))).toEqual({ generation: 3 })
    expect(getContact(store, pk(1), 'outbound')).toMatchObject({ localName: 'dev-ejemplo', relays: ['wss://relay.primal.net'] })
    expect(applyRevocation(store, { pubkey: pk(1), generation: 2, now: 13 })).toBe('ignored')
    expect(askPermission(store, pk(1))).toEqual({ generation: 3 })
    expect(applyRevocation(store, { pubkey: pk(1), generation: 4, now: 14 })).toBe('applied')
    expect(askPermission(store, pk(1))).toBeNull()
    expect(applyApproval(store, { pubkey: pk(1), requestId: uuid(1), generation: 5, name: 'Dev', relays: [], now: 15 })).toBe('ignored')
  })

  it('never turns a rejected request into an approval', () => {
    createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(1), ...link, now: 10 })
    expect(applyRejection(store, { pubkey: pk(1), requestId: uuid(2), now: 11 })).toBe('ignored')
    expect(applyRejection(store, { pubkey: pk(1), requestId: uuid(1), now: 12 })).toBe('applied')
    expect(applyApproval(store, { pubkey: pk(1), requestId: uuid(1), generation: 1, name: 'Dev', relays: [], now: 13 })).toBe('ignored')
    expect(getContact(store, pk(1), 'outbound')?.state).toBe('rejected')
  })

  it('keeps a pending request pending when a late revocation of an older permission arrives', () => {
    createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(1), ...link, now: 10 })
    expect(applyRevocation(store, { pubkey: pk(1), generation: 2, now: 11 })).toBe('applied')
    expect(getContact(store, pk(1), 'outbound')).toMatchObject({ state: 'pending', maxGenerationSeen: 2 })
    expect(applyApproval(store, { pubkey: pk(1), requestId: uuid(1), generation: 3, name: 'Dev', relays: [], now: 12 })).toBe('applied')
  })

  it('leaves a young pending request untouched but replaces one at least a retry window old, keeping generation counters', () => {
    createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(1), ...link, now: 10 })
    expect(applyRevocation(store, { pubkey: pk(1), generation: 2, now: 11 })).toBe('applied')
    expect(createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(2), ...link, now: 10 + NOSTR.retryWindowSeconds - 1 })).toMatchObject({
      created: false,
      contact: { requestId: uuid(1), maxGenerationSeen: 2 },
    })
    expect(createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(2), ...link, now: 10 + NOSTR.retryWindowSeconds })).toMatchObject({
      created: true,
      contact: { requestId: uuid(2), state: 'pending', generation: 0, maxGenerationSeen: 2, requestedAt: 10 + NOSTR.retryWindowSeconds },
    })
  })

  it('keeps maxGenerationSeen through a revocation and a late approval attempt, then replaces the stale pending request', () => {
    createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(1), ...link, now: 10 })
    expect(applyRevocation(store, { pubkey: pk(1), generation: 2, now: 11 })).toBe('applied')
    expect(getContact(store, pk(1), 'outbound')).toMatchObject({ state: 'pending', maxGenerationSeen: 2 })
    expect(applyApproval(store, { pubkey: pk(1), requestId: uuid(1), generation: 1, name: 'Dev', relays: [], now: 12 })).toBe('ignored')
    expect(createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(2), ...link, now: 10 + NOSTR.retryWindowSeconds })).toMatchObject({
      created: true,
      contact: { requestId: uuid(2), state: 'pending', maxGenerationSeen: 2 },
    })
  })

  it('refuses a new request when permission already exists, and allows one after a rejection', () => {
    createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(1), ...link, now: 10 })
    applyApproval(store, { pubkey: pk(1), requestId: uuid(1), generation: 1, name: 'Dev', relays: [], now: 11 })
    expect(() => createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(2), ...link, now: 12 })).toThrow(UserFacingError)
    createOutboundRequest(store, { pubkey: pk(2), requestId: uuid(3), ...link, now: 10 })
    applyRejection(store, { pubkey: pk(2), requestId: uuid(3), now: 11 })
    expect(createOutboundRequest(store, { pubkey: pk(2), requestId: uuid(4), ...link, now: 12 })).toMatchObject({
      created: true,
      contact: { requestId: uuid(4) },
    })
  })
})

describe('slugifyName', () => {
  it.each([
    ['María Núñez', 'maria-nunez'],
    ['  Dev   Ejemplo!! ', 'dev-ejemplo'],
    ['!!!', 'contacto'],
    ['x', 'contacto'],
    ['a'.repeat(60), 'a'.repeat(24)],
  ])('%j becomes %j', (input, expected) => {
    expect(slugifyName(input)).toBe(expected)
  })
})
