import { describe, expect, it } from 'vitest'
import {
  NOSTR,
  SeenIds,
  createRumor,
  leadingZeroBits,
  openWrap,
  precheckWrap,
  wrapRumor,
  type Message,
  type OpenContext,
} from '@agentbridge/core'
import { craftWrap } from './support/craft'
import { testIdentity } from './support/keys'

const sender = testIdentity(1)
const recipient = testIdentity(2)
const attacker = testIdentity(3)
const NOW = 1_800_000_000
const questionId = '3b241101-e2bb-4255-8caf-4136c566a962'
const question: Message = { v: 1, type: 'question', questionId, generation: 1, text: '¿Qué timeout aplica?' }
const context = (): OpenContext => ({ identity: recipient, now: NOW, seen: new SeenIds() })

function openRaw(raw: unknown, ctx = context()) {
  const pre = precheckWrap(raw, ctx)
  return pre.ok ? openWrap(pre, ctx) : pre
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const genuine = async (message: Message = question, to = recipient.publicKey) =>
  copy(await wrapRumor(createRumor(message, sender, NOW), sender, to, { now: NOW }))

describe('receive pipeline', () => {
  it('opens a genuine question and reports the authenticated sender', async () => {
    const wrap = await genuine()
    expect(openRaw(wrap)).toMatchObject({ ok: true, wrapId: wrap.id, senderPubkey: sender.publicKey, message: question })
  })

  it('rejects oversize events before parsing them', async () => {
    expect(openRaw({ ...(await genuine()), content: 'x'.repeat(70_000) })).toMatchObject({ ok: false, stage: 'size' })
  })

  it('rejects malformed events, other kinds, other recipients and future dates as structure problems', async () => {
    expect(openRaw({ hello: 'world' })).toMatchObject({ stage: 'structure' })
    expect(openRaw({ ...(await genuine()), kind: 1 })).toMatchObject({ stage: 'structure' })
    expect(openRaw(await genuine(question, attacker.publicKey))).toMatchObject({ stage: 'structure' })
    const future = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: question, now: NOW, wrapCreatedAt: NOW + 3_600, bits: 16 })
    expect(openRaw(future)).toMatchObject({ stage: 'structure' })
  })

  it('rejects an id that does not match the content', async () => {
    const wrap = await genuine()
    expect(openRaw({ ...wrap, content: `${wrap.content.slice(0, -4)}AAAA` })).toMatchObject({ stage: 'id' })
  })

  it('rejects wraps without 16 bits of proof of work', async () => {
    let weak = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: question, now: NOW })
    while (leadingZeroBits(weak.id) >= NOSTR.powMessageBits) {
      weak = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: question, now: NOW })
    }
    expect(openRaw(weak)).toMatchObject({ stage: 'pow' })
  })

  it('rejects a bad signature without letting the forged copy block the genuine wrap', async () => {
    const wrap = await genuine()
    const ctx = context()
    const forged = { ...wrap, sig: 'f'.repeat(128) }
    expect(openRaw(forged, ctx)).toMatchObject({ stage: 'signature' })
    expect(openRaw(wrap, ctx)).toMatchObject({ ok: true })
    expect(openRaw(wrap, ctx)).toMatchObject({ stage: 'duplicate' })
  })

  it('rejects a wrap whose content is not a seal', async () => {
    const wrap = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: question, now: NOW, sealPlaintext: 'not json', bits: 16 })
    expect(openRaw(wrap)).toMatchObject({ stage: 'seal' })
    const wrongKind = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: question, now: NOW, sealKind: 1, bits: 16 })
    expect(openRaw(wrongKind)).toMatchObject({ stage: 'seal' })
  })

  it('rejects impersonation: a rumor claiming the sender inside a seal signed by someone else', async () => {
    const wrap = await craftWrap({ sender, sealSigner: attacker, recipientPubkey: recipient.publicKey, content: question, now: NOW, bits: 16 })
    expect(openRaw(wrap)).toMatchObject({ stage: 'rumor' })
  })

  it('rejects rumors of another kind or dated in the future', async () => {
    const chat = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: question, now: NOW, rumorKind: 14, bits: 16 })
    expect(openRaw(chat)).toMatchObject({ stage: 'rumor' })
    const future = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: question, now: NOW, rumorCreatedAt: NOW + 3_600, bits: 16 })
    expect(openRaw(future)).toMatchObject({ stage: 'rumor' })
  })

  it('rejects content that is not a valid protocol message', async () => {
    const notJson = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: 'hola', now: NOW, bits: 16 })
    expect(openRaw(notJson)).toMatchObject({ stage: 'content' })
    const unknown = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: { v: 1, type: 'ping' }, now: NOW, bits: 16 })
    expect(openRaw(unknown)).toMatchObject({ stage: 'content' })
  })

  it('requires 22 bits for connection requests even though 16 bits pass the precheck', async () => {
    const request: Message = { v: 1, type: 'connect_request', requestId: questionId, name: 'Ana', note: '', relays: [] }
    const craft = () => craftWrap({ sender, recipientPubkey: recipient.publicKey, content: request, now: NOW, bits: 16 })
    let cheap = await craft()
    while (leadingZeroBits(cheap.id) >= NOSTR.powRequestBits) cheap = await craft()
    expect(openRaw(cheap)).toMatchObject({ stage: 'request_pow' })
  })

  it('never includes decrypted content in failure details', async () => {
    const secret = 'CONTENIDO-SECRETO-123'
    const wrap = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: { v: 1, type: 'ping', secret }, now: NOW, bits: 16 })
    const result = openRaw(wrap)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secret)
  })
})

describe('SeenIds', () => {
  it('forgets the oldest ids past its capacity', () => {
    const seen = new SeenIds(2)
    seen.add('a')
    seen.add('b')
    seen.add('a')
    seen.add('c')
    expect([seen.has('a'), seen.has('b'), seen.has('c'), seen.size]).toEqual([false, true, true, 2])
  })

  it('forgets an id on request, so a message whose persistence failed can be delivered again', () => {
    const seen = new SeenIds()
    seen.add('a')
    seen.delete('a')
    expect(seen.has('a')).toBe(false)
  })
})
