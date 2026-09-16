import { z } from 'zod'
import { NOSTR } from '../nostr-constants'
import { ConfidenceSchema, LIMITS } from '../protocol'

const Uuid = z.uuid()
const Generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const RelayHints = z.array(z.string().max(NOSTR.maxRelayUrlLength)).max(NOSTR.maxRelaysPerContact)

const text = (maxChars: number) =>
  z
    .string()
    .max(maxChars)
    .refine((s) => Buffer.byteLength(s, 'utf8') <= NOSTR.maxTextBytes, { message: `must be at most ${NOSTR.maxTextBytes} bytes` })
const filled = (maxChars: number) => text(maxChars).refine((s) => s.trim().length > 0, { message: 'must not be blank' })

export const MessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ v: z.literal(1), type: z.literal('connect_request'), requestId: Uuid, name: filled(80), note: text(500), relays: RelayHints }),
  z.strictObject({ v: z.literal(1), type: z.literal('connect_approved'), requestId: Uuid, generation: Generation, name: filled(80), relays: RelayHints }),
  z.strictObject({ v: z.literal(1), type: z.literal('connect_rejected'), requestId: Uuid }),
  z.strictObject({ v: z.literal(1), type: z.literal('connect_revoked'), generation: Generation }),
  z.strictObject({ v: z.literal(1), type: z.literal('question'), questionId: Uuid, generation: Generation, text: filled(LIMITS.questionMaxChars) }),
  z.strictObject({ v: z.literal(1), type: z.literal('receipt'), questionId: Uuid }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal('answer'),
    questionId: Uuid,
    text: filled(LIMITS.answerMaxChars),
    source: filled(LIMITS.sourceMaxChars),
    confidence: ConfidenceSchema,
  }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal('rejected'),
    questionId: Uuid,
    reason: z.enum(['expired', 'limit', 'unanswered', 'stale_generation']),
  }),
])

export type Message = z.infer<typeof MessageSchema>
export type MessageType = Message['type']

export function powBitsFor(type: MessageType): 16 | 22 {
  return type === 'connect_request' ? NOSTR.powRequestBits : NOSTR.powMessageBits
}
