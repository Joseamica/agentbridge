import { createRumor, type Rumor } from '../envelope/seal'
import type { Message } from '../envelope/messages'
import { UserFacingError } from '../errors'
import type { Identity } from '../identity'
import { NOSTR } from '../nostr-constants'
import { CLI_COMMAND } from '../published'
import {
  approveRequest,
  findContactByLocalName,
  getContact,
  listPendingRequests,
  purgeRequests,
  rejectRequest,
  revokeInbound,
  type Contact,
} from '../store/contacts'
import type { Store } from '../store/db'
import { rejectUnansweredFor } from '../store/inbox'
import { deleteUnclaimedFor, enqueue } from '../store/outbox'
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

function findInbound(store: Store, idPrefix: string, states: readonly Contact['state'][]): Contact {
  const normalized = idPrefix.trim().toLowerCase()
  if (!/^[0-9a-f]{8,64}$/.test(normalized)) {
    throw new UserFacingError('El identificador debe tener al menos 8 caracteres hexadecimales, tal como aparece en la lista de solicitudes.')
  }
  const placeholders = states.map(() => '?').join(', ')
  const rows = store.db
    .prepare(`SELECT pubkey FROM contacts WHERE direction = 'inbound' AND state IN (${placeholders}) AND pubkey LIKE ? ORDER BY requested_at`)
    .all(...states, `${normalized}%`) as Array<{ pubkey: string }>
  if (rows.length === 0) throw new UserFacingError('No hay ninguna solicitud con ese identificador. Revisa la lista de solicitudes.')
  if (rows.length > 1) throw new UserFacingError('Ese identificador coincide con varias solicitudes. Escribe más caracteres del identificador.')
  return getContact(store, rows[0]!.pubkey, 'inbound')!
}

function send(store: Store, input: { recipient: string; relays: readonly string[]; rumor: Rumor; label: string; now: number }): void {
  if (input.relays.length === 0) return
  enqueue(store, {
    recipient: input.recipient,
    rumor: input.rumor,
    label: input.label,
    powBits: 16,
    relays: input.relays.slice(0, NOSTR.maxRelaysPerContact),
    policy: 'once',
    now: input.now,
  })
}

function storeDecisionRumor(store: Store, senderPubkey: string, requestId: string, rumor: Rumor): void {
  store.db.prepare('UPDATE requests SET decision_rumor_json = ? WHERE sender_pubkey = ? AND request_id = ?').run(JSON.stringify(rumor), senderPubkey, requestId)
}

export function approveConnection(store: Store, input: { identity: Identity; idPrefix: string; now: number }): { contact: Contact; changed: boolean } {
  return store.tx(() => {
    purgeRequests(store, input.now)
    const target = findInbound(store, input.idPrefix, ['requested', 'approved'])
    if (target.state === 'approved') return { contact: target, changed: false }
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
    deleteUnclaimedFor(store, { recipient: contact.pubkey, now: input.now })
    const rumor = createRumor({ v: 1, type: 'connect_revoked', generation: contact.generation }, input.identity, input.now)
    send(store, { recipient: contact.pubkey, relays: contact.relays, rumor, label: 'connect_revoked', now: input.now })
    return { contact, changed: true, rejectedQuestions }
  })
}

// A retried connect_request that was already decided gets the same decision again: the stored rumor
// when there is one, or one created now (and stored) for a request recorded as approved after the
// fact. It goes to the relays of the request being answered. A decision already sent is resent at most
// once per regeneration interval; the clock lives on the request record, so deleting outbox rows
// (revocation, purge) cannot reset it.
export function regenerateRequestDecision(
  store: Store,
  input: { identity: Identity; senderPubkey: string; requestId: string; replyRelays: readonly string[]; now: number },
): 'enqueued' | 'too_soon' | 'nothing' {
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
    send(store, {
      recipient: input.senderPubkey,
      relays,
      rumor: JSON.parse(rumorJson) as Rumor,
      label: record.decision === 'approved' ? 'connect_approved' : 'connect_rejected',
      now: input.now,
    })
    store.db.prepare('UPDATE requests SET decision_resent_at = ? WHERE sender_pubkey = ? AND request_id = ?').run(input.now, input.senderPubkey, input.requestId)
    return 'enqueued'
  })
}
