import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NOSTR,
  applyApproval,
  createOutboundRequest,
  createRumor,
  getContact,
  getOutboundQuestion,
  listContacts,
  nowSeconds,
  revokeConnection,
  wrapRumor,
  type Message,
} from '@agentbridge/core'
import { startFakeBoard, startResponder, testIdentity, until, type Cleanups } from '../responder/support'
import { seedApprovedContact } from '../responder/support'
import { startAsker } from './support'

const ana = testIdentity(73)
const beto = testIdentity(74)
const stranger = testIdentity(75)
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const cleanups: Cleanups = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

// The local name Ana's store gave Beto when she approved him: `revoke` takes that name, not a key.
function contactNameOf(store: Parameters<typeof listContacts>[0], pubkey: string): string {
  const contact = listContacts(store, 'inbound').find((one) => one.pubkey === pubkey)
  if (!contact?.localName) throw new Error('the responder has no local name for that contact')
  return contact.localName
}

// Ana's side, without running her channel: seal a message to Beto and drop it on the board.
//
// `createdAt` matters. Tests that move a fake clock forward (the retry ones below) must date what
// Ana sends with that same clock: a rumor stamped with real wall-clock time would look ancient — or
// impossibly future — to a receiver whose clock is 2_000_000_000, and the receive pipeline would
// drop it. The wrap itself is always dated with the real clock, because that is what a relay sees.
async function anaSends(
  board: { inject(event: unknown): void },
  message: Message,
  sender = ana,
  createdAt = nowSeconds(),
): Promise<void> {
  const rumor = createRumor(message, sender, createdAt)
  // The wrap is dated with the same clock as the rumor. A wrap stamped with real wall-clock time
  // while the asker's clock sits at 2_000_000_000 falls outside every history window that asker
  // asks for, so it would simply never be read.
  board.inject((await wrapRumor(rumor, sender, beto.publicKey, { now: createdAt })) as never)
}

// Every scenario gets a clock, even the ones that never move it: that way `anaSends` can always be
// given the asker's own notion of "now", and a test that starts moving time later does not have to
// change how Ana's messages are dated.
async function askerWithApproval(clock: { now: number } = { now: nowSeconds() }) {
  const board = await startFakeBoard()
  cleanups.push(() => board.close())
  const asker = await startAsker({ identity: beto, relays: [board.url], cleanups, now: () => clock.now })
  createOutboundRequest(asker.store, { pubkey: ana.publicKey, requestId: uuid(1), relays: [board.url], now: clock.now })
  applyApproval(asker.store, { pubkey: ana.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: clock.now })
  return { board, asker, clock }
}

