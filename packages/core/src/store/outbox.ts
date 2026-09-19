import { NOSTR } from '../nostr-constants'
import type { Store } from './db'

export type OutboxPolicy = 'once' | 'retry_until_resolved'
export type OutboxRumor = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }

export type EnqueueInput = {
  recipient: string
  rumor: OutboxRumor
  label: string
  powBits: 16 | 22
  relays: readonly string[]
  policy: OutboxPolicy
  now: number
}

export type EnqueueOutcome = 'enqueued' | 'postponed_cap' | 'already_pending' | 'regenerated' | 'regeneration_too_soon' | 'abandoned'

export type OutboxItem = {
  recipient: string
  rumorId: string
  rumor: OutboxRumor
  label: string
  powBits: 16 | 22
  relays: string[]
  policy: OutboxPolicy
  attempts: number
  firstEnqueuedAt: number
}

type ClaimRef = { recipient: string; rumorId: string; owner: string }

type OutboxRow = {
  recipient: string
  rumor_id: string
  rumor_json: string
  label: string
  pow_bits: 16 | 22
  relays: string
  bytes: number
  policy: OutboxPolicy
  state: 'pending' | 'published' | 'abandoned'
  attempts: number
  first_enqueued_at: number
  next_attempt_at: number
  last_generated_at: number
  last_published_at: number | null
  claimed_by: string | null
  claimed_until: number | null
  updated_at: number
}

type OutboxCandidate = OutboxRow & { rowid: number }

const HEX_64 = /^[0-9a-f]{64}$/

const selectRow = (store: Store, recipient: string, rumorId: string) =>
  store.db.prepare('SELECT * FROM outbox WHERE recipient = ? AND rumor_id = ?').get(recipient, rumorId) as OutboxRow | undefined

const toItem = (row: OutboxRow): OutboxItem => ({
  recipient: row.recipient,
  rumorId: row.rumor_id,
  rumor: JSON.parse(row.rumor_json) as OutboxRumor,
  label: row.label,
  powBits: row.pow_bits,
  relays: JSON.parse(row.relays) as string[],
  policy: row.policy,
  attempts: row.attempts,
  firstEnqueuedAt: row.first_enqueued_at,
})

