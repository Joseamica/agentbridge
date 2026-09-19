import { createRumor, type Rumor } from '../envelope/seal'
import type { Message } from '../envelope/messages'
import { UserFacingError } from '../errors'
import type { Identity } from '../identity'
import { NOSTR } from '../nostr-constants'
import { CLI_COMMAND } from '../published'
import {
  approveRequest,
  findContactByLocalName,
  findRequestsByPrefix,
  getContact,
  listPendingRequests,
  purgeRequests,
  rejectRequest,
  revokeInbound,
  type Contact,
} from '../store/contacts'
import type { Store } from '../store/db'
import { rejectUnansweredFor } from '../store/inbox'
import { deleteUnclaimedFor, enqueue, type EnqueueOutcome } from '../store/outbox'
import { clearRequestNoticePending, getProfile } from '../store/settings'

export const REQUEST_ID_LENGTH = 8

export type PendingRequestView = { id: string; pubkey: string; declaredName: string; note: string; requestedAt: number }

type RequestRecord = {
  decision: 'approved' | 'rejected' | null
  decision_generation: number | null
  decision_rumor_json: string | null
  decided_at: number | null
  decision_resent_at: number | null
}

export function listRequests(store: Store, now: number): PendingRequestView[] {
  purgeRequests(store, now)
  clearRequestNoticePending(store, now)
  return listPendingRequests(store).map((contact) => ({
    id: contact.pubkey.slice(0, REQUEST_ID_LENGTH),
    pubkey: contact.pubkey,
    declaredName: contact.declaredName ?? '',
    note: contact.note ?? '',
    requestedAt: contact.requestedAt ?? 0,
  }))
}

const ALL_INBOUND_STATES: readonly Contact['state'][] = ['requested', 'approved', 'rejected', 'revoked']

// I2: a prefix that matches a real contact whose decision already went the other way (or who was
// later revoked) must not read the same as one that never existed — this plan tells the truth about
// every other kind of "already ...", and "no encontrada" for something that does in fact exist is the
// one kind of lie a person cannot debug.
function opposingStateMessage(state: Contact['state']): string {
  switch (state) {
    case 'approved':
      return 'Ya le diste permiso a esa persona; no puedes rechazar una solicitud que ya aceptaste.'
    case 'rejected':
      return 'Ya le dijiste que no a esa persona; no puedes aprobar la misma solicitud.'
    case 'revoked':
      return 'Le retiraste el permiso a esa persona anteriormente. Debe enviarte una solicitud nueva.'
    default:
      return 'No hay ninguna solicitud con ese identificador. Revisa la lista de solicitudes.'
  }
}

function findInbound(store: Store, idPrefix: string, wanted: readonly Contact['state'][]): Contact {
  const rows = findRequestsByPrefix(store, idPrefix, wanted)
  if (rows.length === 1) return getContact(store, rows[0]!.pubkey, 'inbound')!
  if (rows.length > 1) throw new UserFacingError('Ese identificador coincide con varias solicitudes. Escribe más caracteres del identificador.')
  // Nothing in the wanted states matched. Before reporting "no encontrada", check whether the prefix
  // actually belongs to a contact whose state just isn't one of the ones this call wanted.
  const any = findRequestsByPrefix(store, idPrefix, ALL_INBOUND_STATES)
  if (any.length > 1) throw new UserFacingError('Ese identificador coincide con varias solicitudes. Escribe más caracteres del identificador.')
  throw new UserFacingError(any.length === 1 ? opposingStateMessage(any[0]!.state) : 'No hay ninguna solicitud con ese identificador. Revisa la lista de solicitudes.')
}

// 'no_relays' stands in for the enqueue outcomes that never happen: there is nowhere to send.
function send(store: Store, input: { recipient: string; relays: readonly string[]; rumor: Rumor; label: string; now: number }): EnqueueOutcome | 'no_relays' {
  if (input.relays.length === 0) return 'no_relays'
  return enqueue(store, {
    recipient: input.recipient,
    rumor: input.rumor,
    label: input.label,
    powBits: 16,
    relays: input.relays.slice(0, NOSTR.maxRelaysPerContact),
    policy: 'once',
    now: input.now,
  })
}