describe('what the asker does with what arrives', () => {
  it('keeps retrying after a receipt and stops once the answer lands', async () => {
    const { board, asker, clock } = await askerWithApproval()
    const question = await asker.service.ask('ana', '¿sigues ahí?')
    await asker.sync()

    await anaSends(board, { v: 1, type: 'receipt', questionId: question.questionId }, ana, clock.now)
    await until(async () => {
      await asker.sync()
      return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'received'
    })
    // The receipt does not stop the retries: the outbox row is still there.
    expect(asker.store.db.prepare('SELECT count(*) AS n FROM outbox').get()).toMatchObject({ n: 1 })

    await anaSends(board, { v: 1, type: 'answer', questionId: question.questionId, text: 'sí', source: 'chat', confidence: 'seguro' }, ana, clock.now)
    await until(async () => {
      await asker.sync()
      return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'answered'
    })
    expect(asker.store.db.prepare('SELECT count(*) AS n FROM outbox').get()).toMatchObject({ n: 0 })
  }, 60_000)

  it('shows a rejection with its reason and never asks again by itself', async () => {
    const { board, asker, clock } = await askerWithApproval()
    const question = await asker.service.ask('ana', 'otra más')
    await asker.sync()

    await anaSends(board, { v: 1, type: 'rejected', questionId: question.questionId, reason: 'limit' }, ana, clock.now)
    await until(async () => {
      await asker.sync()
      return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'rejected'
    })
    expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.rejectReason).toBe('limit')
    expect(asker.store.db.prepare('SELECT count(*) AS n FROM outbox').get()).toMatchObject({ n: 0 })
  }, 60_000)

  it('ignores a second decision and keeps the first', async () => {
    const { board, asker, clock } = await askerWithApproval()
    const question = await asker.service.ask('ana', 'una sola decisión')
    await asker.sync()

    await anaSends(board, { v: 1, type: 'rejected', questionId: question.questionId, reason: 'expired' }, ana, clock.now)
    await until(async () => {
      await asker.sync()
      return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'rejected'
    })
    await anaSends(board, { v: 1, type: 'answer', questionId: question.questionId, text: 'tarde', source: 'x', confidence: 'seguro' }, ana, clock.now)
    await asker.sync()
    await asker.sync()
    expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)).toMatchObject({ state: 'rejected', answer: null })
  }, 60_000)

  it('never lets a stranger touch a question meant for someone else', async () => {
    const { board, asker, clock } = await askerWithApproval()
    const question = await asker.service.ask('ana', 'solo para Ana')
    await asker.sync()
    const before = getOutboundQuestion(asker.store, ana.publicKey, question.questionId)!
    const outboxBefore = asker.store.db.prepare('SELECT count(*) AS n FROM outbox').get() as { n: number }

    await anaSends(board, { v: 1, type: 'answer', questionId: question.questionId, text: 'soy otro', source: 'x', confidence: 'seguro' }, stranger, clock.now)
    await asker.sync()
    await asker.sync()

    // Nothing at all changed: not the state, not the stored answer, and above all not the retries —
    // a stranger who could silently stop them would be as harmful as one who could answer.
    expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)).toEqual(before)
    expect(asker.store.db.prepare('SELECT count(*) AS n FROM outbox').get()).toEqual(outboxBefore)

    // And the real answer still works afterwards.
    await anaSends(board, { v: 1, type: 'answer', questionId: question.questionId, text: 'soy Ana', source: 'chat', confidence: 'seguro' }, ana, clock.now)
    await until(async () => {
      await asker.sync()
      return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'answered'
    })
  }, 60_000)

  it('reaches the other person even when one of their boards is dead', async () => {
    const live = await startFakeBoard()
    const dead = await startFakeBoard()
    cleanups.push(() => live.close())
    const asker = await startAsker({ identity: beto, relays: [live.url], cleanups })
    const now = nowSeconds()
    createOutboundRequest(asker.store, { pubkey: ana.publicKey, requestId: uuid(2), relays: [live.url, dead.url], now })
    applyApproval(asker.store, { pubkey: ana.publicKey, requestId: uuid(2), generation: 1, name: 'Ana', relays: [live.url, dead.url], now })
    // The second board goes away before anything is published to it, so publishing has to survive
    // one relay refusing every connection.
    await dead.close()

    const question = await asker.service.ask('ana', '¿llega igual?')
    await asker.sync()
    expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state).toBe('sent')
    expect(live.events.filter((event) => event.kind === 1059).length).toBeGreaterThanOrEqual(1)
  }, 60_000)
})

