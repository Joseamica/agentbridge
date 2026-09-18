import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { approveConnection, nowSeconds, recordIncomingRequest, revokeConnection, type Message, type Rumor } from '@agentbridge/core'
import {
  FakeAsker,
  seedApprovedContact,
  startFakeBoard,
  startResponder,
  testIdentity,
  until,
  type Cleanups,
  type Clock,
} from './support'

const responder = testIdentity(121)
const asker = testIdentity(122)
const cleanups: Cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const question = (questionId: string, text: string, generation = 1): Message => ({ v: 1, type: 'question', questionId, generation, text })
const answerArgs = (code: string, answer = 'Listo.') => ({ code, answer, source: 'notas.md', confidence: 'seguro' as const })

async function approvedPair(options: { attemptTimeoutMs?: number; clock?: Clock } = {}) {
  const mine = await startFakeBoard()
  const theirs = await startFakeBoard()
  cleanups.push(() => mine.close(), () => theirs.close())
  const now = () => (options.clock ? options.clock.now : nowSeconds())
  const ana = await startResponder({
    identity: responder,
    relays: [mine.url],
    cleanups,
    clock: options.clock,
    attemptTimeoutMs: options.attemptTimeoutMs,
    seed: (store) => seedApprovedContact(store, { responder, asker, askerRelays: [theirs.url], now: now() }),
  })
  const beto = new FakeAsker(asker, [theirs.url], cleanups)
  beto.listen()
  return { mine, theirs, ana, beto, to: { publicKey: responder.publicKey, relays: [mine.url] }, now }
}

