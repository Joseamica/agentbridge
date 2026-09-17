import { NOSTR } from '../nostr-constants'
import { historyWindows, markWindowComplete, type CursorRole, type HistoryWindow } from '../store/cursors'
import type { Store } from '../store/db'
import type { BoardPool } from './pool'

export type HistoryResult = { windows: number; completed: number; pendingRecent: number; incomplete: number; events: number }

export type RecoverHistoryInput = {
  pool: BoardPool
  store: Store
  relay: string
  role: CursorRole
  recipientPubkey: string
  now: number
  handle(raw: unknown): Promise<void>
  queryTimeoutMs?: number
}

type Dated = { id: string; created_at: number }
const isDated = (raw: unknown): raw is Dated =>
  typeof (raw as Dated | null)?.id === 'string' && Number.isInteger((raw as Dated | null)?.created_at)

export async function recoverHistory(input: RecoverHistoryInput): Promise<HistoryResult> {
  const windows = historyWindows(input.store, { relay: input.relay, role: input.role, now: input.now })
  const result: HistoryResult = { windows: windows.length, completed: 0, pendingRecent: 0, incomplete: 0, events: 0 }
  const relayStats = { largestPage: 0 }
  for (const window of windows) {
    const readStartedAt = input.now
    if (!(await readWindow(input, window, result, relayStats))) {
      result.incomplete++
      continue
    }
    const marked = markWindowComplete(input.store, { relay: input.relay, role: input.role, since: window.since, readStartedAt, now: input.now })
    if (marked) result.completed++
    else result.pendingRecent++
  }
  return result
}

async function readWindow(
  input: RecoverHistoryInput,
  window: HistoryWindow,
  result: HistoryResult,
  relayStats: { largestPage: number },
): Promise<boolean> {
  const limits = NOSTR.historyPageLimits
  const handled = new Set<string>()
  let until = window.until
  let level = 0
  for (;;) {
    const limit = limits[level]!
    const page = await input.pool.query(
      input.relay,
      { kinds: [NOSTR.wrapKind], '#p': [input.recipientPubkey], since: window.since, until, limit },
      input.queryTimeoutMs,
    )
    if (!page.complete) return false
    const valid = page.events.filter(isDated).filter((e) => e.created_at >= window.since && e.created_at <= until)
    for (const event of valid) {
      if (handled.has(event.id)) continue
      handled.add(event.id)
      await input.handle(event)
      result.events++
    }
    const count = page.events.length
    if (count === 0) return true
    if (valid.length === 0) return false
    const oldest = Math.min(...valid.map((e) => e.created_at))
    const trusted = Math.max(NOSTR.minTrustedRelayLimit, relayStats.largestPage)
    const mayBeTruncated = count >= Math.min(limit, trusted)
    relayStats.largestPage = Math.max(relayStats.largestPage, count)

    if (mayBeTruncated) {
      if (oldest < until) {
        until = oldest
        level = 0
        continue
      }
      if (level + 1 < limits.length) {
        level++
        continue
      }
      return false
    }
    // Not truncated by the relay's limit. Confirm with a strictly older query, which also walks
    // relays that cap below the trusted limit when the timestamps differ.
    if (oldest - 1 < window.since) return true
    until = oldest - 1
    level = 0
  }
}
