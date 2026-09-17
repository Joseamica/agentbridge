import { UserFacingError } from '../errors'
import { NOSTR } from '../nostr-constants'
import { HandleSchema } from '../protocol'
import type { Store } from './db'

export type Direction = 'inbound' | 'outbound'
export type ContactState = 'requested' | 'pending' | 'approved' | 'rejected' | 'revoked'

export type Contact = {
  pubkey: string
  direction: Direction
  state: ContactState
  generation: number
  maxGenerationSeen: number
  requestId: string | null
  requestRumorId: string | null
  localName: string | null
  declaredName: string | null
  note: string | null
  relays: string[]
  requestedAt: number | null
  decidedAt: number | null
  createdAt: number
  updatedAt: number
}

export type IncomingRequest = {
  pubkey: string
  requestId: string
  requestRumorId: string
  declaredName: string
  note: string
  relays: readonly unknown[]
  now: number
}

export type IncomingRequestOutcome =
  | { kind: 'stored'; evictedPubkey: string | null }
  | { kind: 'duplicate' }
  | { kind: 'approved_already'; contact: Contact }
  | { kind: 'rejected_already'; contact: Contact }
  | { kind: 'ignored_recently_rejected' }
  | { kind: 'ignored_stale' }
  | { kind: 'conflict' }

type ContactRow = {
  pubkey: string
  direction: Direction
  state: ContactState
  generation: number
  max_generation_seen: number
  request_id: string | null
  request_rumor_id: string | null
  local_name: string | null
  declared_name: string | null
  note: string | null
  relays: string
  requested_at: number | null
  decided_at: number | null
  created_at: number
  updated_at: number
}

type RequestRow = {
  sender_pubkey: string
  request_id: string
  rumor_id: string
  decision: 'approved' | 'rejected' | null
  decision_generation: number | null
  created_at: number
  decided_at: number | null
}

const HEX_64 = /^[0-9a-f]{64}$/

function assertPubkey(pubkey: string): void {
  if (!HEX_64.test(pubkey)) throw new Error('contacts: pubkey must be 64 lowercase hex characters')
}

