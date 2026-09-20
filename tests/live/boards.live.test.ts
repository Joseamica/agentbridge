import { randomUUID } from 'node:crypto'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BoardPool,
  SeenIds,
  createRumor,
  leadingZeroBits,
  nowSeconds,
  openWrap,
  pinnedSocketFactory,
  precheckWrap,
  wrapRumor,
  type Identity,
  type Message,
  type PrecheckedWrap,
} from '@agentbridge/core'

// The relays that accepted and served NIP-59 wraps in the 2026-09-16 spike — except
// relay.nostr.net, replaced with relay.damus.io on 2026-09-19 after the former's WebSocket
// handshake started answering HTTP 500 (see the comment on DEFAULT_RELAYS in
// packages/core/src/store/settings.ts, which this list mirrors).
const RELAYS = ['wss://relay.primal.net', 'wss://relay.snort.social', 'wss://relay.damus.io', 'wss://nostr.oxtr.dev', 'wss://nos.lol']

const newIdentity = (): Identity => {
  const secretKey = generateSecretKey()
  return { secretKey, publicKey: getPublicKey(secretKey) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('public Nostr relays (live, opt-in)', () => {
  const sender = newIdentity()
  const recipient = newIdentity()
  const log = (line: string) => console.log(`[live] ${line}`)
  const senderPool = new BoardPool({ identity: sender, createSocket: pinnedSocketFactory, log })
  const recipientPool = new BoardPool({ identity: recipient, createSocket: pinnedSocketFactory, log })
  afterAll(async () => {
    await senderPool.close()
    await recipientPool.close()
  })

  const wrapFor = async (message: Message) => wrapRumor(createRumor(message, sender, nowSeconds()), sender, recipient.publicKey, { now: nowSeconds() })

  it('delivers a sealed question to a live subscriber and keeps it retrievable afterwards', async () => {
    const seen = new SeenIds()
    const received: string[] = []
    const live = recipientPool.subscribeLive<PrecheckedWrap>(RELAYS, {
      precheck: (raw) => {
        const pre = precheckWrap(raw, { identity: recipient, now: nowSeconds(), seen })
        return pre.ok ? pre : null
      },
      process: async (item) => {
        const opened = openWrap(item, { identity: recipient, now: nowSeconds(), seen })
        if (opened.ok && opened.message.type === 'question' && opened.senderPubkey === sender.publicKey) received.push(opened.message.questionId)
      },
    })
    await sleep(3_000)

    const questionId = randomUUID()
    const wrap = await wrapFor({ v: 1, type: 'question', questionId, generation: 1, text: 'Prueba en vivo de AgentBridge 0.2' })
    const outcome = await senderPool.publish(RELAYS, wrap)
    log(`publish: ${JSON.stringify(outcome)}`)
    expect(outcome.accepted.length).toBeGreaterThanOrEqual(1)

    for (let i = 0; i < 300 && !received.includes(questionId); i++) await sleep(100)
    await live.close()
    expect(received).toContain(questionId)

    const stored = await Promise.all(
      outcome.accepted.map((relay) =>
        recipientPool.query(relay, { kinds: [1059], '#p': [recipient.publicKey], since: wrap.created_at - 1, until: wrap.created_at + 1, limit: 10 }),
      ),
    )
    const retrievable = stored.filter((r) => r.events.some((e) => (e as { id?: string }).id === wrap.id)).length
    log(`retrievable from ${retrievable}/${outcome.accepted.length} accepting relays`)
    expect(retrievable).toBeGreaterThanOrEqual(1)
  })

  it('carries a correlated answer back to the one who asked, decrypting to the same text', async () => {
    const questionSeen = new SeenIds()
    const answerSeen = new SeenIds()
    const questionId = randomUUID()
    const askedText = 'Prueba en vivo de AgentBridge 0.2: pregunta de ida y vuelta'
    const answerText = 'Prueba en vivo de AgentBridge 0.2: aquí está la respuesta correlacionada'

    let answerWrap: Awaited<ReturnType<typeof wrapRumor>> | null = null
    let answerOutcome: Awaited<ReturnType<typeof recipientPool.publish>> | null = null

    // The one who answers: opens the question, then wraps and publishes an answer back to the asker.
    const responderLive = recipientPool.subscribeLive<PrecheckedWrap>(RELAYS, {
      precheck: (raw) => {
        const pre = precheckWrap(raw, { identity: recipient, now: nowSeconds(), seen: questionSeen })
        return pre.ok ? pre : null
      },
      process: async (item) => {
        const opened = openWrap(item, { identity: recipient, now: nowSeconds(), seen: questionSeen })
        if (!opened.ok || opened.message.type !== 'question' || opened.message.questionId !== questionId || opened.senderPubkey !== sender.publicKey) return
        answerWrap = await wrapRumor(
          createRumor({ v: 1, type: 'answer', questionId, text: answerText, source: 'prueba en vivo', confidence: 'seguro' }, recipient, nowSeconds()),
          recipient,
          sender.publicKey,
          { now: nowSeconds() },
        )
        answerOutcome = await recipientPool.publish(RELAYS, answerWrap)
        log(`answer publish: ${JSON.stringify(answerOutcome)}`)
      },
    })
    await sleep(3_000)

    const questionWrap = await wrapFor({ v: 1, type: 'question', questionId, generation: 1, text: askedText })
    const questionOutcome = await senderPool.publish(RELAYS, questionWrap)
    log(`round-trip question publish: ${JSON.stringify(questionOutcome)}`)
    expect(questionOutcome.accepted.length).toBeGreaterThanOrEqual(1)

    for (let i = 0; i < 300 && !answerOutcome; i++) await sleep(100)
    await responderLive.close()
    expect(answerOutcome).not.toBeNull()
    expect(answerWrap).not.toBeNull()
    expect(answerOutcome!.accepted.length).toBeGreaterThanOrEqual(1)

    // The one who asked: reads the boards back and decrypts the answer that came back.
    const wrap = answerWrap!
    const stored = await Promise.all(
      answerOutcome!.accepted.map((relay) =>
        senderPool.query(relay, { kinds: [1059], '#p': [sender.publicKey], since: wrap.created_at - 1, until: wrap.created_at + 1, limit: 10 }),
      ),
    )

    let decodedQuestionId: string | null = null
    let decodedText: string | null = null
    for (const result of stored) {
      for (const raw of result.events) {
        const pre = precheckWrap(raw, { identity: sender, now: nowSeconds(), seen: answerSeen })
        if (!pre.ok) continue
        const opened = openWrap(pre, { identity: sender, now: nowSeconds(), seen: answerSeen })
        if (opened.ok && opened.message.type === 'answer' && opened.senderPubkey === recipient.publicKey) {
          decodedQuestionId = opened.message.questionId
          decodedText = opened.message.text
        }
      }
    }
    log(`round-trip answer decoded: ${JSON.stringify({ decodedQuestionId, decodedText })}`)
    expect(decodedQuestionId).toBe(questionId)
    expect(decodedText).toBe(answerText)
  })

  it('reports how the relays treat five quick publishes from one identity', async () => {
    const outcomes = []
    for (let i = 0; i < 5; i++) outcomes.push(await senderPool.publish(RELAYS, await wrapFor({ v: 1, type: 'receipt', questionId: randomUUID() })))
    log(`burst: ${JSON.stringify(outcomes.map((o) => ({ accepted: o.accepted.length, rejected: o.rejected.map((r) => r.reason) })))}`)
    expect(outcomes.every((o) => o.accepted.length >= 1)).toBe(true)
  })

  it('accepts a 22-bit connection request on at least one relay', async () => {
    const started = Date.now()
    const wrap = await wrapFor({ v: 1, type: 'connect_request', requestId: randomUUID(), name: 'Prueba', note: 'live', relays: RELAYS })
    log(`connect_request mined in ${Date.now() - started} ms`)
    expect(leadingZeroBits(wrap.id)).toBeGreaterThanOrEqual(22)
    const outcome = await senderPool.publish(RELAYS, wrap)
    log(`connect_request: ${JSON.stringify(outcome)}`)
    expect(outcome.accepted.length).toBeGreaterThanOrEqual(1)
  })
})
