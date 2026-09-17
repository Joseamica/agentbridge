import type { OpenedMessage } from '../envelope/open'
import { isRequestTooOld } from '../envelope/time'
import type { Identity } from '../identity'
import { NOSTR } from '../nostr-constants'
import { recordIncomingRequest, type IncomingRequestOutcome } from '../store/contacts'
import type { Store } from '../store/db'
import { admitQuestion, type AdmissionOutcome } from '../store/inbox'
import { markRequestNoticePending } from '../store/settings'
import { regenerateRequestDecision } from './connections'

export type ResponderInboundOutcome =
  | { kind: 'ignored'; reason: 'other_role' | 'request_too_old' | 'no_relays' }
  | { kind: 'request'; outcome: IncomingRequestOutcome['kind'] }
  | { kind: 'question'; outcome: AdmissionOutcome }

// Step 10 of the receive pipeline for a responder process. Only connect_request and question are its
// business: every other type belongs to this identity's asker role, whose own process reads it with
// its own history cursors, so nothing about it is stored here.
export function handleResponderMessage(store: Store, input: { identity: Identity; opened: OpenedMessage; now: number }): ResponderInboundOutcome {
  const { opened } = input
  const message = opened.message

  if (message.type === 'connect_request') {
    if (isRequestTooOld(opened.rumor.created_at, input.now)) return { kind: 'ignored', reason: 'request_too_old' }
    const relays = store.relayPolicy(message.relays).slice(0, NOSTR.maxRelaysPerContact)
    // Nobody could ever answer a request without usable relays, so it is not stored at all.
    if (relays.length === 0) return { kind: 'ignored', reason: 'no_relays' }
    return store.tx((): ResponderInboundOutcome => {
      const outcome = recordIncomingRequest(store, {
        pubkey: opened.senderPubkey,
        requestId: message.requestId,
        requestRumorId: opened.rumor.id,
        declaredName: message.name,
        note: message.note,
        relays,
        now: input.now,
      })
      if (outcome.kind === 'stored') markRequestNoticePending(store, input.now)
      if (outcome.kind === 'approved_already' || outcome.kind === 'rejected_already') {
        regenerateRequestDecision(store, { identity: input.identity, senderPubkey: opened.senderPubkey, requestId: message.requestId, replyRelays: relays, now: input.now })
      }
      return { kind: 'request', outcome: outcome.kind }
    })
  }

  if (message.type === 'question') {
    return {
      kind: 'question',
      outcome: admitQuestion(store, {
        identity: input.identity,
        senderPubkey: opened.senderPubkey,
        questionId: message.questionId,
        rumorId: opened.rumor.id,
        rumorCreatedAt: opened.rumor.created_at,
        generation: message.generation,
        text: message.text,
        now: input.now,
      }),
    }
  }

  return { kind: 'ignored', reason: 'other_role' }
}
