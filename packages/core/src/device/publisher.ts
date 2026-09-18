import { randomUUID } from 'node:crypto'
import type { NostrEvent } from 'nostr-tools/pure'
import type { BoardPool } from '../boards/pool'
import { sanitizeRelayText } from '../boards/relay-text'
import { wrapRumor } from '../envelope/seal'
import { describeError } from '../errors'
import type { Identity } from '../identity'
import { nowSeconds } from '../nostr-constants'
import type { Store } from '../store/db'
import {
  claimDue,
  hasDueOutbox,
  markFailed,
  markPublished,
  postpone,
  renewClaim,
  reservePublish,
  stillClaimed,
  type OutboxItem,
} from '../store/outbox'
import { authorizeOutboxItem } from './authorize'

export type PublishReport = { published: number; failed: number; postponed: number; lost: number }

export type PublishDueInput = {
  store: Store
  identity: Identity
  pool: BoardPool
  authorize?: (store: Store, item: OutboxItem) => boolean
  now?: () => number
  signal?: AbortSignal
  limit?: number
  log?: (line: string) => void
}

const BUDGET_POSTPONE_SECONDS = 60

// One row per claim, each with a fresh owner id, so a stale attempt can never pass the checks of a
// later claim. The wrap is mined before publishing and the claim renewed afterwards, because mining
// can outlast the 2-minute claim on a slow machine.
export async function publishDue(input: PublishDueInput): Promise<PublishReport> {
  const now = input.now ?? nowSeconds
  const authorize = input.authorize ?? authorizeOutboxItem
  const log = input.log ?? (() => {})
  const report: PublishReport = { published: 0, failed: 0, postponed: 0, lost: 0 }
  const limit = input.limit ?? 20

  for (let round = 0; round < limit && !input.signal?.aborted; round++) {
    const owner = randomUUID()
    const [item] = claimDue(input.store, {
      owner,
      now: now(),
      limit: 1,
      authorize: (candidate) => authorize(input.store, candidate),
      onAbandon: (row, err) => {
        log(`outbox row abandoned after an unexpected error (${row.label}, ${describeError(err)})`)
      },
    })
    if (!item) {
      // An empty claim may only mean that the first candidate was abandoned or postponed.
      if (hasDueOutbox(input.store, now())) continue
      break
    }
    const ref = { recipient: item.recipient, rumorId: item.rumorId, owner }

    let wrap: NostrEvent
    try {
      wrap = await wrapRumor(item.rumor, input.identity, item.recipient, { now: now(), signal: input.signal })
    } catch (err) {
      if (input.signal?.aborted) {
        postpone(input.store, { ...ref, retryAt: now() })
        report.postponed++
        break
      }
      log(`could not seal an outgoing ${item.label} (${describeError(err)})`)
      markFailed(input.store, { ...ref, now: now() })
      report.failed++
      continue
    }
    if (renewClaim(input.store, { ...ref, now: now() }) !== 'ok') {
      report.lost++
      continue
    }

    // Runs right before each EVENT write: up to 5 relays, each possibly twice after an auth retry.
    // The per-minute reservation is taken on the first write only; later writes only re-check the
    // claim. Anything thrown here (SQLITE_BUSY included) refuses the write. A later recheck can find
    // the claim gone even though the first reservation succeeded (it lapsed, or another owner took
    // it), which must count as lost rather than failed even though `reservation` itself stays
    // 'reserved'.
    const guard: { reservation: 'reserved' | 'claim_lost' | 'over_budget' | null; lostMidSend: boolean } = {
      reservation: null,
      lostMidSend: false,
    }
    const beforeSend = (): boolean => {
      if (input.signal?.aborted) return false
      try {
        const at = now()
        if (guard.reservation === null) {
          guard.reservation = reservePublish(input.store, { ...ref, now: at })
          return guard.reservation === 'reserved'
        }
        if (guard.reservation !== 'reserved') return false
        if (stillClaimed(input.store, { ...ref, now: at })) return true
        guard.lostMidSend = true
        return false
      } catch {
        return false
      }
    }

    const outcome = await input.pool.publish(item.relays, wrap, beforeSend)
    // A row's own finish call (markPublished/markFailed/postpone) always has the last word on
    // whether the claim was actually still ours: a claim stolen between the last accepted write and
    // this bookkeeping must count as lost, not as published or failed, or the row would stay
    // 'pending' under a new owner while being reported as done.
    if (outcome.accepted.length > 0) {
      if (markPublished(input.store, { ...ref, now: now() }) === 'claim_lost') report.lost++
      else report.published++
    } else if (guard.reservation === 'over_budget') {
      if (postpone(input.store, { ...ref, retryAt: now() + BUDGET_POSTPONE_SECONDS }) === 'claim_lost') report.lost++
      else report.postponed++
      break
    } else if (guard.reservation === 'claim_lost' || guard.lostMidSend) {
      report.lost++
    } else if (input.signal?.aborted) {
      if (postpone(input.store, { ...ref, retryAt: now() }) === 'claim_lost') report.lost++
      else report.postponed++
      break
    } else {
      for (const rejected of outcome.rejected) {
        log(`${sanitizeRelayText(rejected.relay)} did not take an outgoing ${item.label}: ${sanitizeRelayText(rejected.reason)}`)
      }
      if (markFailed(input.store, { ...ref, now: now() }) === 'claim_lost') report.lost++
      else report.failed++
    }
  }
  return report
}