function toContact(row: ContactRow): Contact {
  return {
    pubkey: row.pubkey,
    direction: row.direction,
    state: row.state,
    generation: row.generation,
    maxGenerationSeen: row.max_generation_seen,
    requestId: row.request_id,
    requestRumorId: row.request_rumor_id,
    localName: row.local_name,
    declaredName: row.declared_name,
    note: row.note,
    relays: JSON.parse(row.relays) as string[],
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const selectRow = (store: Store, pubkey: string, direction: Direction) =>
  store.db.prepare('SELECT * FROM contacts WHERE pubkey = ? AND direction = ?').get(pubkey, direction) as ContactRow | undefined

const selectRequest = (store: Store, sender: string, requestId: string) =>
  store.db.prepare('SELECT * FROM requests WHERE sender_pubkey = ? AND request_id = ?').get(sender, requestId) as RequestRow | undefined

function decideRequest(store: Store, sender: string, requestId: string, decision: 'approved' | 'rejected', generation: number | null, now: number): void {
  store.db
    .prepare('UPDATE requests SET decision = ?, decision_generation = ?, decided_at = ? WHERE sender_pubkey = ? AND request_id = ?')
    .run(decision, generation, now, sender, requestId)
}

export function getContact(store: Store, pubkey: string, direction: Direction): Contact | null {
  const row = selectRow(store, pubkey, direction)
  return row ? toContact(row) : null
}

export function findContactByLocalName(store: Store, direction: Direction, localName: string): Contact | null {
  const row = store.db.prepare('SELECT * FROM contacts WHERE direction = ? AND local_name = ?').get(direction, localName) as ContactRow | undefined
  return row ? toContact(row) : null
}

export function listContacts(store: Store, direction: Direction): Contact[] {
  return (store.db.prepare('SELECT * FROM contacts WHERE direction = ? ORDER BY local_name, created_at').all(direction) as ContactRow[]).map(toContact)
}

export function listPendingRequests(store: Store): Contact[] {
  return (
    store.db.prepare("SELECT * FROM contacts WHERE direction = 'inbound' AND state = 'requested' ORDER BY requested_at, rowid").all() as ContactRow[]
  ).map(toContact)
}

export function findRequestsByPrefix(store: Store, prefix: string, states: readonly ContactState[] = ['requested']): Contact[] {
  const normalized = prefix.trim().toLowerCase()
  if (!/^[0-9a-f]{8,64}$/.test(normalized)) {
    throw new UserFacingError('El identificador debe tener al menos 8 caracteres hexadecimales, tal como aparece en la lista de solicitudes.')
  }
  const placeholders = states.map(() => '?').join(', ')
  return (
    store.db
      .prepare(`SELECT * FROM contacts WHERE direction = 'inbound' AND state IN (${placeholders}) AND pubkey LIKE ? ORDER BY requested_at`)
      .all(...states, `${normalized}%`) as ContactRow[]
  ).map(toContact)
}

export function slugifyName(input: string): string {
  const base = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 24)
    .replace(/-+$/, '')
  return HandleSchema.safeParse(base).success ? base : 'contacto'
}

function uniqueLocalName(store: Store, direction: Direction, declared: string): string {
  const base = slugifyName(declared)
  for (let i = 1; i < 10_000; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`
    if (!findContactByLocalName(store, direction, candidate)) return candidate
  }
  throw new Error('contacts: could not allocate a local name')
}

// A person who was ever approved keeps their contact row forever (generation counter, max observed
// generation): only the visible pending request goes away. Request records are left alone.
function dropRequest(store: Store, pubkey: string, now: number): void {
  const row = selectRow(store, pubkey, 'inbound')
  if (!row) return
  if (row.generation > 0) {
    store.db
      .prepare(
        "UPDATE contacts SET state = 'revoked', request_id = NULL, request_rumor_id = NULL, note = NULL, requested_at = NULL, updated_at = ? WHERE pubkey = ? AND direction = 'inbound'",
      )
      .run(now, pubkey)
  } else {
    store.db.prepare("DELETE FROM contacts WHERE pubkey = ? AND direction = 'inbound'").run(pubkey)
  }
}

function makeRoom(store: Store, now: number): string | null {
  const count = store.db.prepare("SELECT count(*) AS n FROM contacts WHERE direction = 'inbound' AND state = 'requested'").get()?.n as number
  if (count < NOSTR.maxPendingRequests) return null
  const oldest = store.db
    .prepare("SELECT pubkey FROM contacts WHERE direction = 'inbound' AND state = 'requested' ORDER BY requested_at, rowid LIMIT 1")
    .get() as { pubkey: string }
  dropRequest(store, oldest.pubkey, now)
  return oldest.pubkey
}

export function recordIncomingRequest(store: Store, input: IncomingRequest): IncomingRequestOutcome {
  assertPubkey(input.pubkey)
  const declaredName = input.declaredName.trim().slice(0, 80)
  const note = input.note.slice(0, 500)
  return store.tx((): IncomingRequestOutcome => {
    const row = selectRow(store, input.pubkey, 'inbound')
    const record = selectRequest(store, input.pubkey, input.requestId)

    if (record) {
      if (record.rumor_id !== input.requestRumorId) return { kind: 'conflict' }
      if (record.decision === 'rejected') return row ? { kind: 'rejected_already', contact: toContact(row) } : { kind: 'ignored_stale' }
      if (record.decision === 'approved') {
        return row?.state === 'approved' && row.generation === record.decision_generation
          ? { kind: 'approved_already', contact: toContact(row) }
          : { kind: 'ignored_stale' }
      }
      return row?.state === 'requested' && row.request_id === input.requestId ? { kind: 'duplicate' } : { kind: 'ignored_stale' }
    }

    if (row?.state === 'approved') {
      // The asker lost track of a permission it already has. Record this request as approved with the
      // current generation, so its retries repeat the same answer.
      store.db
        .prepare(
          "INSERT INTO requests (sender_pubkey, request_id, rumor_id, decision, decision_generation, created_at, decided_at) VALUES (?, ?, ?, 'approved', ?, ?, ?)",
        )
        .run(input.pubkey, input.requestId, input.requestRumorId, row.generation, input.now, input.now)
      return { kind: 'approved_already', contact: toContact(row) }
    }
    if (row?.state === 'rejected' && row.decided_at !== null && input.now - row.decided_at < NOSTR.rejectedRequestCooldownSeconds) {
      return { kind: 'ignored_recently_rejected' }
    }

    store.db
      .prepare('INSERT INTO requests (sender_pubkey, request_id, rumor_id, created_at) VALUES (?, ?, ?, ?)')
      .run(input.pubkey, input.requestId, input.requestRumorId, input.now)
    const relays = JSON.stringify(store.relayPolicy(input.relays))
    const evictedPubkey = row?.state === 'requested' ? null : makeRoom(store, input.now)
    if (row) {
      store.db
        .prepare(
          "UPDATE contacts SET state = 'requested', request_id = ?, request_rumor_id = ?, declared_name = ?, note = ?, relays = ?, requested_at = ?, decided_at = NULL, updated_at = ? WHERE pubkey = ? AND direction = 'inbound'",
        )
        .run(input.requestId, input.requestRumorId, declaredName, note, relays, input.now, input.now, input.pubkey)
    } else {
      store.db
        .prepare(
          "INSERT INTO contacts (pubkey, direction, state, request_id, request_rumor_id, declared_name, note, relays, requested_at, created_at, updated_at) VALUES (?, 'inbound', 'requested', ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(input.pubkey, input.requestId, input.requestRumorId, declaredName, note, relays, input.now, input.now, input.now)
    }
    return { kind: 'stored', evictedPubkey }
  })
}

export function approveRequest(store: Store, input: { pubkey: string; now: number }): { contact: Contact; changed: boolean } {
  return store.tx(() => {
    const row = selectRow(store, input.pubkey, 'inbound')
    if (row?.state === 'approved') return { contact: toContact(row), changed: false }
    if (row?.state !== 'requested' || row.request_id === null) throw new UserFacingError('No hay una solicitud pendiente de esa persona.')
    const generation = row.generation + 1
    const localName = row.local_name ?? uniqueLocalName(store, 'inbound', row.declared_name ?? '')
    store.db
      .prepare(
        "UPDATE contacts SET state = 'approved', generation = ?, max_generation_seen = ?, local_name = ?, decided_at = ?, updated_at = ? WHERE pubkey = ? AND direction = 'inbound'",
      )
      .run(generation, generation, localName, input.now, input.now, input.pubkey)
    decideRequest(store, input.pubkey, row.request_id, 'approved', generation, input.now)
    return { contact: toContact(selectRow(store, input.pubkey, 'inbound')!), changed: true }
  })
}

export function rejectRequest(store: Store, input: { pubkey: string; now: number }): { contact: Contact; changed: boolean } {
  return store.tx(() => {
    const row = selectRow(store, input.pubkey, 'inbound')
    if (row?.state === 'rejected') return { contact: toContact(row), changed: false }
    if (row?.state !== 'requested' || row.request_id === null) throw new UserFacingError('No hay una solicitud pendiente de esa persona.')
    store.db
      .prepare("UPDATE contacts SET state = 'rejected', decided_at = ?, updated_at = ? WHERE pubkey = ? AND direction = 'inbound'")
      .run(input.now, input.now, input.pubkey)
    decideRequest(store, input.pubkey, row.request_id, 'rejected', null, input.now)
    return { contact: toContact(selectRow(store, input.pubkey, 'inbound')!), changed: true }
  })
}

export function revokeInbound(store: Store, input: { pubkey: string; now: number }): { contact: Contact; changed: boolean } {
  return store.tx(() => {
    const row = selectRow(store, input.pubkey, 'inbound')
    if (row?.state === 'revoked') return { contact: toContact(row), changed: false }
    if (row?.state !== 'approved') throw new UserFacingError('Esa persona no tiene permiso para preguntarte.')
    const generation = row.generation + 1
    store.db
      .prepare(
        "UPDATE contacts SET state = 'revoked', generation = ?, max_generation_seen = ?, decided_at = ?, updated_at = ? WHERE pubkey = ? AND direction = 'inbound'",
      )
      .run(generation, generation, input.now, input.now, input.pubkey)
    return { contact: toContact(selectRow(store, input.pubkey, 'inbound')!), changed: true }
  })
}

export function purgeRequests(store: Store, now: number): { droppedPending: number; forgottenRecords: number } {
  return store.tx(() => {
    const stale = store.db
      .prepare("SELECT pubkey FROM contacts WHERE direction = 'inbound' AND state = 'requested' AND requested_at <= ?")
      .all(now - NOSTR.requestMaxAgeSeconds) as Array<{ pubkey: string }>
    for (const { pubkey } of stale) dropRequest(store, pubkey, now)
    const forgotten = store.db
      .prepare('DELETE FROM requests WHERE coalesce(decided_at, created_at) <= ?')
      .run(now - NOSTR.decisionRetentionSeconds)
    return { droppedPending: stale.length, forgottenRecords: Number(forgotten.changes) }
  })
}

export function isQuestionAllowed(store: Store, pubkey: string, generation: number): boolean {
  const row = selectRow(store, pubkey, 'inbound')
  return row?.state === 'approved' && row.generation === generation
}

export function createOutboundRequest(
  store: Store,
  input: { pubkey: string; requestId: string; relays: readonly unknown[]; now: number },
): { contact: Contact; created: boolean } {
  assertPubkey(input.pubkey)
  return store.tx(() => {
    const row = selectRow(store, input.pubkey, 'outbound')
    // A pending request that has sat unanswered for a full retry window is treated like a
    // rejected/revoked one: it is replaced with a fresh request id rather than left to block the
    // asker forever. Its generation counters are preserved by the UPDATE below, which never
    // touches those columns.
    const stalePending = row?.state === 'pending' && row.requested_at !== null && input.now - row.requested_at >= NOSTR.retryWindowSeconds
    if (row?.state === 'pending' && !stalePending) return { contact: toContact(row), created: false }
    if (row?.state === 'approved') throw new UserFacingError('Ya tienes permiso para preguntarle a esa persona.')
    const relays = store.relayPolicy(input.relays)
    if (relays.length === 0) {
      throw new UserFacingError('Ese enlace no trae ningún tablero válido, así que no hay dónde dejar tu solicitud.')
    }
    if (row) {
      store.db
        .prepare(
          "UPDATE contacts SET state = 'pending', request_id = ?, relays = ?, requested_at = ?, decided_at = NULL, updated_at = ? WHERE pubkey = ? AND direction = 'outbound'",
        )
        .run(input.requestId, JSON.stringify(relays), input.now, input.now, input.pubkey)
    } else {
      store.db
        .prepare(
          "INSERT INTO contacts (pubkey, direction, state, request_id, relays, requested_at, created_at, updated_at) VALUES (?, 'outbound', 'pending', ?, ?, ?, ?, ?)",
        )
        .run(input.pubkey, input.requestId, JSON.stringify(relays), input.now, input.now, input.now)
    }
    return { contact: toContact(selectRow(store, input.pubkey, 'outbound')!), created: true }
  })
}

export function applyApproval(
  store: Store,
  input: { pubkey: string; requestId: string; generation: number; name: string; relays: readonly unknown[]; now: number },
): 'applied' | 'ignored' {
  return store.tx(() => {
    const row = selectRow(store, input.pubkey, 'outbound')
    if (!row || row.state !== 'pending' || row.request_id !== input.requestId || input.generation <= row.max_generation_seen) return 'ignored'
    const sanitized = store.relayPolicy(input.relays)
    const relays = sanitized.length > 0 ? JSON.stringify(sanitized) : row.relays
    const declared = input.name.trim().slice(0, 80)
    const localName = row.local_name ?? uniqueLocalName(store, 'outbound', declared)
    store.db
      .prepare(
        "UPDATE contacts SET state = 'approved', generation = ?, max_generation_seen = ?, declared_name = ?, local_name = ?, relays = ?, decided_at = ?, updated_at = ? WHERE pubkey = ? AND direction = 'outbound'",
      )
      .run(input.generation, input.generation, declared, localName, relays, input.now, input.now, input.pubkey)
    return 'applied'
  })
}

export function applyRejection(store: Store, input: { pubkey: string; requestId: string; now: number }): 'applied' | 'ignored' {
  return store.tx(() => {
    const row = selectRow(store, input.pubkey, 'outbound')
    if (row?.state !== 'pending' || row.request_id !== input.requestId) return 'ignored'
    store.db
      .prepare("UPDATE contacts SET state = 'rejected', decided_at = ?, updated_at = ? WHERE pubkey = ? AND direction = 'outbound'")
      .run(input.now, input.now, input.pubkey)
    return 'applied'
  })
}

// A newer revocation always raises the max observed generation. A request that is still pending
// stays pending: the revocation is about an older permission, and the pending request may still be
// approved with a higher generation.
export function applyRevocation(store: Store, input: { pubkey: string; generation: number; now: number }): 'applied' | 'ignored' {
  return store.tx(() => {
    const row = selectRow(store, input.pubkey, 'outbound')
    if (!row || input.generation <= row.max_generation_seen) return 'ignored'
    store.db
      .prepare(
        "UPDATE contacts SET state = CASE WHEN state = 'pending' THEN 'pending' ELSE 'revoked' END, max_generation_seen = ?, decided_at = ?, updated_at = ? WHERE pubkey = ? AND direction = 'outbound'",
      )
      .run(input.generation, input.now, input.now, input.pubkey)
    return 'applied'
  })
}

export function askPermission(store: Store, pubkey: string): { generation: number } | null {
  const row = selectRow(store, pubkey, 'outbound')
  return row?.state === 'approved' ? { generation: row.generation } : null
}
