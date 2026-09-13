import type { Db } from './db'

export async function recordEvent(
  db: Db,
  e: { ticketId?: string | null; actorUserId?: string | null; kind: string; detail?: Record<string, unknown> },
): Promise<void> {
  await db.query('insert into events (ticket_id, actor_user_id, kind, detail) values ($1, $2, $3, $4)', [
    e.ticketId ?? null,
    e.actorUserId ?? null,
    e.kind,
    JSON.stringify(e.detail ?? {}),
  ])
}