describe('permission changes', () => {
  it('applies a revocation and refuses to ask again', async () => {
    const { board, asker, clock } = await askerWithApproval()
    await anaSends(board, { v: 1, type: 'connect_revoked', generation: 2 }, ana, clock.now)
    await until(async () => {
      await asker.sync()
      return getContact(asker.store, ana.publicKey, 'outbound')?.state === 'revoked'
    })
    await expect(asker.service.ask('ana', '¿puedo todavía?')).rejects.toThrow()
  }, 60_000)

  it('ignores a revocation older than the approval it already has', async () => {
    const { board, asker, clock } = await askerWithApproval()
    // A second approval only applies to a *pending* request, so reaching a higher generation means
    // living the real sequence: revoke, ask again, approve again.
    await anaSends(board, { v: 1, type: 'connect_revoked', generation: 2 }, ana, clock.now)
    await until(async () => {
      await asker.sync()
      return getContact(asker.store, ana.publicKey, 'outbound')?.state === 'revoked'
    })
    createOutboundRequest(asker.store, { pubkey: ana.publicKey, requestId: uuid(3), relays: [board.url], now: clock.now })
    await anaSends(board, { v: 1, type: 'connect_approved', requestId: uuid(3), generation: 5, name: 'Ana', relays: [board.url] }, ana, clock.now)
    await until(async () => {
      await asker.sync()
      return getContact(asker.store, ana.publicKey, 'outbound')?.generation === 5
    })

    // Now the late revocation of an older generation arrives and changes nothing.
    await anaSends(board, { v: 1, type: 'connect_revoked', generation: 3 }, ana, clock.now)
    await asker.sync()
    await asker.sync()
    expect(getContact(asker.store, ana.publicKey, 'outbound')?.state).toBe('approved')
  }, 60_000)

  it('ignores an approval that answers a request this person never made', async () => {
    const { board, asker, clock } = await askerWithApproval()
    await anaSends(board, { v: 1, type: 'connect_approved', requestId: uuid(999), generation: 9, name: 'Ana', relays: [board.url] }, ana, clock.now)
    await asker.sync()
    await asker.sync()
    expect(getContact(asker.store, ana.publicKey, 'outbound')?.generation).toBe(1)
  }, 60_000)
})

describe('recovery through retries', () => {
  it('gets the decision that was lost, because the retry makes the other side regenerate it', async () => {
    // A real responder on the other end, so the recovery is the protocol's, not the test's: Ana
    // rejects the question (her decision is stored), her rejection is lost on the way, and Beto's
    // retry is what makes her regenerate and resend it.
    const board = await startFakeBoard()
    cleanups.push(() => board.close())
    // One clock for both people. The responder's own regeneration limit is ten minutes counted on
    // *its* clock, so moving only the asker forward would never make Ana resend anything: a shared
    // clock is what lets a single jump cross both the asker's retry schedule (5 min) and Ana's
    // regeneration limit (10 min). The responder harness takes a clock exactly like the asker's.
    const clock = { now: nowSeconds() }
    const responder = await startResponder({ identity: ana, relays: [board.url], cleanups, clock })
    const asker = await startAsker({ identity: beto, relays: [board.url], cleanups, now: () => clock.now })
    seedApprovedContact(responder.store, { responder: ana, asker: beto, askerRelays: [board.url], now: clock.now })
    createOutboundRequest(asker.store, { pubkey: ana.publicKey, requestId: uuid(1), relays: [board.url], now: clock.now })
    applyApproval(asker.store, { pubkey: ana.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: clock.now })

    const question = await asker.service.ask('ana', '¿me contestas?')
    await asker.sync()

    // Ana receives it and revokes before answering: her side stores rejected/stale_generation
    // without sending it (the spec regenerates that decision only when a retry arrives).
    await until(() => responder.questions().length === 1, 30_000, 'the question to reach Ana')
    revokeConnection(responder.store, { identity: ana, name: contactNameOf(responder.store, beto.publicKey), now: clock.now })
    await until(async () => {
      await asker.sync()
      return getContact(asker.store, ana.publicKey, 'outbound')?.state === 'revoked'
    }, 30_000, 'the revocation to reach Beto')

    // Beto's question is still open, and P11 keeps its retry authorized. Past both clocks' limits —
    // the asker's five-minute retry and Ana's ten-minute regeneration — it goes out again…
    expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state).not.toBe('rejected')
    clock.now += NOSTR.regenerationIntervalSeconds + 1
    await asker.sync()

    // …and Ana's stored decision comes back with it.
    await until(async () => {
      await asker.sync()
      return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'rejected'
    }, 60_000, 'the regenerated rejection to reach Beto')
    expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.rejectReason).toBe('stale_generation')
  }, 120_000)
})

