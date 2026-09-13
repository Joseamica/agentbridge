import { HandleSchema, LIMITS, type TicketView } from '@agentbridge/core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { RouteContext } from '../app'
import { withTx, type Pool } from '../db'
import { HttpError } from '../errors'
import { recordEvent } from '../events'
import { requireDevice } from '../guards'

const CreateBody = z.object({ to: HandleSchema, question: z.string().trim().min(1).max(LIMITS.questionMaxChars) })
const Params = z.object({ id: z.uuid() })
const Query = z.object({ wait: z.coerce.number().int().min(0).max(LIMITS.longPollMaxSeconds).default(0) })
const TERMINAL = new Set(['answered', 'expired', 'cancelled'])

type TicketRow = {
  id: string
  status: TicketView['status']
  to_handle: string
  question: string
  answer: string | null
  answer_source: string | null
  answer_confidence: TicketView['confidence']
  created_at: Date
  answered_at: Date | null
}

async function loadTicket(pool: Pool, ticketId: string, userId: string): Promise<TicketView | null> {
  const r = await pool.query<TicketRow>(
    `select t.id, t.status, u.handle as to_handle, t.question, t.answer, t.answer_source, t.answer_confidence,
            t.created_at, t.answered_at
       from tickets t join users u on u.id = t.responder_id
      where t.id = $1 and (t.asker_id = $2 or t.responder_id = $2)`,
    [ticketId, userId],
  )
  const row = r.rows[0]
  if (!row) return null
  return {
    ticketId: row.id,
    status: row.status,
    to: row.to_handle,
    question: row.question,
    answer: row.answer,
    source: row.answer_source,
    confidence: row.answer_confidence,
    createdAt: row.created_at.toISOString(),
    answeredAt: row.answered_at?.toISOString() ?? null,
    latencyMs: row.answered_at ? row.answered_at.getTime() - row.created_at.getTime() : null,
  }
}

export function registerTicketRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/v1/tickets', async (req, reply) => {
    const principal = await requireDevice(ctx.pool, req)
    const body = CreateBody.parse(req.body)
    const created = await withTx(ctx.pool, async (c) => {
      const g = await c.query<{ grant_id: string; responder_id: string }>(
        `select g.id as grant_id, g.responder_id
           from grants g join users u on u.id = g.responder_id
          where u.handle = $1 and g.asker_id = $2 and g.revoked_at is null
          for update of g`,
        [body.to, principal.userId],
      )
      const grant = g.rows[0]
      if (!grant) throw new HttpError(403, 'not_allowed', 'No tienes permiso para preguntarle a esa persona')
      const counts = await c.query<{ open: string; day: string }>(
        `select count(*) filter (where status in ('queued', 'dispatched')) as open,
                count(*) filter (where created_at > now() - interval '24 hours') as day
           from tickets where asker_id = $1 and responder_id = $2`,
        [principal.userId, grant.responder_id],
      )
      if (Number(counts.rows[0]!.open) >= LIMITS.maxOpenTicketsPerPair) {
        throw new HttpError(429, 'too_many_open', `Ya tienes ${LIMITS.maxOpenTicketsPerPair} preguntas abiertas con ${body.to}`)
      }
      if (Number(counts.rows[0]!.day) >= LIMITS.maxTicketsPerPairPerDay) {
        throw new HttpError(429, 'daily_limit', `Llegaste al límite de ${LIMITS.maxTicketsPerPairPerDay} preguntas al día con ${body.to}`)
      }
      const t = await c.query<{ id: string }>(
        `insert into tickets (grant_id, asker_id, responder_id, question, status, expires_at)
         values ($1, $2, $3, $4, 'queued', now() + make_interval(secs => $5)) returning id`,
        [grant.grant_id, principal.userId, grant.responder_id, body.question, LIMITS.ticketTtlMs / 1000],
      )
      const ticketId = t.rows[0]!.id
      await recordEvent(c, { ticketId, actorUserId: principal.userId, kind: 'created', detail: { to: body.to, chars: body.question.length } })
      return { ticketId, responderId: grant.responder_id }
    })
    void ctx.hub.pump(created.responderId)
    return reply.status(201).send({ ticketId: created.ticketId, status: 'queued' })
  })

  app.get('/v1/tickets/:id', async (req) => {
    const principal = await requireDevice(ctx.pool, req)
    const { id } = Params.parse(req.params)
    const { wait } = Query.parse(req.query)
    const waiter = ctx.hub.waitForTicket(id, wait * 1000)
    let view = await loadTicket(ctx.pool, id, principal.userId)
    if (!view) {
      waiter.cancel()
      throw new HttpError(404, 'ticket_not_found', 'No existe esa pregunta o no tienes acceso')
    }
    if (wait > 0 && !TERMINAL.has(view.status)) {
      await waiter.promise
      view = (await loadTicket(ctx.pool, id, principal.userId)) ?? view
    } else {
      waiter.cancel()
    }
    return view
  })
}
