import { LIMITS } from '@agentbridge/core'
import { withTx, type Pool } from './db'
import { recordEvent } from './events'
import type { ResponderHub } from './hub'

export async function sweep(pool: Pool, hub: ResponderHub): Promise<{ timedOut: number; expired: number; purged: number }> {
  const timedOut = await withTx(pool, async (c) => {
    const r = await c.query<{ attempt_id: string; ticket_id: string; responder_id: string }>(
      `update attempts a set closed_at = now(), outcome = 'timeout'
         from tickets t
        where a.ticket_id = t.id and a.closed_at is null and a.deadline_at < now()
        returning a.id as attempt_id, a.ticket_id, t.responder_id`,
    )
    for (const row of r.rows) {
      await c.query(`update tickets set status = 'expired' where id = $1 and status = 'dispatched'`, [row.ticket_id])
      await recordEvent(c, { ticketId: row.ticket_id, kind: 'attempt_timeout', detail: { attemptId: row.attempt_id } })
    }
    return r.rows
  })
  for (const row of timedOut) {
    hub.notifyTicket(row.ticket_id)
    await hub.closeAttempt(row.responder_id, row.attempt_id, 'timeout')
  }

  const expired = await pool.query<{ id: string }>(
    `update tickets set status = 'expired' where status = 'queued' and expires_at < now() returning id`,
  )
  for (const row of expired.rows) {
    await recordEvent(pool, { ticketId: row.id, kind: 'ticket_expired' })
    hub.notifyTicket(row.id)
  }

  const purged = await pool.query(`delete from tickets where created_at < now() - make_interval(secs => $1)`, [
    LIMITS.contentRetentionMs / 1000,
  ])
  await pool.query(`delete from events where at < now() - make_interval(secs => $1)`, [LIMITS.auditRetentionMs / 1000])

  return { timedOut: timedOut.length, expired: expired.rowCount ?? 0, purged: purged.rowCount ?? 0 }
}

export async function recoverOrphanedAttempts(pool: Pool): Promise<number> {
  return withTx(pool, async (c) => {
    const r = await c.query<{ attempt_id: string; ticket_id: string }>(
      `update attempts set closed_at = now(), outcome = 'disconnected'
        where closed_at is null
        returning id as attempt_id, ticket_id`,
    )
    let requeued = 0
    for (const row of r.rows) {
      const updated = await c.query(
        `update tickets set status = 'queued' where id = $1 and status = 'dispatched' and expires_at > now()`,
        [row.ticket_id],
      )
      if ((updated.rowCount ?? 0) === 0) continue
      await recordEvent(c, {
        ticketId: row.ticket_id,
        kind: 'requeued',
        detail: { attemptId: row.attempt_id, reason: 'startup_recovery' },
      })
      requeued++
    }
    return requeued
  })
}

export function startSweeper(pool: Pool, hub: ResponderHub, intervalMs = 15_000): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    sweep(pool, hub)
      .catch((err: unknown) => console.error('[sweeper]', err))
      .finally(() => {
        running = false
      })
  }, intervalMs)
  return () => clearInterval(timer)
}