describe('time', () => {
  it('gives up on a question after the retry window and says so', async () => {
    const clock = { now: 2_000_000_000 }
    const { asker } = await askerWithApproval(clock)
    const question = await asker.service.ask('ana', '¿hay alguien?')
    await asker.sync()

    clock.now += NOSTR.retryWindowSeconds
    await asker.sync()
    expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state).toBe('lost')
    expect(asker.store.db.prepare('SELECT count(*) AS n FROM outbox').get()).toMatchObject({ n: 0 })
  }, 60_000)

  it('republishes the same question on the retry schedule until something decides it', async () => {
    const clock = { now: 2_000_000_000 }
    const { board, asker } = await askerWithApproval(clock)
    const question = await asker.service.ask('ana', 'paciencia')
    await asker.sync()
    const first = board.events.filter((event) => event.kind === 1059).length
    expect(first).toBeGreaterThanOrEqual(1)

    // Nothing is due yet: a sync one minute later publishes nothing new.
    clock.now += 60
    await asker.sync()
    expect(board.events.filter((event) => event.kind === 1059).length).toBe(first)

    // Five minutes in, the first retry is due; half an hour after that, the second.
    clock.now += NOSTR.retryFirstHourIntervalSeconds
    await asker.sync()
    const second = board.events.filter((event) => event.kind === 1059).length
    expect(second).toBeGreaterThan(first)

    clock.now += 3_600 + NOSTR.retryAfterFirstHourIntervalSeconds
    await asker.sync()
    expect(board.events.filter((event) => event.kind === 1059).length).toBeGreaterThan(second)

    // Every one of them carried the same question, with the same rumor id.
    expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)).toMatchObject({ state: 'sent', rumorId: question.rumorId })
  }, 60_000)

  it('stops republishing the moment an answer lands', async () => {
    const clock = { now: 2_000_000_000 }
    const { board, asker } = await askerWithApproval(clock)
    const question = await asker.service.ask('ana', '¿ya?')
    await asker.sync()
    await anaSends(board, { v: 1, type: 'answer', questionId: question.questionId, text: 'ya', source: 'chat', confidence: 'seguro' }, ana, clock.now)
    await until(async () => {
      await asker.sync()
      return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'answered'
    })
    const after = board.events.filter((event) => event.kind === 1059).length
    clock.now += NOSTR.retryFirstHourIntervalSeconds * 3
    await asker.sync()
    expect(board.events.filter((event) => event.kind === 1059).length).toBe(after)
  }, 60_000)
})

describe('a person who only uses the terminal', () => {
  it('picks up an answer that arrived while every process was closed', async () => {
    const board = await startFakeBoard()
    cleanups.push(() => board.close())
    const home = join(await mkdtemp(join(tmpdir(), 'ab-reopen-')), 'home')

    // First run: ask, then close everything. Its own cleanup list — not the shared one — because
    // this harness is closed explicitly a few lines down, and Store.close() (node:sqlite) throws if
    // called a second time. Sharing `cleanups` here would double-close it in afterEach.
    const firstCleanups: Cleanups = []
    const first = await startAsker({ identity: beto, relays: [board.url], cleanups: firstCleanups, home })
    const now = nowSeconds()
    createOutboundRequest(first.store, { pubkey: ana.publicKey, requestId: uuid(1), relays: [board.url], now })
    applyApproval(first.store, { pubkey: ana.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now })
    const question = await first.service.ask('ana', '¿me contestas luego?')
    await first.sync()
    await first.close()

    // Ana answers while nothing of Beto's is running.
    const rumor = createRumor(
      { v: 1, type: 'answer', questionId: question.questionId, text: 'sí, aquí está', source: 'chat', confidence: 'seguro' },
      ana,
      nowSeconds(),
    )
    board.inject(await wrapRumor(rumor, ana, beto.publicKey, { now: nowSeconds() }))

    // Second run, same home: one sync brings it home.
    const second = await startAsker({ identity: beto, relays: [board.url], cleanups, home })
    await until(async () => {
      await second.sync()
      return getOutboundQuestion(second.store, ana.publicKey, question.questionId)?.state === 'answered'
    }, 30_000, 'the answer to be picked up on the next run')
  }, 90_000)
})
