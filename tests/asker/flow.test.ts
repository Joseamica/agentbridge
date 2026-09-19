import { afterEach, describe, expect, it } from 'vitest'
import { encodeLink, getContact, getOutboundQuestion, listRequests, nowSeconds } from '@agentbridge/core'
import { startFakeBoard, startResponder, testIdentity, until, type Cleanups } from '../responder/support'
import { approveFromResponder, seedApprovedPair, startAsker } from './support'

const ana = testIdentity(71) // answers
const beto = testIdentity(72) // asks

const cleanups: Cleanups = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

describe('the whole round trip', () => {
  // The only test in this plan that mines a real 22-bit connection request; every other test seeds
  // the approval through the store. Budgeted at four minutes for a slow machine.
  it(
    'connects, gets approved, asks, and reads the answer',
    async () => {
      const board = await startFakeBoard()
      cleanups.push(() => board.close())

      const responder = await startResponder({ identity: ana, relays: [board.url], cleanups })
      const asker = await startAsker({ identity: beto, relays: [board.url], cleanups })

      // 1. Beto asks Ana for permission.
      const outcome = await asker.service.connect(encodeLink(ana.publicKey, [board.url]), 'soy Beto, del equipo de datos')
      expect(outcome.kind).toBe('requested')
      // The network part stays inside the ordinary ten seconds; the 22-bit proof of work runs on its
      // own budget inside the publisher, so this may take a few seconds of CPU before it returns.
      await asker.sync()

      // 2. Ana sees it and approves.
      await until(async () => {
        await asker.sync()
        return listRequests(responder.store, nowSeconds()).length === 1
      }, 120_000, 'the request to reach Ana')
      await approveFromResponder(responder, beto.publicKey)
      await until(() => getContact(responder.store, beto.publicKey, 'inbound')?.state === 'approved')

      // 3. Beto's next sync brings the approval home.
      await until(async () => {
        await asker.sync()
        return getContact(asker.store, ana.publicKey, 'outbound')?.state === 'approved'
      }, 30_000, 'the approval to reach Beto')

      // 4. Beto asks, Ana's Claude answers.
      const question = await asker.service.ask('ana', '¿cómo se despliega?')
      await asker.sync()
      await until(() => responder.questions().length === 1, 20_000, 'the question to reach Claude')
      const code = responder.questions()[0]!.meta.code!
      await responder.reply({ code, answer: 'con npm run deploy', source: 'README.md', confidence: 'seguro' })

      // 5. Beto reads it.
      await until(async () => {
        await asker.sync()
        return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'answered'
      }, 30_000, 'the answer to reach Beto')
      expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.answer).toMatchObject({
        text: 'con npm run deploy',
        source: 'README.md',
        confidence: 'seguro',
      })
    },
    240_000,
  )

  it('delivers a question that was sent while the other computer was closed', async () => {
    const board = await startFakeBoard()
    cleanups.push(() => board.close())

    // Ana exists but is not running: seed the approval directly, the way every other test does.
    const responderHome = await seedApprovedPair({ board, ana, beto, cleanups })
    const asker = await startAsker({ identity: beto, relays: [board.url], cleanups, home: responderHome.askerHome })

    const question = await asker.service.ask('ana', '¿sigues ahí?')
    await asker.sync()

    // Now Ana opens her computer.
    const responder = await startResponder({ identity: ana, relays: [board.url], cleanups, home: responderHome.responderHome })
    await until(() => responder.questions().length === 1, 30_000, 'the stored question to reach Claude')
    await responder.reply({ code: responder.questions()[0]!.meta.code!, answer: 'aquí estoy', source: 'chat', confidence: 'seguro' })

    await until(async () => {
      await asker.sync()
      return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'answered'
    }, 30_000, 'the answer to arrive')
  }, 120_000)
})
