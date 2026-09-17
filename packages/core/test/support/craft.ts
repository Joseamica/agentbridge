import { encrypt, getConversationKey } from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import { NOSTR, mineEvent, type Identity } from '@agentbridge/core'

export type CraftOptions = {
  sender: Identity
  recipientPubkey: string
  content: unknown
  now: number
  sealSigner?: Identity
  sealPlaintext?: string
  sealKind?: number
  sealCreatedAt?: number
  // Pads the layer with a signed ["filler", "xxx…"] tag until its JSON is exactly this many bytes.
  sealBytes?: number
  // Rewrites the layer's JSON right before it is encrypted into the next layer.
  sealJson?: (json: string) => string
  rumorKind?: number
  rumorCreatedAt?: number
  rumorId?: string
  rumorBytes?: number
  rumorJson?: (json: string) => string
  wrapCreatedAt?: number
  extraWrapTags?: string[][]
  bits?: number
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const unchanged = (json: string) => json

// Builds a layer with no tags, or, when `bytes` is set, rebuilds it with one filler tag so its JSON
// is exactly that long.
function sized<T>(build: (tags: string[][]) => T, bytes: number | undefined): T {
  const plain = build([])
  if (bytes === undefined) return plain
  const filler = bytes - jsonBytes(plain) - (jsonBytes([['filler', '']]) - jsonBytes([]))
  const layer = build([['filler', 'x'.repeat(Math.max(0, filler))]])
  if (jsonBytes(layer) !== bytes) throw new Error(`craftWrap: cannot size a layer to ${bytes} bytes`)
  return layer
}

// Builds envelopes the production code would refuse to build, for pipeline tests. The result is a
// fresh JSON copy, like an event parsed from a relay frame.
export async function craftWrap(o: CraftOptions): Promise<NostrEvent> {
  const content = typeof o.content === 'string' ? o.content : JSON.stringify(o.content)
  const rumor = sized((tags) => {
    const unsigned = { pubkey: o.sender.publicKey, created_at: o.rumorCreatedAt ?? o.now, kind: o.rumorKind ?? NOSTR.rumorKind, tags, content }
    return { ...unsigned, id: o.rumorId ?? getEventHash(unsigned) }
  }, o.rumorBytes)
  const signer = o.sealSigner ?? o.sender
  const sealContent = encrypt((o.rumorJson ?? unchanged)(JSON.stringify(rumor)), getConversationKey(signer.secretKey, o.recipientPubkey))
  const seal = sized(
    (tags) => finalizeEvent({ kind: o.sealKind ?? NOSTR.sealKind, created_at: o.sealCreatedAt ?? o.now, tags, content: sealContent }, signer.secretKey),
    o.sealBytes,
  )
  const wrapKey = generateSecretKey()
  const unsignedWrap = {
    pubkey: getPublicKey(wrapKey),
    created_at: o.wrapCreatedAt ?? o.now,
    kind: NOSTR.wrapKind,
    tags: [['p', o.recipientPubkey], ...(o.extraWrapTags ?? [])],
    content: encrypt(o.sealPlaintext ?? (o.sealJson ?? unchanged)(JSON.stringify(seal)), getConversationKey(wrapKey, o.recipientPubkey)),
  }
  const mined = o.bits ? await mineEvent(unsignedWrap, o.bits) : unsignedWrap
  const wrap = finalizeEvent({ kind: mined.kind, created_at: mined.created_at, tags: mined.tags, content: mined.content }, wrapKey)
  return JSON.parse(JSON.stringify(wrap)) as NostrEvent
}