// Every decision must be stored before it is enqueued (Global Constraints, "Decisions"). If the
// UPDATE ever matches no row, that invariant already broke upstream — fail loudly instead of
// silently leaving a decision that was never actually recorded.
function storeDecisionRumor(store: Store, senderPubkey: string, requestId: string, rumor: Rumor): void {
  const result = store.db
    .prepare('UPDATE requests SET decision_rumor_json = ? WHERE sender_pubkey = ? AND request_id = ?')
    .run(JSON.stringify(rumor), senderPubkey, requestId)
  if (Number(result.changes) === 0) {
    throw new Error(`storeDecisionRumor: no request row for sender ${senderPubkey} request ${requestId}`)
  }
}

export function approveConnection(store: Store, input: { identity: Identity; idPrefix: string; now: number }): { contact: Contact; changed: boolean } {
  return store.tx(() => {
    purgeRequests(store, input.now)
    const target = findInbound(store, input.idPrefix, ['requested', 'approved'])
    if (target.state === 'approved') return { contact: target, changed: false }
    if (target.relays.length === 0) {
      throw new UserFacingError('Esa solicitud no trae tableros donde responder, así que no se puede aprobar. Pídele a esa persona que te envíe una solicitud nueva.')
    }
    const profile = getProfile(store)
    if (!profile.name) throw new UserFacingError(`Antes de aprobar solicitudes, completa tu configuración con: ${CLI_COMMAND} setup`)
    const { contact } = approveRequest(store, { pubkey: target.pubkey, now: input.now })
    const requestId = contact.requestId!
    const rumor = createRumor(
      { v: 1, type: 'connect_approved', requestId, generation: contact.generation, name: profile.name, relays: profile.relays.slice(0, NOSTR.maxRelaysPerContact) },
      input.identity,
      input.now,
    )
    storeDecisionRumor(store, contact.pubkey, requestId, rumor)
    send(store, { recipient: contact.pubkey, relays: contact.relays, rumor, label: 'connect_approved', now: input.now })
    return { contact, changed: true }
  })
}

export function rejectConnection(store: Store, input: { identity: Identity; idPrefix: string; now: number }): { contact: Contact; changed: boolean } {
  return store.tx(() => {
    purgeRequests(store, input.now)
    const target = findInbound(store, input.idPrefix, ['requested', 'rejected'])
    if (target.state === 'rejected') return { contact: target, changed: false }
    const { contact } = rejectRequest(store, { pubkey: target.pubkey, now: input.now })
    const requestId = contact.requestId!
    const rumor = createRumor({ v: 1, type: 'connect_rejected', requestId }, input.identity, input.now)
    storeDecisionRumor(store, contact.pubkey, requestId, rumor)
    send(store, { recipient: contact.pubkey, relays: contact.relays, rumor, label: 'connect_rejected', now: input.now })
    return { contact, changed: true }
  })
}

// C1: everything this person, as a responder, might already have queued toward the pubkey being
// revoked — decisions on the connection itself, and the responses to its questions. 'rejected:' is a
// prefix because rejectQuestion's own label carries the reject reason (e.g. 'rejected:expired', see
// decisionLabel in store/inbox.ts). Deliberately excludes 'connect_request' and 'question' — this
// person's own traffic to the same pubkey as an ASKER, which a responder-side revocation must never
// touch: an outbound question already sent survives the other direction's contact being revoked (P11).
const RESPONDER_OUTBOUND_LABELS: readonly string[] = ['connect_approved', 'connect_rejected', 'connect_revoked', 'receipt', 'answer', 'rejected:']

