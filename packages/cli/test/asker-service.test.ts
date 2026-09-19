import { mkdtemp } from 'node:fs/promises'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NOSTR,
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// A relay that accepts a TCP connection and never speaks: the WebSocket handshake never completes,
// so `BoardConnection.connect()` (registered in the pool's connection map before it is awaited) hangs
// until something else — the sync's own deadline, or pool.close()'s terminate() loop — ends it. Used
// to prove that history spending the whole sync deadline does not also starve publishing (I3).
async function startBlackHole(): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // net.Server#close() waits for every accepted connection to end on its own before its
        // callback fires — and this test's whole point is a connection that never does. Destroying
        // each accepted socket first is what lets close() actually resolve.
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

async function waitFor(predicate: () => boolean, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const intervalMs = options.intervalMs ?? 20
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition never became true')
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
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

describe('sync', () => {
  function approved(id = uuid(1)): void {
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: id, relays: [board.url], now: 2_000_000_000 })
    applyApproval(store, { pubkey: them.publicKey, requestId: id, generation: 1, name: 'Ana', relays: [board.url], now: 2_000_000_000 })
  }

  // Fix round 1, Critical C1. `this.syncing = this.syncing.then(...)` never runs its callback once
  // `this.syncing` is rejected — `Promise.prototype.then(onFulfilled)` on a rejected promise just
  // returns that same rejection — so one failed sync used to leave device.syncOnce, and with it
  // markSentQuestions/expireOutboundQuestions, permanently unreachable for the rest of the process's
  // life (P1 and P8 dead until a restart). This proves the chain self-heals: syncOnce is spied to
  // reject exactly once, and the very next sync() must still call the real implementation.
  it('recovers after one sync rejects, instead of leaving every later sync stuck on the same failure', async () => {
    const syncOnceSpy = vi.spyOn(service.device, 'syncOnce').mockRejectedValueOnce(new Error('simulated SQLITE_BUSY'))
    await expect(service.sync()).rejects.toThrow('simulated SQLITE_BUSY')
    // If the chain were still poisoned, this would reject with the exact same stale error instead of
    // actually calling the (now un-mocked) real syncOnce again.
    await expect(service.sync()).resolves.toMatchObject({ timedOut: false })
    expect(syncOnceSpy).toHaveBeenCalledTimes(2)
    syncOnceSpy.mockRestore()
  })

  // Fix round 1, Important I2 (P1's push half). asker-service.test.ts's original "promotes it to sent
  // on the next sync" test only proves the state ends up 'sent' after AskerService.sync() returns —
  // which sync() would still show even with the onPublished hook deleted, because sync()'s own
  // trailing markSentQuestions() call (and Device.purge()) run regardless. Calling device.syncOnce()
  // directly bypasses that trailing sweep, isolating whatever the Device's own onPublished wiring
  // does on its own: the only other place inside a single syncOnce() call that could promote the row
  // is Device.purge(), which runs at the *start* of that call, before this row has even been
  // published yet, so it cannot be what promotes it here.
  it('promotes a question to sent through the onPublished hook, not through the trailing sweep', async () => {
    approved()
    const question = await service.ask('ana', 'hola')
    await service.device.syncOnce({ maxMs: 10_000 })
    expect(getOutboundQuestion(store, them.publicKey, question.questionId)?.state).toBe('sent')
  })

  // Fix round 1, Important I2 (P8's `lost`). Drives expireOutboundQuestions through sync() itself,
  // with a controllable clock, instead of only unit-testing the store function directly.
  it('expires an unanswered question to lost once its retry window has passed, inside sync()', async () => {
    let clock = 2_000_000_000
    const svc = new AskerService({ store, identity: me, createSocket: plainSocketFactory, now: () => clock })
    try {
      approved(uuid(2))
      const question = await svc.ask('ana', 'hola')
      await svc.sync()
      expect(getOutboundQuestion(store, them.publicKey, question.questionId)?.state).toBe('sent')

      clock += NOSTR.retryWindowSeconds + 10
      await svc.sync()
      expect(getOutboundQuestion(store, them.publicKey, question.questionId)?.state).toBe('lost')
    } finally {
      await svc.close()
    }
  })

  // Fix round 1, Important I3. Device.runSync spends the sync's whole deadline on history first, so
  // when this person's own relay never answers, publishDue's shared signal is already spent before
  // its very first round starts and nothing gets even one attempt — a person who just ran `ask` and
  // saw it succeed would in fact have sent nothing. The profile's own relay (read for history) and a
  // contact's relay (where a question is actually published) are independent in the protocol, which
  // is what lets this test starve one without starving the other: history goes to a black hole,
  // publishing still goes to the real board.
  it('still publishes what a command enqueued even when history never answers and spends the whole deadline', async () => {
    const blackHole = await startBlackHole()
    try {
      setProfile(store, { relays: [blackHole.url], now: 2_000_000_000 })
      approved(uuid(3))
      const question = await service.ask('ana', 'hola')

      // Short on purpose: long enough for the reserved publish pass (a fast, working relay) to
      // finish, short enough that history against the black hole visibly spends the whole budget.
      await service.sync(800)

      expect(received().map((m) => m.type)).toContain('question')
      expect(getOutboundQuestion(store, them.publicKey, question.questionId)?.state).toBe('sent')
    } finally {
      await blackHole.close()
    }
  })

  // Fix round 2, finding 1. The reserved publish pass and device.syncOnce used to each get their own
  // full `maxMs` — a sync's deadline-bound network time could take up to twice what the caller asked
  // for, which is exactly what a "ten-second" sync must not do. This pins the arithmetic directly and
  // deterministically: given how long the reserved pass took (controlled through Date.now(), the same
  // clock sync() itself reads — not this.now(), which a test can hold still for unrelated reasons),
  // device.syncOnce must be handed only what is left of maxMs, never maxMs again in full.
  //
  // A real-relay version of this test was tried first and dropped: with nothing enqueued, the
  // reserved pass has nothing to claim and returns in well under a millisecond whether or not it owns
  // a full maxMs of its own, so a real black hole for history alone cannot tell a shared deadline
  // apart from two independent ones — and publishDue's own publish step (packages/core's
  // device/publisher.ts) is deliberately called without a signal at all (Task 5's Important 2 /
  // Ruling 12: an already-mined row is never discarded), so a real black hole for the reserved pass's
  // own target is bounded by BoardConnection's ~10s connect timeout, not by maxMs — accurate, but far
  // too slow for a unit test to pin the arithmetic. Mocking is the precise tool here; the "still
  // publishes what a command enqueued..." test above and the "start" test below already cover the
  // real, end-to-end network paths.
  it('hands device.syncOnce only what the reserved publish pass left of the deadline, not another full one', async () => {
    let call = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (call++ === 0 ? 1_000_000 : 1_000_400))
    const publishReservedSpy = vi
      .spyOn(service as unknown as { publishReserved(maxMs: number): Promise<unknown> }, 'publishReserved')
      .mockResolvedValueOnce({ report: { published: 0, failed: 0, postponed: 0, lost: 0 }, timedOut: false })
    const syncOnceSpy = vi
      .spyOn(service.device, 'syncOnce')
      .mockResolvedValueOnce({ history: [], published: { published: 0, failed: 0, postponed: 0, lost: 0 }, timedOut: false })

    // The reserved pass "took" 400ms of a 1000ms budget (the two Date.now() reads above): what
    // remains for device.syncOnce is 600ms, never the original 1000ms again.
    await service.sync(1_000)

    expect(syncOnceSpy).toHaveBeenCalledWith({ maxMs: 600 })
    nowSpy.mockRestore()
    publishReservedSpy.mockRestore()
    syncOnceSpy.mockRestore()
  })

  // Fix round 2, finding 1 (the "not skipped outright" half). When the reserved pass alone already
  // spends the whole budget, device.syncOnce must still run — with an expired deadline, which it is
  // built to handle on its own — rather than being skipped.
  it('still calls device.syncOnce, with a zeroed-out deadline, when the reserved pass used the whole budget', async () => {
    let call = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (call++ === 0 ? 1_000_000 : 1_002_000))
    const publishReservedSpy = vi
      .spyOn(service as unknown as { publishReserved(maxMs: number): Promise<unknown> }, 'publishReserved')
      .mockResolvedValueOnce({ report: { published: 0, failed: 0, postponed: 0, lost: 0 }, timedOut: true })
    const syncOnceSpy = vi
      .spyOn(service.device, 'syncOnce')
      .mockResolvedValueOnce({ history: [], published: { published: 0, failed: 0, postponed: 0, lost: 0 }, timedOut: false })

    await service.sync(1_000)

    expect(syncOnceSpy).toHaveBeenCalledTimes(1)
    expect(syncOnceSpy).toHaveBeenCalledWith({ maxMs: 0 })
    nowSpy.mockRestore()
    publishReservedSpy.mockRestore()
    syncOnceSpy.mockRestore()
  })

  // Fix round 2, finding 2. The merged report used to carry only device.syncOnce's own `timedOut`,
  // silently dropping a timeout that happened only in the reserved pass. Isolates the merge itself —
  // publishReserved is stubbed directly, decoupled from real relay timing — rather than relying on a
  // real black hole to happen to produce exactly this combination.
  it('reports timedOut when only the reserved publish pass timed out', async () => {
    const reservedSpy = vi
      .spyOn(service as unknown as { publishReserved(maxMs: number): Promise<unknown> }, 'publishReserved')
      .mockResolvedValueOnce({ report: { published: 0, failed: 0, postponed: 0, lost: 0 }, timedOut: true })
    const result = await service.sync(5_000)
    expect(result.timedOut).toBe(true)
    reservedSpy.mockRestore()
  })
})

describe('start', () => {
  // Fix round 1, Important I2 (start()'s persistent mode). ask() calls device.wakePublisher(), which
  // is a no-op unless the device was start()ed — every other test in this file relies entirely on an
  // explicit sync() to publish. This proves start()'s background publisher actually runs: after
  // start(), the question this test asks reaches 'sent' with no sync() call at all.
  it('publishes what was just asked in the background, once started, with no explicit sync', async () => {
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: [board.url], now: 2_000_000_000 })
    applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: 2_000_000_000 })
    service.start()
    const question = await service.ask('ana', 'hola')
    await waitFor(() => getOutboundQuestion(store, them.publicKey, question.questionId)?.state === 'sent')
    expect(received().map((m) => m.type)).toContain('question')
  })
})
