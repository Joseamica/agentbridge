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
  rumorKind?: number
  rumorCreatedAt?: number
  wrapCreatedAt?: number
  bits?: number
}

// Builds envelopes the production code would refuse to build, for pipeline tests. The result is a
// fresh JSON copy, like an event parsed from a relay frame.
export async function craftWrap(o: CraftOptions): Promise<NostrEvent> {
  const unsignedRumor = {
    pubkey: o.sender.publicKey,
    created_at: o.rumorCreatedAt ?? o.now,
    kind: o.rumorKind ?? NOSTR.rumorKind,
    tags: [] as string[][],
    content: typeof o.content === 'string' ? o.content : JSON.stringify(o.content),
  }
  const rumor = { ...unsignedRumor, id: getEventHash(unsignedRumor) }
  const signer = o.sealSigner ?? o.sender
  const seal = finalizeEvent(
    {
      kind: o.sealKind ?? NOSTR.sealKind,
      created_at: o.now,
      tags: [],
      content: encrypt(JSON.stringify(rumor), getConversationKey(signer.secretKey, o.recipientPubkey)),
    },
    signer.secretKey,
  )
  const wrapKey = generateSecretKey()
  const unsignedWrap = {
    pubkey: getPublicKey(wrapKey),
    created_at: o.wrapCreatedAt ?? o.now,
    kind: NOSTR.wrapKind,
    tags: [['p', o.recipientPubkey]],
    content: encrypt(o.sealPlaintext ?? JSON.stringify(seal), getConversationKey(wrapKey, o.recipientPubkey)),
  }
  const mined = o.bits ? await mineEvent(unsignedWrap, o.bits) : unsignedWrap
  const wrap = finalizeEvent({ kind: mined.kind, created_at: mined.created_at, tags: mined.tags, content: mined.content }, wrapKey)
  return JSON.parse(JSON.stringify(wrap)) as NostrEvent
}
