import { NOSTR } from '../nostr-constants'
import type { Store } from './db'

export const DAY_SECONDS = 86_400

export type CursorRole = 'asker' | 'responder'
export type HistoryWindow = { since: number; until: number }

const alignDay = (t: number) => Math.floor(t / DAY_SECONDS) * DAY_SECONDS

export function historyWindows(store: Store, input: { relay: string; role: CursorRole; now: number }): HistoryWindow[] {
  const first = alignDay(input.now - NOSTR.historyDays * DAY_SECONDS)
  const last = alignDay(input.now)
  const complete = new Set(
    (
      store.db
        .prepare('SELECT day_start FROM cursors WHERE relay = ? AND role = ? AND complete = 1 AND day_start BETWEEN ? AND ?')
        .all(input.relay, input.role, first, last) as Array<{ day_start: number }>
    ).map((r) => r.day_start),
  )
  const windows: HistoryWindow[] = []
  for (let day = last; day >= first; day -= DAY_SECONDS) {
    if (!complete.has(day)) windows.push({ since: day, until: day + DAY_SECONDS - 1 })
  }
  return windows
}

// NIP-59 dates seals and wraps up to two days in the past, so a wrap published at any moment
// after `readStartedAt` can still land in a window that ends later than
// readStartedAt − 2 days − 10 minutes. Only windows that ended before that point can be final.
export function markWindowComplete(
  store: Store,
  input: { relay: string; role: CursorRole; since: number; readStartedAt: number; now: number },
): boolean {
  if (input.since % DAY_SECONDS !== 0) throw new Error('cursors: window must be aligned to a day')
  if (input.since + DAY_SECONDS - 1 > input.readStartedAt - NOSTR.liveSinceSeconds) return false
  store.tx(() =>
    store.db
      .prepare(
        `INSERT INTO cursors (relay, role, day_start, complete, updated_at) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT (relay, role, day_start) DO UPDATE SET complete = 1, updated_at = excluded.updated_at`,
      )
      .run(input.relay, input.role, input.since, input.now),
  )
  return true
}

export function purgeCursors(store: Store, now: number): number {
  const horizon = alignDay(now - (NOSTR.historyDays + 1) * DAY_SECONDS)
  const result = store.tx(() => store.db.prepare('DELETE FROM cursors WHERE day_start < ?').run(horizon))
  return Number(result.changes)
}
