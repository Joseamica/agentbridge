import { decrypt, getConversationKey } from 'nostr-tools/nip44'
import { getEventHash, verifyEvent, type NostrEvent } from 'nostr-tools/pure'
import { z } from 'zod'
import type { Identity } from '../identity'
import { NOSTR } from '../nostr-constants'
import type { SeenIds } from './dedupe'
import { MessageSchema, type Message } from './messages'
import { leadingZeroBits } from './pow'
import type { Rumor } from './seal'
import { isFutureDated } from './time'

export type OpenContext = { identity: Identity; now: number; seen: SeenIds }
export type OpenFailureStage = 'size' | 'structure' | 'id' | 'pow' | 'duplicate' | 'signature' | 'seal' | 'rumor' | 'content' | 'request_pow'
export type OpenFailure = { ok: false; stage: OpenFailureStage; detail: string }
export type PrecheckedWrap = { ok: true; wrap: NostrEvent; powBits: number }
export type OpenedMessage = { ok: true; wrapId: string; senderPubkey: string; rumor: Rumor; message: Message; powBits: number }

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/)
const Timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const Tags = z.array(z.array(z.string()))
const EventShape = z.strictObject({
  id: Hex64,
  pubkey: Hex64,
  created_at: Timestamp,
  kind: z.number().int().nonnegative(),
  tags: Tags,
  content: z.string(),
  sig: z.string().regex(/^[0-9a-f]{128}$/),
})
const RumorShape = z.strictObject({ id: Hex64, pubkey: Hex64, created_at: Timestamp, kind: z.number().int().nonnegative(), tags: Tags, content: z.string() })

const fail = (stage: OpenFailureStage, detail: string): OpenFailure => ({ ok: false, stage, detail })

function byteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

// nostr-tools' verifyEvent trusts a marker that object spread copies. Always verify a plain object
// rebuilt field by field from parsed data.
const plainEvent = (e: z.infer<typeof EventShape>): NostrEvent => ({
  id: e.id,
  pubkey: e.pubkey,
  created_at: e.created_at,
  kind: e.kind,
  tags: e.tags,
  content: e.content,
  sig: e.sig,
})

export function precheckWrap(raw: unknown, ctx: OpenContext): PrecheckedWrap | OpenFailure {
  if (byteSize(raw) > NOSTR.maxWrapBytes) return fail('size', 'event exceeds 64 KB')
  const shape = EventShape.safeParse(raw)
  if (!shape.success) return fail('structure', 'malformed event')
  const wrap = plainEvent(shape.data)
  if (wrap.kind !== NOSTR.wrapKind) return fail('structure', 'not a gift wrap')
  const recipients = wrap.tags.filter((t) => t[0] === 'p')
  if (recipients.length !== 1 || recipients[0]![1] !== ctx.identity.publicKey) return fail('structure', 'not addressed to this identity')
  if (isFutureDated(wrap.created_at, ctx.now)) return fail('structure', 'wrap dated in the future')
  if (getEventHash(wrap) !== wrap.id) return fail('id', 'wrap id does not match its content')
  const powBits = leadingZeroBits(wrap.id)
  if (powBits < NOSTR.powMessageBits) return fail('pow', 'wrap has less than 16 bits of proof of work')
  if (ctx.seen.has(wrap.id)) return fail('duplicate', 'wrap already processed')
  if (!verifyEvent(wrap)) return fail('signature', 'invalid wrap signature')
  ctx.seen.add(wrap.id)
  return { ok: true, wrap, powBits }
}

export function openWrap(prechecked: PrecheckedWrap, ctx: OpenContext): OpenedMessage | OpenFailure {
  let sealRaw: unknown
  try {
    sealRaw = JSON.parse(decrypt(prechecked.wrap.content, getConversationKey(ctx.identity.secretKey, prechecked.wrap.pubkey)))
  } catch {
    return fail('seal', 'wrap content is not a decryptable seal')
  }
  if (byteSize(sealRaw) > NOSTR.maxSealBytes) return fail('seal', 'seal exceeds 40 KB')
  const sealShape = EventShape.safeParse(sealRaw)
  if (!sealShape.success) return fail('seal', 'malformed seal')
  const seal = plainEvent(sealShape.data)
  if (seal.kind !== NOSTR.sealKind) return fail('seal', 'unexpected seal kind')
  if (isFutureDated(seal.created_at, ctx.now)) return fail('seal', 'seal dated in the future')
  if (getEventHash(seal) !== seal.id || !verifyEvent(seal)) return fail('seal', 'invalid seal signature')

  let rumorRaw: unknown
  try {
    rumorRaw = JSON.parse(decrypt(seal.content, getConversationKey(ctx.identity.secretKey, seal.pubkey)))
  } catch {
    return fail('rumor', 'seal content is not a decryptable rumor')
  }
  if (byteSize(rumorRaw) > NOSTR.maxRumorBytes) return fail('rumor', 'rumor exceeds 28 KB')
  const rumorShape = RumorShape.safeParse(rumorRaw)
  if (!rumorShape.success) return fail('rumor', 'malformed rumor')
  const r = rumorShape.data
  const rumor: Rumor = { id: r.id, pubkey: r.pubkey, created_at: r.created_at, kind: r.kind, tags: r.tags, content: r.content }
  if (rumor.kind !== NOSTR.rumorKind) return fail('rumor', 'unexpected rumor kind')
  if (getEventHash(rumor) !== rumor.id) return fail('rumor', 'rumor id does not match its content')
  if (rumor.pubkey !== seal.pubkey) return fail('rumor', 'rumor author differs from the seal signer')
  if (isFutureDated(rumor.created_at, ctx.now)) return fail('rumor', 'rumor dated in the future')

  let content: unknown
  try {
    content = JSON.parse(rumor.content)
  } catch {
    return fail('content', 'rumor content is not JSON')
  }
  const message = MessageSchema.safeParse(content)
  if (!message.success) return fail('content', 'rumor content is not a valid protocol message')
  if (message.data.type === 'connect_request' && prechecked.powBits < NOSTR.powRequestBits) {
    return fail('request_pow', 'connection request has less than 22 bits of proof of work')
  }
  return { ok: true, wrapId: prechecked.wrap.id, senderPubkey: seal.pubkey, rumor, message: message.data, powBits: prechecked.powBits }
}