describe('responder scenarios', () => {
  it(
    'revocation cancels the active question in Claude, refuses its answer, tells the asker, and rejects a waiting question on retry',
    async () => {
      const clock: Clock = { now: nowSeconds() }
      const { ana, beto, to, now } = await approvedPair({ clock })
      const first = randomUUID()
      const second = randomUUID()
      await beto.send(to, question(first, 'primera'))
      const secondRumor = await beto.send(to, question(second, 'segunda'))
      await until(() => ana.questions().length === 1, 20_000, 'the first question in Claude')
      const active = ana.questions()[0]!
      await until(() => ana.store.db.prepare('SELECT count(*) AS n FROM inbox_questions').get()?.n === 2, 20_000, 'both questions stored')

      revokeConnection(ana.store, { identity: responder, name: 'beto', now: now() })
      ana.device.wakePublisher()
      await until(() => ana.cancellations().length === 1, 20_000, 'the cancellation in Claude')
      expect(ana.cancellations()[0]!.meta.code).toBe(active.meta.code)
      expect((await ana.reply(answerArgs(active.meta.code!))).isError).toBe(true)
      await until(() => beto.messages('connect_revoked').length === 1, 20_000, 'connect_revoked')
      expect(beto.messages('connect_revoked')[0]).toMatchObject({ generation: 2 })

      // The asker's retry comes after the 10-minute regeneration limit.
      clock.now += 601
      await beto.send(to, question(second, 'segunda'), { rumor: secondRumor })
      await until(() => beto.messages('rejected').some((m) => m.questionId === second), 20_000, 'the stale_generation rejection')
      expect(beto.messages('rejected').find((m) => m.questionId === second)).toMatchObject({ reason: 'stale_generation' })
      expect(beto.messages('answer')).toEqual([])
      expect(ana.questions()).toHaveLength(1)
    },
    60_000,
  )

  it(
    'a new approval does not bring back questions from before the revocation',
    async () => {
      const clock: Clock = { now: nowSeconds() }
      const { theirs, ana, beto, to, now } = await approvedPair({ clock })
      const old = randomUUID()
      const oldRumor = await beto.send(to, question(old, 'vieja'))
      await until(() => ana.questions().length === 1, 20_000, 'the old question in Claude')
      revokeConnection(ana.store, { identity: responder, name: 'beto', now: now() })
      await until(() => ana.cancellations().length === 1, 20_000, 'the cancellation')

      recordIncomingRequest(ana.store, {
        pubkey: asker.publicKey,
        requestId: randomUUID(),
        requestRumorId: randomBytes(32).toString('hex'),
        declaredName: 'Beto',
        note: '',
        relays: [theirs.url],
        now: now(),
      })
      const { contact } = approveConnection(ana.store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: now() })
      expect(contact.generation).toBe(3)

      clock.now += 601
      await beto.send(to, question(old, 'vieja'), { rumor: oldRumor })
      await until(() => beto.messages('rejected').some((m) => m.questionId === old), 20_000, 'the old question rejected')
      expect(beto.messages('rejected').find((m) => m.questionId === old)).toMatchObject({ reason: 'stale_generation' })
      const fresh = randomUUID()
      await beto.send(to, question(fresh, 'nueva', 3))
      await until(() => ana.questions().length === 2, 20_000, 'the new question in Claude')
      expect(ana.questions()[1]!.content).toBe('nueva')
    },
    60_000,
  )

  it(
    'refuses an answer after its deadline and brings the question back with a new code',
    async () => {
      const { ana, beto, to } = await approvedPair({ attemptTimeoutMs: 1_500 })
      const questionId = randomUUID()
      await beto.send(to, question(questionId, 'lenta'))
      await until(() => ana.questions().length === 1, 20_000, 'the question in Claude')
      const firstCode = ana.questions()[0]!.meta.code!
      await until(() => ana.cancellations().length === 1, 20_000, 'the timeout cancellation')
      await until(() => ana.questions().length === 2, 20_000, 'the question again')
      const secondCode = ana.questions()[1]!.meta.code!
      expect(secondCode).not.toBe(firstCode)
      expect((await ana.reply(answerArgs(firstCode))).isError).toBe(true)
      expect((await ana.reply(answerArgs(secondCode, 'A tiempo.'))).isError).toBe(false)
      await until(() => beto.messages('answer').some((m) => m.questionId === questionId), 20_000, 'the answer')
    },
    60_000,
  )

  it(
    'never lets a stranger’s question reach Claude or the store',
    async () => {
      const { theirs, ana, beto, to } = await approvedPair()
      const stranger = new FakeAsker(testIdentity(129), [theirs.url], cleanups)
      await stranger.send(to, question(randomUUID(), 'hola, soy nadie'))
      await beto.send(to, question(randomUUID(), 'de Beto'))
      await until(() => ana.questions().length === 1, 20_000, 'Beto’s question in Claude')
      expect(ana.questions()[0]!.content).toBe('de Beto')
      expect(ana.store.db.prepare('SELECT count(*) AS n FROM inbox_questions').get()?.n).toBe(1)
    },
    60_000,
  )

  it(
    'rejects a question older than 24 hours without showing it to Claude',
    async () => {
      const { ana, beto, to } = await approvedPair()
      const questionId = randomUUID()
      await beto.send(to, question(questionId, 'muy vieja'), { createdAt: nowSeconds() - 86_400 - 60 })
      await until(() => beto.messages('rejected').some((m) => m.questionId === questionId), 20_000, 'the expired rejection')
      expect(beto.messages('rejected').find((m) => m.questionId === questionId)).toMatchObject({ reason: 'expired' })
      expect(ana.questions()).toEqual([])
    },
    60_000,
  )

  it(
    'ignores a different rumor that reuses a question id',
    async () => {
      const clock: Clock = { now: nowSeconds() }
      const { ana, beto, to } = await approvedPair({ clock })
      const questionId = randomUUID()
      const originalRumor = await beto.send(to, question(questionId, 'original'))
      await until(() => ana.questions().length === 1, 20_000, 'the original in Claude')
      await ana.reply(answerArgs(ana.questions()[0]!.meta.code!))
      await until(() => beto.messages('answer').some((m) => m.questionId === questionId), 20_000, 'the answer')

      // Put the 10-minute regeneration guard out of the way first, so the conflict check on the
      // differing rumor id is the only thing left that can still stop the impostor.
      clock.now += 601
      const receiptsForQuestion = () => beto.messages('receipt').filter((m) => m.questionId === questionId).length
      const receiptsBefore = receiptsForQuestion()
      await beto.send(to, question(questionId, 'impostora'))
      const later = randomUUID()
      await beto.send(to, question(later, 'siguiente'))
      await until(() => ana.questions().length === 2, 20_000, 'the next question in Claude')

      // Claude only ever saw the original text, and the impostor never earned itself a fresh receipt.
      expect(ana.questions().map((q) => q.content)).toEqual(['original', 'siguiente'])
      expect(receiptsForQuestion()).toBe(receiptsBefore)
      const stored = ana.store.db.prepare('SELECT rumor_id AS rumorId FROM inbox_questions WHERE question_id = ?').get(questionId) as { rumorId: string }
      expect(stored.rumorId).toBe(originalRumor.id)
    },
    60_000,
  )

  it(
    'repeats a limit rejection on retry even after room frees up',
    async () => {
      const clock: Clock = { now: nowSeconds() }
      const { ana, beto, to } = await approvedPair({ clock })
      const ids = Array.from({ length: 6 }, () => randomUUID())
      const rumors: Rumor[] = []
      for (const [i, id] of ids.entries()) rumors.push(await beto.send(to, question(id, `pregunta ${i + 1}`)))
      const sixth = ids[5]!
      await until(() => beto.messages('rejected').some((m) => m.questionId === sixth), 30_000, 'the limit rejection')
      expect(beto.messages('rejected').find((m) => m.questionId === sixth)).toMatchObject({ reason: 'limit' })

      await until(() => ana.questions().length === 1, 20_000, 'the first question in Claude')
      await ana.reply(answerArgs(ana.questions()[0]!.meta.code!))
      await until(() => ana.questions().length === 2, 20_000, 'the second question in Claude')

      clock.now += 601
      await beto.send(to, question(sixth, 'pregunta 6'), { rumor: rumors[5]! })
      await until(() => beto.messages('rejected').filter((m) => m.questionId === sixth).length === 2, 20_000, 'the repeated rejection')
      expect(beto.messages('rejected').filter((m) => m.questionId === sixth).every((m) => m.reason === 'limit')).toBe(true)
      expect(ana.questions().map((q) => q.content)).not.toContain('pregunta 6')
    },
    90_000,
  )
})
