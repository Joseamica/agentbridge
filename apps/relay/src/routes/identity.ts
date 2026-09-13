import { HandleSchema, LIMITS, hashSecret, newSecret } from '@agentbridge/core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { RouteContext } from '../app'
import { withTx } from '../db'
import { HttpError } from '../errors'
import { recordEvent } from '../events'
import { requireAdmin, requireDevice } from '../guards'

const EnrollmentBody = z.object({ handle: HandleSchema, displayName: z.string().trim().min(1).max(80) })
const EnrollBody = z.object({ code: z.string().min(10).max(100), deviceName: z.string().trim().min(1).max(80) })

export function registerIdentityRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/v1/admin/enrollments', async (req, reply) => {
    requireAdmin(ctx.adminToken, req)
    const body = EnrollmentBody.parse(req.body)
    const code = newSecret()
    const expiresAt = new Date(Date.now() + LIMITS.enrollmentTtlMs)
    await withTx(ctx.pool, async (c) => {
      const u = await c.query<{ id: string }>(
        `insert into users (handle, display_name) values ($1, $2)
         on conflict (handle) do update set display_name = excluded.display_name
         returning id`,
        [body.handle, body.displayName],
      )
      const userId = u.rows[0]!.id
      await c.query('insert into enrollments (code_hash, user_id, expires_at) values ($1, $2, $3)', [hashSecret(code), userId, expiresAt])
      await recordEvent(c, { actorUserId: userId, kind: 'enrollment_created' })
    })
    return reply.status(201).send({ enrollUrl: `${ctx.publicUrl}/e/${code}`, expiresAt: expiresAt.toISOString() })
  })

  app.post('/v1/enroll', async (req, reply) => {
    const body = EnrollBody.parse(req.body)
    const deviceToken = newSecret()
    const user = await withTx(ctx.pool, async (c) => {
      const e = await c.query<{ user_id: string }>(
        `update enrollments set used_at = now()
          where code_hash = $1 and used_at is null and expires_at > now()
          returning user_id`,
        [hashSecret(body.code)],
      )
      const userId = e.rows[0]?.user_id
      if (!userId) throw new HttpError(404, 'enrollment_invalid', 'El enlace de alta no existe, ya se usó o caducó')
      await c.query('insert into devices (user_id, name, token_hash) values ($1, $2, $3)', [userId, body.deviceName, hashSecret(deviceToken)])
      await recordEvent(c, { actorUserId: userId, kind: 'device_enrolled', detail: { deviceName: body.deviceName } })
      const u = await c.query<{ handle: string; display_name: string }>('select handle, display_name from users where id = $1', [userId])
      return u.rows[0]!
    })
    return reply.status(201).send({ deviceToken, handle: user.handle, displayName: user.display_name })
  })

  app.get('/v1/me', async (req) => {
    const principal = await requireDevice(ctx.pool, req)
    return { handle: principal.handle, displayName: principal.displayName }
  })

  app.get('/e/:code', async (req, reply) =>
    reply
      .type('text/plain; charset=utf-8')
      .send(`Este es un enlace de alta de AgentBridge.\nEjecuta en tu computadora:\n\n  agentbridge enroll ${ctx.publicUrl}${req.url}\n`),
  )
}
