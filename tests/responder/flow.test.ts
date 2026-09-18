import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { approveConnection, listRequests, nowSeconds, type Message } from '@agentbridge/core'
import { FakeAsker, seedApprovedContact, startFakeBoard, startResponder, testIdentity, until, type Cleanups, type Clock } from './support'

const responder = testIdentity(111)
const asker = testIdentity(112)
const cleanups: Cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function boards() {
  const mine = await startFakeBoard()
  const theirs = await startFakeBoard()
  cleanups.push(() => mine.close(), () => theirs.close())
  return { mine, theirs, to: { publicKey: responder.publicKey, relays: [mine.url] } }
}

const question = (questionId: string, text: string, generation = 1): Message => ({ v: 1, type: 'question', questionId, generation, text })

describe('responder flows over boards', () => {
  it(
    'completes request, approval, question, receipt and answer',
    async () => {
      const { mine, theirs, to } = await boards()
      const ana = await startResponder({ identity: responder, relays: [mine.url], cleanups })
      const beto = new FakeAsker(asker, [theirs.url], cleanups)
      beto.listen()

      const requestId = randomUUID()
      // The one 22-bit request in the whole suite (see Global Constraints: test cost).
      await beto.send(to, { v: 1, type: 'connect_request', requestId, name: 'Beto', note: 'Soy del equipo', relays: [theirs.url] })
      await until(() => listRequests(ana.store, nowSeconds()).length === 1, 20_000, 'the stored request')
      expect(listRequests(ana.store, nowSeconds())[0]).toMatchObject({ id: asker.publicKey.slice(0, 8), declaredName: 'Beto', note: 'Soy del equipo' })

      approveConnection(ana.store, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: nowSeconds() })
      ana.device.wakePublisher()
      await until(() => beto.messages('connect_approved').length > 0, 20_000, 'the approval')
      expect(beto.messages('connect_approved')[0]).toMatchObject({ requestId, generation: 1, name: 'Ana', relays: [mine.url] })

      const questionId = randomUUID()
      await beto.send(to, question(questionId, '¿Cuándo es la entrega?'))
      await until(() => ana.questions().length === 1, 20_000, 'the question in Claude')
      const [delivered] = ana.questions()
      expect(delivered).toMatchObject({ content: '¿Cuándo es la entrega?', meta: { from_name: 'beto' } })
      await until(() => beto.messages('receipt').some((m) => m.questionId === questionId), 20_000, 'the receipt')

      const result = await ana.reply({ code: delivered!.meta.code!, answer: 'El viernes.', source: 'plan.md', confidence: 'seguro' })
      expect(result.isError).toBe(false)
      expect(result.text).toMatch(/guardada/)
      await until(() => beto.messages('answer').some((m) => m.questionId === questionId), 20_000, 'the answer')
      expect(beto.messages('answer')[0]).toMatchObject({ questionId, text: 'El viernes.', source: 'plan.md', confidence: 'seguro' })
    },
    240_000,
  )

  it(
    'answers a question that arrived while the responder was off',
    async () => {
      const { mine, theirs, to } = await boards()
      const beto = new FakeAsker(asker, [theirs.url], cleanups)
      beto.listen()
      const questionId = randomUUID()
      await beto.send(to, question(questionId, '¿Sigue en pie la junta?'))

      const ana = await startResponder({
        identity: responder,
        relays: [mine.url],
        cleanups,
        seed: (store) => seedApprovedContact(store, { responder, asker, askerRelays: [theirs.url], now: nowSeconds() }),
      })
      await until(() => ana.questions().length === 1, 20_000, 'the question in Claude')
      await ana.reply({ code: ana.questions()[0]!.meta.code!, answer: 'Sí, a las 10.', source: 'agenda.md', confidence: 'creo' })
      await until(() => beto.messages('answer').some((m) => m.questionId === questionId), 20_000, 'the answer')
    },
    60_000,
  )

  it(
    'sends the very same answer again when the asker retries after losing it, and Claude sees the question once',
    async () => {
      const clock: Clock = { now: nowSeconds() }
      const { mine, theirs, to } = await boards()
      const ana = await startResponder({
        identity: responder,
        relays: [mine.url],
        cleanups,
        clock,
        seed: (store) => seedApprovedContact(store, { responder, asker, askerRelays: [theirs.url], now: clock.now }),
      })
      const beto = new FakeAsker(asker, [theirs.url], cleanups)
      const questionId = randomUUID()
      const rumor = await beto.send(to, question(questionId, '¿Quién revisa el contrato?'))
      await until(() => ana.questions().length === 1, 20_000, 'the question in Claude')
      await ana.reply({ code: ana.questions()[0]!.meta.code!, answer: 'Laura.', source: 'equipo.md', confidence: 'seguro' })
      const answerState = () => ana.store.db.prepare("SELECT state FROM outbox WHERE label = 'answer'").get()?.state
      await until(() => answerState() === 'published', 20_000, 'the published answer')
      const storedAnswer = JSON.parse(String(ana.store.db.prepare('SELECT decision_rumor_json AS j FROM inbox_questions').get()?.j)) as { id: string }

      // Every copy the asker could have read is gone, and more than the 10-minute regeneration limit passes.
      theirs.events.splice(0)
      clock.now += 601
      beto.listen()
      await beto.send(to, question(questionId, '¿Quién revisa el contrato?'), { rumor })

      await until(() => beto.messages('answer').length === 1, 20_000, 'the regenerated answer')
      expect(beto.received.find((opened) => opened.message.type === 'answer')?.rumor.id).toBe(storedAnswer.id)
      expect(beto.messages('receipt')).toHaveLength(1)
      expect(ana.questions()).toHaveLength(1)
    },
    60_000,
  )
})
