import { decrypt, getConversationKey } from 'nostr-tools/nip44'
import { getEventHash, verifyEvent, type NostrEvent } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { EnvelopeSizeError, NOSTR, createRumor, leadingZeroBits, wrapRumor, type Message } from '@agentbridge/core'
import { testIdentity } from './support/keys'

const sender = testIdentity(1)
const recipient = testIdentity(2)
const NOW = 1_800_000_000
const questionId = '3b241101-e2bb-4255-8caf-4136c566a962'
const question: Message = { v: 1, type: 'question', questionId, generation: 1, text: '¿Qué timeout aplica?' }

function unwrap(wrap: NostrEvent) {
  const seal = JSON.parse(decrypt(wrap.content, getConversationKey(recipient.secretKey, wrap.pubkey)))
  const rumor = JSON.parse(decrypt(seal.content, getConversationKey(recipient.secretKey, seal.pubkey)))
  return { seal, rumor }
}

describe('createRumor', () => {
  it('builds an unsigned rumor authored by the sender, with the private kind and a valid id', () => {
    const rumor = createRumor(question, sender, NOW)
    expect(rumor).toMatchObject({ pubkey: sender.publicKey, created_at: NOW, kind: NOSTR.rumorKind, tags: [] })
    expect(JSON.parse(rumor.content)).toEqual(question)
    expect(rumor.id).toBe(getEventHash(rumor))
    expect('sig' in rumor).toBe(false)
  })

  it('refuses a text over 16 KB with a Spanish size error', () => {
    const answer = { v: 1, type: 'answer', questionId, text: '€'.repeat(6000), source: 's', confidence: 'creo' } as Message
    expect(() => createRumor(answer, sender, NOW)).toThrow(EnvelopeSizeError)
    expect(() => createRumor(answer, sender, NOW)).toThrow(/demasiado grande/)
  })

  it('treats any other invalid message as a programming error', () => {
    const broken = { v: 1, type: 'receipt', questionId: 'nope' } as unknown as Message
    const err = (() => {
      try {
        createRumor(broken, sender, NOW)
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(EnvelopeSizeError)
  })
})

describe('wrapRumor', () => {
  it('seals, wraps, back-dates, tags expiration and mines 16 bits for a question', async () => {
    const rumor = createRumor(question, sender, NOW)
    const wrap = await wrapRumor(rumor, sender, recipient.publicKey, { now: NOW, random: () => 0.5 })
    expect(wrap.kind).toBe(NOSTR.wrapKind)
    expect(wrap.pubkey).not.toBe(sender.publicKey)
    expect(wrap.created_at).toBe(NOW - NOSTR.randomizationSeconds / 2)
    expect(wrap.tags).toEqual([
      ['p', recipient.publicKey],
      ['expiration', String(NOW + NOSTR.wrapExpirationSeconds)],
      ['nonce', expect.stringMatching(/^\d+$/), '16'],
    ])
    expect(leadingZeroBits(wrap.id)).toBeGreaterThanOrEqual(16)
    expect(verifyEvent(JSON.parse(JSON.stringify(wrap)))).toBe(true)
    const { seal, rumor: inner } = unwrap(wrap)
    expect(seal).toMatchObject({ kind: NOSTR.sealKind, pubkey: sender.publicKey, tags: [] })
    expect(seal.created_at).toBeLessThanOrEqual(NOW)
    expect(seal.created_at).toBeGreaterThanOrEqual(NOW - NOSTR.randomizationSeconds)
    expect(verifyEvent(seal)).toBe(true)
    expect(inner).toEqual(rumor)
  })

  it('produces a brand-new wrap for every retry of the same rumor', async () => {
    const rumor = createRumor(question, sender, NOW)
    const a = await wrapRumor(rumor, sender, recipient.publicKey, { now: NOW })
    const b = await wrapRumor(rumor, sender, recipient.publicKey, { now: NOW })
    expect(a.id).not.toBe(b.id)
    expect(a.pubkey).not.toBe(b.pubkey)
    expect(unwrap(a).rumor).toEqual(unwrap(b).rumor)
  })

  it('mines 22 bits for a connection request', { timeout: 120_000 }, async () => {
    const request: Message = { v: 1, type: 'connect_request', requestId: questionId, name: 'Ana', note: '', relays: [] }
    const wrap = await wrapRumor(createRumor(request, sender, NOW), sender, recipient.publicKey, { now: NOW })
    expect(leadingZeroBits(wrap.id)).toBeGreaterThanOrEqual(22)
    expect(wrap.tags.at(-1)).toEqual(['nonce', expect.stringMatching(/^\d+$/), '22'])
  })

  it.each([
    ['8000 one-byte characters', 'a'.repeat(8000)],
    ['5000 three-byte characters', '€'.repeat(5000)],
  ])('fits a maximum answer made of %s under the 64 KB frame cap', async (_label, text) => {
    const answer: Message = { v: 1, type: 'answer', questionId, text, source: 's'.repeat(500), confidence: 'creo' }
    const wrap = await wrapRumor(createRumor(answer, sender, NOW), sender, recipient.publicKey, { now: NOW })
    expect(Buffer.byteLength(JSON.stringify(['EVENT', wrap]))).toBeLessThanOrEqual(NOSTR.maxWrapBytes)
  })

  it('refuses, in Spanish, an answer whose JSON escaping would push the wrap past 64 KB', async () => {
    const answer: Message = { v: 1, type: 'answer', questionId, text: '"'.repeat(8000), source: 's', confidence: 'creo' }
    const attempt = async () => wrapRumor(createRumor(answer, sender, NOW), sender, recipient.publicKey, { now: NOW })
    await expect(attempt()).rejects.toThrow(EnvelopeSizeError)
  })

  it('refuses to wrap a rumor written by someone else', async () => {
    const rumor = createRumor(question, sender, NOW)
    await expect(wrapRumor(rumor, testIdentity(3), recipient.publicKey, { now: NOW })).rejects.toThrow(/author/)
  })
})