export function revokeConnection(
  store: Store,
  input: { identity: Identity; name: string; now: number },
): { contact: Contact; changed: boolean; rejectedQuestions: number } {
  return store.tx(() => {
    const target = findContactByLocalName(store, 'inbound', input.name.trim().toLowerCase())
    if (!target) throw new UserFacingError('No tienes ningún contacto con ese nombre. Revisa tu lista de contactos.')
    if (target.state === 'revoked') return { contact: target, changed: false, rejectedQuestions: 0 }
    const { contact } = revokeInbound(store, { pubkey: target.pubkey, now: input.now })
    const rejectedQuestions = rejectUnansweredFor(store, { identity: input.identity, senderPubkey: contact.pubkey, now: input.now })
    deleteUnclaimedFor(store, { recipient: contact.pubkey, labels: RESPONDER_OUTBOUND_LABELS, now: input.now })
    const rumor = createRumor({ v: 1, type: 'connect_revoked', generation: contact.generation }, input.identity, input.now)
    send(store, { recipient: contact.pubkey, relays: contact.relays, rumor, label: 'connect_revoked', now: input.now })
    return { contact, changed: true, rejectedQuestions }
  })
}

// A retried connect_request that was already decided gets the same decision again: the stored rumor
// when there is one, or one created now (and stored) for a request recorded as approved after the
// fact. It goes to the relays of the request being answered. A decision already sent is resent at most
// once per regeneration interval; the clock lives on the request record, so deleting outbox rows
// (revocation, purge) cannot reset it. The clock only advances when the outbox actually (re)armed the
// row: an outbox row still 'pending' from an earlier send ('already_pending') means nothing new
// happened, and an 'abandoned' row means the send never reached the outbox at all, so callers must be
// able to tell that apart from a real resend instead of being told 'enqueued' either way.
export function regenerateRequestDecision(
  store: Store,
  input: { identity: Identity; senderPubkey: string; requestId: string; replyRelays: readonly string[]; now: number },
): 'enqueued' | 'too_soon' | 'nothing' | 'abandoned' {
  return store.tx(() => {
    const record = store.db
      .prepare('SELECT decision, decision_generation, decision_rumor_json, decided_at, decision_resent_at FROM requests WHERE sender_pubkey = ? AND request_id = ?')
      .get(input.senderPubkey, input.requestId) as RequestRecord | undefined
    if (!record?.decision) return 'nothing'
    const lastSent = record.decision_resent_at ?? record.decided_at
    if (record.decision_rumor_json !== null && lastSent !== null && input.now - lastSent < NOSTR.regenerationIntervalSeconds) return 'too_soon'
    const relays = input.replyRelays.length > 0 ? [...input.replyRelays] : (getContact(store, input.senderPubkey, 'inbound')?.relays ?? [])
    if (relays.length === 0) return 'nothing'
    let rumorJson = record.decision_rumor_json
    if (rumorJson === null) {
      let message: Message
      if (record.decision === 'approved') {
        const profile = getProfile(store)
        if (!profile.name || record.decision_generation === null) return 'nothing'
        message = {
          v: 1,
          type: 'connect_approved',
          requestId: input.requestId,
          generation: record.decision_generation,
          name: profile.name,
          relays: profile.relays.slice(0, NOSTR.maxRelaysPerContact),
        }
      } else {
        message = { v: 1, type: 'connect_rejected', requestId: input.requestId }
      }
      const rumor = createRumor(message, input.identity, input.now)
      storeDecisionRumor(store, input.senderPubkey, input.requestId, rumor)
      rumorJson = JSON.stringify(rumor)
    }
    const outcome = send(store, {
      recipient: input.senderPubkey,
      relays,
      rumor: JSON.parse(rumorJson) as Rumor,
      label: record.decision === 'approved' ? 'connect_approved' : 'connect_rejected',
      now: input.now,
    })
    if (outcome === 'no_relays') return 'nothing'
    if (outcome === 'regeneration_too_soon') return 'too_soon'
    if (outcome === 'abandoned') return 'abandoned'
    // 'already_pending': the earlier send is still waiting to publish, so nothing new happened —
    // the clock stays put. Every other outcome ('enqueued', 'postponed_cap', 'regenerated')
    // actually (re)armed the row, so the resend clock advances.
    if (outcome !== 'already_pending') {
      store.db.prepare('UPDATE requests SET decision_resent_at = ? WHERE sender_pubkey = ? AND request_id = ?').run(input.now, input.senderPubkey, input.requestId)
    }
    return 'enqueued'
  })
}
