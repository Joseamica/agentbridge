import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UserFacingError,
  applyApproval,
  createOutboundRequest,
  encodeLink,
  getContact,
  getOutboundQuestion,
  SeenIds,
  nowSeconds,
  openStore,
  openWrap,
  precheckWrap,
  setProfile,
  type Message,
  type Store,
} from '@agentbridge/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { plainSocketFactory, startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { testIdentity } from '../../core/test/support/keys'
import { AskerService } from '../src/asker/service'

const me = testIdentity(51)
const them = testIdentity(52)
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

let board: FakeBoard
let store: Store
let service: AskerService

// Every relay a test uses is a local fake board, so the policy that normally rejects ws:// and
// loopback addresses has to be relaxed here — exactly as the responder harness does.
const allowAnyRelay = (inputs: readonly unknown[]): string[] =>
  inputs.filter((value): value is string => typeof value === 'string' && value.startsWith('ws')).slice(0, 5)

beforeEach(async () => {
  board = await startFakeBoard()
  const home = join(await mkdtemp(join(tmpdir(), 'ab-asker-')), 'home')
  store = await openStore(home, { relayPolicy: allowAnyRelay })
  setProfile(store, { name: 'Beto', relays: [board.url], now: 2_000_000_000 })
  service = new AskerService({ store, identity: me, createSocket: plainSocketFactory })
})

afterEach(async () => {
  await service.close()
  store.close()
  await board.close()
})

// What the other person's relay actually received, opened with their key. `precheckWrap` and
// `openWrap` both take an OpenContext and both discriminate on `.ok` (they are plan 1's real
// signatures; `openWrap` is synchronous).
function received(): Message[] {
  const ctx = { identity: them, now: nowSeconds(), seen: new SeenIds() }
  const messages: Message[] = []
  for (const event of board.events) {
    const prechecked = precheckWrap(event, ctx)
    if (!prechecked.ok) continue
    const opened = openWrap(prechecked, ctx)
    if (opened.ok) messages.push(opened.message)
  }
  return messages
}

describe('connect', () => {
  it('stores a pending request and publishes it to the relays in the link', async () => {
    const outcome = await service.connect(encodeLink(them.publicKey, [board.url]), 'soy Beto, del equipo de datos')
    expect(outcome).toMatchObject({ kind: 'requested', pubkey: them.publicKey })
    expect(getContact(store, them.publicKey, 'outbound')).toMatchObject({ state: 'pending' })

    await service.sync(30_000)
    const messages = received()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ type: 'connect_request', name: 'Beto', note: 'soy Beto, del equipo de datos' })
  })

  it('says the request is already on its way instead of sending a second one', async () => {
    const link = encodeLink(them.publicKey, [board.url])
    await service.connect(link, 'hola')
    const second = await service.connect(link, 'hola otra vez')
    expect(second).toMatchObject({ kind: 'already_pending', pubkey: them.publicKey })
  })

  it('refuses a link with no usable relay', async () => {
    await expect(service.connect(encodeLink(them.publicKey, ['http://x.example.com']), 'hola')).rejects.toThrow(UserFacingError)
  })

  it('refuses to connect before this person has a name', async () => {
    const bare = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-asker-bare-')), 'home'), { relayPolicy: allowAnyRelay })
    const bareService = new AskerService({ store: bare, identity: me, createSocket: plainSocketFactory })
    await expect(bareService.connect(encodeLink(them.publicKey, [board.url]), 'hola')).rejects.toThrow(UserFacingError)
    await bareService.close()
    bare.close()
  })

  it('says so when that person already approved this one', async () => {
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: [board.url], now: 2_000_000_000 })
    applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: 2_000_000_000 })
    const outcome = await service.connect(encodeLink(them.publicKey, [board.url]), 'hola')
    expect(outcome).toMatchObject({ kind: 'already_approved', name: 'Ana' })
  })
})

describe('ask', () => {
  function approved(): void {
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: [board.url], now: 2_000_000_000 })
    applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: 2_000_000_000 })
  }

  it('stores the question, publishes it, and promotes it to sent on the next sync', async () => {
    approved()
    const question = await service.ask('ana', '¿cómo se despliega?')
    expect(question.state).toBe('sending')

    await service.sync()
    expect(received().map((m) => m.type)).toContain('question')
    expect(getOutboundQuestion(store, them.publicKey, question.questionId)?.state).toBe('sent')
  })

  it('refuses a name nobody in the contact list has', async () => {
    approved()
    await expect(service.ask('nadie', 'hola')).rejects.toThrow(UserFacingError)
  })

  it('refuses to ask someone who has not approved this person yet', async () => {
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: [board.url], now: 2_000_000_000 })
    await expect(service.ask(them.publicKey, 'hola')).rejects.toThrow(UserFacingError)
  })
})

describe('question lookup', () => {
  it('finds a question by its id or by a prefix, and is explicit when it cannot', async () => {
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: [board.url], now: 2_000_000_000 })
    applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: 2_000_000_000 })
    const asked = await service.ask('ana', 'hola')

    expect(service.question(asked.questionId).questionId).toBe(asked.questionId)
    expect(service.question(asked.questionId.slice(0, 8)).questionId).toBe(asked.questionId)
    expect(() => service.question('00000000-0000-4000-8000-ffffffffffff')).toThrow(UserFacingError)
    expect(() => service.question('abc')).toThrow(UserFacingError)
  })
})
