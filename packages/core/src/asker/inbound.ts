import type { OpenedMessage } from '../envelope/open'
import type { Identity } from '../identity'
import { NOSTR } from '../nostr-constants'
import { applyApproval, applyRejection, applyRevocation } from '../store/contacts'
import type { Store } from '../store/db'
import { applyAnswer, applyReceipt, applyRejected } from '../store/outbox-questions'

export type AskerInboundOutcome =
  | { kind: 'ignored'; reason: 'other_role' | 'no_relays' }
  | { kind: 'permission'; type: 'connect_approved' | 'connect_rejected' | 'connect_revoked'; outcome: 'applied' | 'ignored' }
  | { kind: 'question'; type: 'receipt' | 'answer' | 'rejected'; questionId: string; outcome: 'applied' | 'ignored' }

// Step 10 of the receive pipeline for an asker process. Only the six messages an asker can act on are
// its business: connect_request and question belong to this identity's responder role, whose own
// process reads them with its own history cursors, so nothing about them is stored here.
//
// Every rule about *which* of these messages counts — a request id that must match the pending
// request, a generation that must be greater than the maximum ever observed, a question that must be
// one this person actually sent to that very recipient — lives in the store functions below. This
// file only routes.
export function handleAskerMessage(store: Store, input: { identity: Identity; opened: OpenedMessage; now: number }): AskerInboundOutcome {
  const { opened } = input
  const message = opened.message
  const sender = opened.senderPubkey

  switch (message.type) {
    case 'connect_approved': {
      const relays = store.relayPolicy(message.relays).slice(0, NOSTR.maxRelaysPerContact)
      // An approval with no usable relay leaves nowhere to send questions, so it is not stored at
      // all — the mirror of how a responder ignores a request with no usable relay.
      if (relays.length === 0) return { kind: 'ignored', reason: 'no_relays' }
      const outcome = applyApproval(store, {
        pubkey: sender,
        requestId: message.requestId,
        generation: message.generation,
        name: message.name,
        relays,
        now: input.now,
      })
      return { kind: 'permission', type: 'connect_approved', outcome }
    }
    case 'connect_rejected':
      return { kind: 'permission', type: 'connect_rejected', outcome: applyRejection(store, { pubkey: sender, requestId: message.requestId, now: input.now }) }
    case 'connect_revoked':
      return { kind: 'permission', type: 'connect_revoked', outcome: applyRevocation(store, { pubkey: sender, generation: message.generation, now: input.now }) }
    case 'receipt':
      return {
        kind: 'question',
        type: 'receipt',
        questionId: message.questionId,
        outcome: applyReceipt(store, { recipient: sender, questionId: message.questionId, now: input.now }),
      }
    case 'answer':
      return {
        kind: 'question',
        type: 'answer',
        questionId: message.questionId,
        outcome: applyAnswer(store, {
          recipient: sender,
          questionId: message.questionId,
          answer: { text: message.text, source: message.source, confidence: message.confidence },
          now: input.now,
        }),
      }
    case 'rejected':
      return {
        kind: 'question',
        type: 'rejected',
        questionId: message.questionId,
        outcome: applyRejected(store, { recipient: sender, questionId: message.questionId, reason: message.reason, now: input.now }),
      }
    default:
      return { kind: 'ignored', reason: 'other_role' }
  }
}
