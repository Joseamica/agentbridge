import { randomInt } from 'node:crypto'
import { encrypt, getConversationKey } from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import { UserFacingError } from '../errors'
import type { Identity } from '../identity'
import { NOSTR } from '../nostr-constants'
import { MessageSchema, powBitsFor, type Message } from './messages'
import { mineEvent } from './pow'

export type Rumor = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }
export type WrapOptions = { now: number; random?: () => number; signal?: AbortSignal }

export class EnvelopeSizeError extends UserFacingError {
  constructor() {
    super('El mensaje es demasiado grande para enviarse por los tableros. Acórtalo e inténtalo de nuevo.')
    this.name = 'EnvelopeSizeError'
  }
}

const HEX_64 = /^[0-9a-f]{64}$/
const TEXT_FIELDS = new Set(['text', 'source', 'note', 'name'])
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
// The nonce tag added by mining is at most ["nonce","4294967295","22"] plus a separator.
const NONCE_TAG_SLACK_BYTES = 40
// Ruling 28: a uniform number in [0, 1) from the OS CSPRNG. The dates it randomizes hide when a
// message was really sent, so they must not be predictable. randomInt's range must stay below 2^48.
const cryptoRandom = () => randomInt(0, 2 ** 48 - 1) / 2 ** 48

export function createRumor(message: Message, sender: Identity, createdAt: number): Rumor {
  const parsed = MessageSchema.safeParse(message)
  if (!parsed.success) {
    const sizeProblem = parsed.error.issues.some(
      (issue) => TEXT_FIELDS.has(String(issue.path.at(-1))) && (issue.code === 'too_big' || (issue.code === 'custom' && issue.message.includes('bytes'))),
    )
    if (sizeProblem) throw new EnvelopeSizeError()
    throw new Error(`createRumor: invalid message at ${parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}`)
  }
  const unsigned = { pubkey: sender.publicKey, created_at: createdAt, kind: NOSTR.rumorKind, tags: [] as string[][], content: JSON.stringify(parsed.data) }
  const rumor: Rumor = { ...unsigned, id: getEventHash(unsigned) }
  if (jsonBytes(rumor) > NOSTR.maxRumorBytes) throw new EnvelopeSizeError()
  return rumor
}

export async function wrapRumor(rumor: Rumor, sender: Identity, recipientPubkey: string, options: WrapOptions): Promise<NostrEvent> {
  if (rumor.pubkey !== sender.publicKey) throw new Error('wrapRumor: the rumor author must be the sender')
  if (!HEX_64.test(recipientPubkey)) throw new Error('wrapRumor: recipientPubkey must be 64 lowercase hex characters')
  if (jsonBytes(rumor) > NOSTR.maxRumorBytes) throw new EnvelopeSizeError()
  const message = MessageSchema.parse(JSON.parse(rumor.content))
  const random = options.random ?? cryptoRandom
  const pastDate = () => options.now - Math.floor(random() * NOSTR.randomizationSeconds)

  const seal = finalizeEvent(
    {
      kind: NOSTR.sealKind,
      created_at: pastDate(),
      tags: [],
      content: encrypt(JSON.stringify(rumor), getConversationKey(sender.secretKey, recipientPubkey)),
    },
    sender.secretKey,
  )
  if (jsonBytes(seal) > NOSTR.maxSealBytes) throw new EnvelopeSizeError()

  const wrapKey = generateSecretKey()
  const unsigned = {
    pubkey: getPublicKey(wrapKey),
    created_at: pastDate(),
    kind: NOSTR.wrapKind,
    tags: [
      ['p', recipientPubkey],
      // Ruling 28: jittered like the dates, so the tag does not give away the real publish second.
      ['expiration', String(options.now + NOSTR.wrapExpirationSeconds + Math.floor(random() * NOSTR.randomizationSeconds))],
    ],
    content: encrypt(JSON.stringify(seal), getConversationKey(wrapKey, recipientPubkey)),
  }
  const placeholder = { ...unsigned, id: '0'.repeat(64), sig: '0'.repeat(128) }
  if (jsonBytes(['EVENT', placeholder]) + NONCE_TAG_SLACK_BYTES > NOSTR.maxWrapBytes) throw new EnvelopeSizeError()

  const mined = await mineEvent(unsigned, powBitsFor(message.type), { signal: options.signal })
  const wrap = finalizeEvent({ kind: mined.kind, created_at: mined.created_at, tags: mined.tags, content: mined.content }, wrapKey)
  if (wrap.id !== mined.id) throw new Error('wrapRumor: the mined id does not match the signed wrap')
  if (jsonBytes(['EVENT', wrap]) > NOSTR.maxWrapBytes) throw new EnvelopeSizeError()
  return wrap
}