export function enqueue(store: Store, input: EnqueueInput): EnqueueOutcome {
  if (!HEX_64.test(input.recipient) || !HEX_64.test(input.rumor.id)) {
    throw new Error('outbox: recipient and rumor id must be 64 lowercase hex characters')
  }
  if (input.relays.length === 0 || input.relays.length > NOSTR.maxRelaysPerContact) {
    throw new Error('outbox: between 1 and 5 relays are required')
  }
  return store.tx((): EnqueueOutcome => {
    const row = selectRow(store, input.recipient, input.rumor.id)
    if (row) {
      if (row.state === 'pending') return 'already_pending'
      if (row.state === 'abandoned') return 'abandoned'
      if (input.now - row.last_generated_at < NOSTR.regenerationIntervalSeconds) return 'regeneration_too_soon'
      store.db
        .prepare(
          "UPDATE outbox SET state = 'pending', relays = ?, next_attempt_at = ?, last_generated_at = ?, updated_at = ? WHERE recipient = ? AND rumor_id = ?",
        )
        .run(JSON.stringify(input.relays), input.now, input.now, input.now, input.recipient, input.rumor.id)
      return 'regenerated'
    }
    const rumorJson = JSON.stringify(input.rumor)
    const bytes = Buffer.byteLength(rumorJson)
    const pendingForRecipient = Number(
      store.db.prepare("SELECT coalesce(sum(bytes), 0) AS b FROM outbox WHERE recipient = ? AND state = 'pending'").get(input.recipient)?.b ?? 0,
    )
    const pendingForIdentity = Number(store.db.prepare("SELECT coalesce(sum(bytes), 0) AS b FROM outbox WHERE state = 'pending'").get()?.b ?? 0)
    const overCap =
      pendingForRecipient + bytes > NOSTR.maxPendingBytesPerRecipient || pendingForIdentity + bytes > NOSTR.maxPendingBytesPerIdentity
    store.db
      .prepare(
        `INSERT INTO outbox (recipient, rumor_id, rumor_json, label, pow_bits, relays, bytes, policy, state, attempts,
           first_enqueued_at, next_attempt_at, last_generated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
      )
      .run(
        input.recipient,
        input.rumor.id,
        rumorJson,
        input.label,
        input.powBits,
        JSON.stringify(input.relays),
        bytes,
        input.policy,
        input.now,
        overCap ? input.now + NOSTR.capPostponeSeconds : input.now,
        input.now,
        input.now,
      )
    return overCap ? 'postponed_cap' : 'enqueued'
  })
}

export function claimDue(
  store: Store,
  input: {
    owner: string
    now: number
    limit: number
    authorize: (item: OutboxItem) => boolean
    onAbandon?: (row: { recipient: string; rumorId: string; label: string }, err: unknown) => void
  },
): OutboxItem[] {
  return store.tx(() => {
    store.db
      .prepare(
        `UPDATE outbox SET state = 'abandoned', claimed_by = NULL, claimed_until = NULL, updated_at = ?
         WHERE state = 'pending'
           AND ((policy = 'retry_until_resolved' AND first_enqueued_at <= ?) OR (policy = 'once' AND first_enqueued_at <= ?))`,
      )
      .run(input.now, input.now - NOSTR.retryWindowSeconds, input.now - NOSTR.decisionRetentionSeconds)
    const rows = store.db
      .prepare(
        `SELECT rowid, * FROM outbox WHERE state = 'pending' AND next_attempt_at <= ? AND (claimed_until IS NULL OR claimed_until <= ?)
         ORDER BY next_attempt_at, rowid LIMIT ?`,
      )
      .all(input.now, input.now, input.limit) as OutboxCandidate[]
    const abandon = store.db.prepare(
      "UPDATE outbox SET state = 'abandoned', claimed_by = NULL, claimed_until = NULL, updated_at = ? WHERE recipient = ? AND rumor_id = ?",
    )
    const claim = store.db.prepare('UPDATE outbox SET claimed_by = ?, claimed_until = ?, updated_at = ? WHERE recipient = ? AND rumor_id = ?')
    const postponeForCap = store.db.prepare('UPDATE outbox SET next_attempt_at = ?, updated_at = ? WHERE recipient = ? AND rumor_id = ?')
    // Bytes of pending rows that arrived (by first_enqueued_at, then rowid) strictly before this
    // candidate, scoped to its recipient or to the whole identity. The candidate's own bytes are
    // never counted here, so the oldest pending row of a scope always has zero "older" rows and
    // therefore always passes — a single oversized row can never deadlock the queue.
    const olderPendingForRecipient = store.db.prepare(
      `SELECT count(*) AS n, coalesce(sum(bytes), 0) AS b FROM outbox
         WHERE state = 'pending' AND recipient = ?
           AND (first_enqueued_at < ? OR (first_enqueued_at = ? AND rowid < ?))`,
    )
    const olderPendingForIdentity = store.db.prepare(
      `SELECT count(*) AS n, coalesce(sum(bytes), 0) AS b FROM outbox
         WHERE state = 'pending'
           AND (first_enqueued_at < ? OR (first_enqueued_at = ? AND rowid < ?))`,
    )
    const granted: OutboxItem[] = []
    for (const row of rows) {
      const recipientOlder = olderPendingForRecipient.get(row.recipient, row.first_enqueued_at, row.first_enqueued_at, row.rowid) as {
        n: number
        b: number
      }
      const identityOlder = olderPendingForIdentity.get(row.first_enqueued_at, row.first_enqueued_at, row.rowid) as { n: number; b: number }
      const overRecipientCap = Number(recipientOlder.n) > 0 && Number(recipientOlder.b) + row.bytes > NOSTR.maxPendingBytesPerRecipient
      const overIdentityCap = Number(identityOlder.n) > 0 && Number(identityOlder.b) + row.bytes > NOSTR.maxPendingBytesPerIdentity
      if (overRecipientCap || overIdentityCap) {
        postponeForCap.run(input.now + NOSTR.capPostponeSeconds, input.now, row.recipient, row.rumor_id)
        continue
      }
      // A row whose content cannot be read back, or whose authorization throws, is abandoned on its
      // own. Letting the throw escape rolled back the whole claim, so one bad row blocked every
      // later claimDue for good.
      let item: OutboxItem
      let allowed: boolean
      try {
        item = toItem(row)
        allowed = input.authorize(item)
      } catch (err) {
        abandon.run(input.now, row.recipient, row.rumor_id)
        try {
          // A throwing onAbandon must never roll back this row's abandonment or the rows after it.
          input.onAbandon?.({ recipient: row.recipient, rumorId: row.rumor_id, label: row.label }, err)
        } catch {
          // ignored: reporting the abandonment must never itself fail the claim
        }
        continue
      }
      if (!allowed) {
        abandon.run(input.now, row.recipient, row.rumor_id)
        continue
      }
      claim.run(input.owner, input.now + NOSTR.claimSeconds, input.now, row.recipient, row.rumor_id)
      granted.push(item)
    }
    return granted
  })
}

// Whether a claim could still find work: a pending row that is due and not claimed by anyone right now.
export function hasDueOutbox(store: Store, now: number): boolean {
  return (
    store.db
      .prepare("SELECT 1 FROM outbox WHERE state = 'pending' AND next_attempt_at <= ? AND (claimed_until IS NULL OR claimed_until <= ?) LIMIT 1")
      .get(now, now) !== undefined
  )
}

export function stillClaimed(store: Store, input: ClaimRef & { now: number }): boolean {
  const row = selectRow(store, input.recipient, input.rumorId)
  return row?.state === 'pending' && row.claimed_by === input.owner && (row.claimed_until ?? 0) > input.now
}

// Extends a claim by a full claim period. The publisher calls it after mining, which can take longer
// than the claim itself on slow machines. `claimed_by` still naming the caller proves nobody else
// claimed the row meanwhile, because claimDue overwrites it — so a lapsed claim can be renewed.
export function renewClaim(store: Store, input: ClaimRef & { now: number }): 'ok' | 'claim_lost' {
  return store.tx(() => {
    const row = selectRow(store, input.recipient, input.rumorId)
    if (row?.state !== 'pending' || row.claimed_by !== input.owner) return 'claim_lost'
    store.db
      .prepare('UPDATE outbox SET claimed_until = ?, updated_at = ? WHERE recipient = ? AND rumor_id = ?')
      .run(input.now + NOSTR.claimSeconds, input.now, input.recipient, input.rumorId)
    return 'ok'
  })
}

export function reservePublish(store: Store, input: ClaimRef & { now: number }): 'reserved' | 'claim_lost' | 'over_budget' {
  return store.tx(() => {
    if (!stillClaimed(store, input)) return 'claim_lost'
    store.db.prepare('DELETE FROM publish_log WHERE at <= ?').run(input.now - 60)
    const used = Number(store.db.prepare('SELECT count(*) AS n FROM publish_log').get()?.n ?? 0)
    if (used >= NOSTR.maxPublishesPerMinute) return 'over_budget'
    store.db.prepare('INSERT INTO publish_log (at) VALUES (?)').run(input.now)
    return 'reserved'
  })
}

export function postpone(store: Store, input: ClaimRef & { retryAt: number }): 'ok' | 'claim_lost' {
  return store.tx(() => {
    const row = selectRow(store, input.recipient, input.rumorId)
    if (!row || row.state !== 'pending' || row.claimed_by !== input.owner) return 'claim_lost'
    store.db
      .prepare('UPDATE outbox SET next_attempt_at = ?, claimed_by = NULL, claimed_until = NULL WHERE recipient = ? AND rumor_id = ?')
      .run(input.retryAt, input.recipient, input.rumorId)
    return 'ok'
  })
}

function finish(
  store: Store,
  input: ClaimRef & { now: number },
  decide: (row: OutboxRow, attempts: number) => { state: OutboxRow['state']; nextAttemptAt: number; published: boolean },
): 'ok' | 'claim_lost' {
  return store.tx(() => {
    const row = selectRow(store, input.recipient, input.rumorId)
    if (!row || row.state !== 'pending' || row.claimed_by !== input.owner) return 'claim_lost'
    const attempts = row.attempts + 1
    const next = decide(row, attempts)
    store.db
      .prepare(
        `UPDATE outbox SET state = ?, attempts = ?, next_attempt_at = ?, last_published_at = CASE WHEN ? THEN ? ELSE last_published_at END,
           claimed_by = NULL, claimed_until = NULL, updated_at = ? WHERE recipient = ? AND rumor_id = ?`,
      )
      .run(next.state, attempts, next.nextAttemptAt, next.published ? 1 : 0, input.now, input.now, input.recipient, input.rumorId)
    return 'ok'
  })
}

export function markPublished(store: Store, input: ClaimRef & { now: number }): 'ok' | 'claim_lost' {
  return finish(store, input, (row) => {
    if (row.policy === 'once') return { state: 'published', nextAttemptAt: row.next_attempt_at, published: true }
    const age = input.now - row.first_enqueued_at
    if (age >= NOSTR.retryWindowSeconds) return { state: 'abandoned', nextAttemptAt: row.next_attempt_at, published: true }
    const interval = age < 3_600 ? NOSTR.retryFirstHourIntervalSeconds : NOSTR.retryAfterFirstHourIntervalSeconds
    return { state: 'pending', nextAttemptAt: input.now + interval, published: true }
  })
}

export function markFailed(store: Store, input: ClaimRef & { now: number }): 'ok' | 'claim_lost' {
  return finish(store, input, (row, attempts) => {
    const age = input.now - row.first_enqueued_at
    const limit = row.policy === 'once' ? NOSTR.decisionRetentionSeconds : NOSTR.retryWindowSeconds
    if (age >= limit) return { state: 'abandoned', nextAttemptAt: row.next_attempt_at, published: false }
    const delay = Math.min(NOSTR.retryAfterFirstHourIntervalSeconds, 30 * 2 ** (attempts - 1))
    return { state: 'pending', nextAttemptAt: input.now + delay, published: false }
  })
}

export function resolveOutboxMessage(store: Store, input: { recipient: string; rumorId: string }): boolean {
  const result = store.tx(() => store.db.prepare('DELETE FROM outbox WHERE recipient = ? AND rumor_id = ?').run(input.recipient, input.rumorId))
  return Number(result.changes) > 0
}

// Deletes every currently-unclaimed row for a recipient whose label is in scope; a row that is
// claimed right now is left alone regardless of its label — a claim already in flight is never
// abandoned by a caller elsewhere in the process. `labels` has no "everything" default and must be
// given explicitly by every caller (an empty array deletes nothing): the outbox is one shared table
// per recipient across every kind of message this identity ever sends them, so a caller that means
// only its own side of a relationship (e.g. a responder-side revocation cleaning up its own
// decisions/receipts/answers to that pubkey) must say exactly that, rather than risk sweeping away
// outbox rows that belong to a different relationship direction between the same two identities
// (see revokeConnection, and P11 in the 0.2 plan). An entry ending in ':' matches every label that
// starts with it — 'rejected:' matches 'rejected:expired', 'rejected:limit', ... — because that one
// label family carries a dynamic reason suffix (see decisionLabel in store/inbox.ts).
export function deleteUnclaimedFor(store: Store, input: { recipient: string; labels: readonly string[]; now: number }): number {
  if (input.labels.length === 0) return 0
  const exact = input.labels.filter((label) => !label.endsWith(':'))
  const prefixes = input.labels.filter((label) => label.endsWith(':'))
  const clauses: string[] = []
  const labelParams: string[] = []
  if (exact.length > 0) {
    clauses.push(`label IN (${exact.map(() => '?').join(', ')})`)
    labelParams.push(...exact)
  }
  for (const prefix of prefixes) {
    clauses.push('label LIKE ?')
    labelParams.push(`${prefix}%`)
  }
  const result = store.tx(() =>
    store.db
      .prepare(
        `DELETE FROM outbox WHERE recipient = ? AND (${clauses.join(' OR ')}) AND NOT (state = 'pending' AND claimed_until IS NOT NULL AND claimed_until > ?)`,
      )
      .run(input.recipient, ...labelParams, input.now),
  )
  return Number(result.changes)
}

// Rows carry full question and answer text, so they follow the 7-day content retention by the
// rumor's own creation date — pending, published or abandoned alike.
// Keyed to the rumor's own created_at, not to when this row was (re)armed: a regenerated decision
// resends the original stored rumor unchanged (see resend() in store/inbox.ts and
// regenerateRequestDecision in responder/connections.ts), so its outbox row can be older than 7 days
// the moment it is inserted. If that regeneration happens between day 7 and day 9 of the original
// question (still within the 9-day forgetting window), the hourly purge run right after it can delete
// the row before the publisher (which runs roughly every few seconds) gets to it. Nothing is lost: the
// next retry from the asker re-enqueues the same stored rumor the same way.
export function purgeOutbox(store: Store, now: number): number {
  return store.tx(() => {
    store.db.prepare('DELETE FROM publish_log WHERE at <= ?').run(now - 60)
    const result = store.db
      .prepare("DELETE FROM outbox WHERE json_extract(rumor_json, '$.created_at') <= ?")
      .run(now - NOSTR.contentRetentionSeconds)
    return Number(result.changes)
  })
}
