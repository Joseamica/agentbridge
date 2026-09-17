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
  let queries = 0
  for (;;) {
    // Ruling 18: a relay that keeps handing back one fresh-looking event per query (e.g. a racing
    // live event that echoes whatever `until` was just asked for) can otherwise walk `until` down
    // one second at a time for the whole window, never converging. Bound the cost and report the
    // window honestly instead.
    if (queries >= NOSTR.historyMaxQueriesPerWindow) return false
    queries++
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
    // Ruling 16: de-duplicate this page's valid events by id and sort newest first, so a possibly
    // truncated page is cut at the position the relay actually guarantees, not at whatever
    // timestamp happens to be oldest — which a hostile or racing relay could set by slipping in an
    // extra, older-looking event (e.g. a live one) before EOSE.
    const distinct = [...new Map(valid.map((e) => [e.id, e])).values()].sort((a, b) => b.created_at - a.created_at)
    const trusted = Math.max(NOSTR.minTrustedRelayLimit, relayStats.largestPage)
    const threshold = Math.min(limit, trusted)
    const mayBeTruncated = count >= threshold
    // Ruling 17: a page can never prove the relay honors limits above what was actually requested.
    relayStats.largestPage = Math.max(relayStats.largestPage, Math.min(count, limit))
    // Ruling 19a: a page with nothing usable (empty, or entirely events too large to read) can only
    // be a real gap when it might have been truncated; otherwise there is nothing left to fetch.
    if (distinct.length === 0) return !mayBeTruncated

    if (mayBeTruncated) {
      // At least `k` stored (distinct, valid) events sit at or above the relay's cut, so an extra
      // event delivered before EOSE can never pull `until` past events the relay did not return.
      const k = threshold - (count - distinct.length)
      if (k <= 0) return false
      const cut = distinct[k - 1]!.created_at
      if (cut < until) {
        until = cut
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
    const oldest = distinct[distinct.length - 1]!.created_at
    if (oldest - 1 < window.since) return true
    until = oldest - 1
    level = 0
  }
}
