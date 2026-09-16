import { CLI_COMMAND, HandleSchema, LIMITS, hashSecret, newSecret } from '@agentbridge/core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { RouteContext } from '../app'
import { withTx } from '../db'
import { HttpError } from '../errors'
import { recordEvent } from '../events'
import { requireDevice } from '../guards'

const AcceptBody = z.object({ code: z.string().min(10).max(100) })

export function registerContactRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/v1/contact-invites', async (req, reply) => {
    const principal = await requireDevice(ctx.pool, req)
    const code = newSecret()
    const expiresAt = new Date(Date.now() + LIMITS.inviteTtlMs)
    await ctx.pool.query('insert into contact_invites (code_hash, responder_id, expires_at) values ($1, $2, $3)', [hashSecret(code), principal.userId, expiresAt])
    await recordEvent(ctx.pool, { actorUserId: principal.userId, kind: 'invite_created' })
    return reply.status(201).send({ acceptUrl: `${ctx.publicUrl}/c/${code}`, expiresAt: expiresAt.toISOString() })
  })

  app.post('/v1/contact-invites/accept', async (req) => {
    const principal = await requireDevice(ctx.pool, req)
    const { code } = AcceptBody.parse(req.body)
    return withTx(ctx.pool, async (c) => {
      const inv = await c.query<{ responder_id: string }>(
        `select responder_id from contact_invites
          where code_hash = $1 and used_at is null and expires_at > now()
          for update`,
        [hashSecret(code)],
      )
      const responderId = inv.rows[0]?.responder_id
      if (!responderId) throw new HttpError(404, 'invite_invalid', 'La invitación no existe, ya se usó o caducó')
      if (responderId === principal.userId) throw new HttpError(400, 'own_invite', 'No puedes aceptar tu propia invitación')
      await c.query('update contact_invites set used_at = now(), used_by = $2 where code_hash = $1', [hashSecret(code), principal.userId])
      await c.query(
        `insert into grants (responder_id, asker_id) values ($1, $2)
         on conflict (responder_id, asker_id) where revoked_at is null do nothing`,
        [responderId, principal.userId],
      )
      const r = await c.query<{ handle: string; display_name: string }>('select handle, display_name from users where id = $1', [responderId])
      const responder = r.rows[0]!
      await recordEvent(c, { actorUserId: principal.userId, kind: 'grant_created', detail: { responder: responder.handle } })
      return { responder: { handle: responder.handle, displayName: responder.display_name } }
    })
  })

  app.get('/v1/contacts', async (req) => {
    const principal = await requireDevice(ctx.pool, req)
    const canAsk = await ctx.pool.query<{ id: string; handle: string; display_name: string }>(
      `select u.id, u.handle, u.display_name from grants g join users u on u.id = g.responder_id
        where g.asker_id = $1 and g.revoked_at is null order by u.handle`,
      [principal.userId],
    )
    const canAskMe = await ctx.pool.query<{ handle: string; display_name: string }>(
      `select u.handle, u.display_name from grants g join users u on u.id = g.asker_id
        where g.responder_id = $1 and g.revoked_at is null order by u.handle`,
      [principal.userId],
    )
    return {
      canAsk: canAsk.rows.map((r) => ({ handle: r.handle, displayName: r.display_name, online: ctx.hub.isOnline(r.id) })),
      canAskMe: canAskMe.rows.map((r) => ({ handle: r.handle, displayName: r.display_name })),
    }
  })

  app.delete('/v1/grants/:askerHandle', async (req, reply) => {
    const principal = await requireDevice(ctx.pool, req)
    const { askerHandle } = z.object({ askerHandle: HandleSchema }).parse(req.params)
    const closed = await withTx(ctx.pool, async (c) => {
      const g = await c.query<{ id: string }>(
        `update grants set revoked_at = now()
          where responder_id = $1 and revoked_at is null
            and asker_id = (select id from users where handle = $2)
          returning id`,
        [principal.userId, askerHandle],
      )
      const grantId = g.rows[0]?.id
      if (!grantId) throw new HttpError(404, 'grant_not_found', 'Esa persona no tiene permiso para preguntarte')
      const tickets = await c.query<{ id: string }>(
        `update tickets set status = 'cancelled' where grant_id = $1 and status in ('queued', 'dispatched') returning id`,
        [grantId],
      )
      const ticketIds = tickets.rows.map((r) => r.id)
      const attempts = await c.query<{ id: string }>(
        `update attempts set closed_at = now(), outcome = 'cancelled'
          where closed_at is null and ticket_id = any($1::uuid[]) returning id`,
        [ticketIds],
      )
      await recordEvent(c, { actorUserId: principal.userId, kind: 'grant_revoked', detail: { asker: askerHandle, cancelledTickets: ticketIds.length } })
      return { ticketIds, attemptIds: attempts.rows.map((r) => r.id) }
    })
    for (const id of closed.ticketIds) ctx.hub.notifyTicket(id)
    for (const attemptId of closed.attemptIds) await ctx.hub.closeAttempt(principal.userId, attemptId, 'revoked')
    return reply.status(204).send()
  })

  app.get('/c/:code', async (req, reply) =>
    reply
      .type('text/plain; charset=utf-8')
      .send(`Esta es una invitación de contacto de AgentBridge.\nEjecuta en tu computadora:\n\n  ${CLI_COMMAND} accept ${ctx.publicUrl}${req.url}\n`),
  )
}
