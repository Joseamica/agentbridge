import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NOSTR,
  approveConnection,
  claimRequestNoticeSlot,
  getContact,
  handleResponderMessage,
  openStore,
  rejectConnection,
  setProfile,
  type Message,
  type OpenedMessage,
  type Store,
} from '@agentbridge/core'
import { testIdentity } from './support/keys'

const responder = testIdentity(51)
const asker = testIdentity(52)
const stranger = testIdentity(53)
const T0 = 2_000_000_000
const hex = (n: number) => n.toString(16).padStart(64, '0')
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
let store: Store
let nextId = 1

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-inbound-')), 'home'))
  setProfile(store, { name: 'Ana', relays: ['wss://mine.example.com'], now: T0 })
})
afterEach(() => store.close())

function opened(message: Message, over: { sender?: string; createdAt?: number; rumorId?: string } = {}): OpenedMessage {
  const sender = over.sender ?? asker.publicKey
  const rumor = { id: over.rumorId ?? hex(nextId++), pubkey: sender, created_at: over.createdAt ?? T0, kind: NOSTR.rumorKind, tags: [], content: JSON.stringify(message) }
  return { ok: true, wrapId: hex(10_000 + nextId++), senderPubkey: sender, rumor, message, powBits: message.type === 'connect_request' ? 22 : 16 }
}

const handle = (message: OpenedMessage, now = T0) => handleResponderMessage(store, { identity: responder, opened: message, now })
const request = (relays: string[] = ['wss://asker.example.com'], requestId = uuid(1)): Message => ({ v: 1, type: 'connect_request', requestId, name: 'Beto', note: 'hola', relays })
const outboxCount = () => Number(store.db.prepare('SELECT count(*) AS n FROM outbox').get()?.n)
const tableCount = (table: string) => Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n)

describe('handleResponderMessage', () => {
  it('stores a new connection request, marks a notice as pending, and recognizes its duplicate', () => {
    const message = opened(request())
    expect(handle(message)).toEqual({ kind: 'request', outcome: 'stored' })
    expect(claimRequestNoticeSlot(store, T0)).toBe(true)
    expect(handle(message)).toEqual({ kind: 'request', outcome: 'duplicate' })
    expect(getContact(store, asker.publicKey, 'inbound')).toMatchObject({ state: 'requested', declaredName: 'Beto', relays: ['wss://asker.example.com'] })
  })

  it('ignores a request older than 7 days and one without any usable relay', () => {
    expect(handle(opened(request(), { createdAt: T0 - NOSTR.requestMaxAgeSeconds - 1 }))).toEqual({ kind: 'ignored', reason: 'request_too_old' })
    expect(handle(opened(request(['ws://127.0.0.1:1', 'http://x.example.com'])))).toEqual({ kind: 'ignored', reason: 'no_relays' })
    expect(tableCount('contacts')).toBe(0)
    expect(tableCount('requests')).toBe(0)
  })

  it('answers a retried approved request with the same approval rumor, once the regeneration limit allows', () => {
    const first = opened(request())
    handle(first)
    approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })
    const approval = store.db.prepare('SELECT rumor_id FROM outbox').get()?.rumor_id
    store.db.prepare('DELETE FROM outbox').run()
    // A retry is the very same rumor in a new wrap: same content, same relays.
    expect(handle(first, T0 + 60)).toEqual({ kind: 'request', outcome: 'approved_already' })
    expect(outboxCount()).toBe(0)
    expect(handle(first, T0 + NOSTR.regenerationIntervalSeconds)).toEqual({ kind: 'request', outcome: 'approved_already' })
    expect(store.db.prepare('SELECT rumor_id, relays FROM outbox').all()).toEqual([{ rumor_id: approval, relays: JSON.stringify(['wss://asker.example.com']) }])
  })

  it('answers a new request from an already approved key at the relays that request carries', () => {
    handle(opened(request()))
    approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })
    store.db.prepare('DELETE FROM outbox').run()
    const again = opened(request(['wss://otro.example.com'], uuid(2)))
    expect(handle(again, T0 + 60)).toEqual({ kind: 'request', outcome: 'approved_already' })
    const [row] = store.db.prepare("SELECT relays, json_extract(rumor_json, '$.content') AS content FROM outbox").all() as Array<{ relays: string; content: string }>
    expect(row!.relays).toBe(JSON.stringify(['wss://otro.example.com']))
    expect(JSON.parse(row!.content)).toMatchObject({ type: 'connect_approved', requestId: uuid(2), generation: 1 })
  })

  it('answers a retried rejected request with the same rejection', () => {
    const first = opened(request())
    handle(first)
    rejectConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })
    store.db.prepare('DELETE FROM outbox').run()
    expect(handle(first, T0 + NOSTR.regenerationIntervalSeconds)).toEqual({ kind: 'request', outcome: 'rejected_already' })
    expect(outboxCount()).toBe(1)
  })

  it('ignores a new request from a key rejected in the last 7 days', () => {
    handle(opened(request()))
    rejectConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })
    store.db.prepare('DELETE FROM outbox').run()
    expect(handle(opened(request(undefined, uuid(2))), T0 + 60)).toEqual({ kind: 'request', outcome: 'ignored_recently_rejected' })
    expect(outboxCount()).toBe(0)
  })

  it('admits questions from approved contacts and stores nothing for strangers', () => {
    handle(opened(request()))
    approveConnection(store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: T0 })
    const question: Message = { v: 1, type: 'question', questionId: uuid(5), generation: 1, text: '¿Qué tal?' }
    expect(handle(opened(question))).toEqual({ kind: 'question', outcome: { kind: 'queued' } })
    expect(handle(opened(question, { sender: stranger.publicKey }))).toEqual({ kind: 'question', outcome: { kind: 'dropped', reason: 'unrelated' } })
    expect(tableCount('inbox_questions')).toBe(1)
  })

  it('leaves messages for the asker role alone', () => {
    const before = { contacts: tableCount('contacts'), outbox: outboxCount() }
    for (const message of [
      { v: 1, type: 'connect_approved', requestId: uuid(1), generation: 1, name: 'X', relays: ['wss://x.example.com'] },
      { v: 1, type: 'connect_rejected', requestId: uuid(1) },
      { v: 1, type: 'connect_revoked', generation: 2 },
      { v: 1, type: 'receipt', questionId: uuid(1) },
      { v: 1, type: 'answer', questionId: uuid(1), text: 'x', source: 'y', confidence: 'creo' },
      { v: 1, type: 'rejected', questionId: uuid(1), reason: 'limit' },
    ] satisfies Message[]) {
      expect(handle(opened(message))).toEqual({ kind: 'ignored', reason: 'other_role' })
    }
    expect({ contacts: tableCount('contacts'), outbox: outboxCount() }).toEqual(before)
  })
})
