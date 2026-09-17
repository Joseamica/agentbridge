import type { ProcessIdentity } from '../process-identity'
import type { Store } from './db'

export type ChannelLockHolder = { pid: number; start: string; epoch: number; acquiredAt: number }
export type AcquireChannelLockOutcome = { kind: 'acquired'; epoch: number; requeued: number } | { kind: 'held'; holder: ChannelLockHolder }

type LockRow = { pid: number; process_start: string; epoch: number; acquired_at: number }

const readLock = (store: Store) =>
  store.db.prepare('SELECT pid, process_start, epoch, acquired_at FROM channel_lock WHERE id = 1').get() as LockRow | undefined

const toHolder = (row: LockRow): ChannelLockHolder => ({ pid: row.pid, start: row.process_start, epoch: row.epoch, acquiredAt: row.acquired_at })

export function getChannelLock(store: Store): ChannelLockHolder | null {
  const row = readLock(store)
  return row && row.pid > 0 ? toHolder(row) : null
}

export function verifyChannelLock(store: Store, epoch: number): boolean {
  const row = readLock(store)
  return row !== undefined && row.pid > 0 && row.epoch === epoch
}

// The row is never deleted and every take increments the epoch, so epochs only grow: a channel that
// wakes up after losing the lock can never match a newer owner's epoch (fencing).
export function acquireChannelLock(
  store: Store,
  input: { self: ProcessIdentity; isAlive: (holder: ProcessIdentity) => boolean; now: number },
): AcquireChannelLockOutcome {
  for (let round = 0; round < 3; round++) {
    const seen = readLock(store)
    // Probing another process runs `ps`, so it happens before the write transaction starts.
    const foreignOwner = seen !== undefined && seen.pid > 0 && !(seen.pid === input.self.pid && seen.process_start === input.self.start)
    const ownerAlive = foreignOwner && input.isAlive({ pid: seen.pid, start: seen.process_start })
    const outcome = store.tx((): AcquireChannelLockOutcome | null => {
      const current = readLock(store)
      const unchanged = (current?.epoch ?? 0) === (seen?.epoch ?? 0) && (current?.pid ?? 0) === (seen?.pid ?? 0)
      if (!unchanged) return null
      if (current && ownerAlive) return { kind: 'held', holder: toHolder(current) }
      const epoch = (current?.epoch ?? 0) + 1
      store.db
        .prepare(
          `INSERT INTO channel_lock (id, pid, process_start, epoch, acquired_at) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, process_start = excluded.process_start, epoch = excluded.epoch, acquired_at = excluded.acquired_at`,
        )
        .run(input.self.pid, input.self.start, epoch, input.now)
      // Recovery: whatever the previous owner had in flight goes back to the queue.
      store.db.prepare("UPDATE attempts SET state = 'cancelled', cancel_reason = 'recovered', ended_at = ? WHERE state = 'active'").run(input.now)
      const requeued = store.db.prepare("UPDATE inbox_questions SET state = 'queued', updated_at = ? WHERE state = 'dispatched'").run(input.now)
      return { kind: 'acquired', epoch, requeued: Number(requeued.changes) }
    })
    if (outcome) return outcome
  }
  const current = readLock(store)
  return { kind: 'held', holder: current ? toHolder(current) : { pid: 0, start: '', epoch: 0, acquiredAt: 0 } }
}

export function releaseChannelLock(store: Store, input: { epoch: number }): boolean {
  const result = store.tx(() =>
    store.db.prepare("UPDATE channel_lock SET pid = 0, process_start = '' WHERE id = 1 AND epoch = ? AND pid > 0").run(input.epoch),
  )
  return Number(result.changes) > 0
}
