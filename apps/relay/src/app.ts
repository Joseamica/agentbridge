import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Pool } from './db'
import { registerErrorHandler } from './errors'
import { ResponderHub } from './hub'
import { registerContactRoutes } from './routes/contacts'
import { registerIdentityRoutes } from './routes/identity'
import { registerTicketRoutes } from './routes/tickets'

export type RouteContext = { pool: Pool; hub: ResponderHub; publicUrl: string; adminToken: string }

export type AppDeps = { pool: Pool; publicUrl: string; adminToken: string; hub?: ResponderHub; logger?: boolean }

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; hub: ResponderHub }> {
  const hub = deps.hub ?? new ResponderHub(deps.pool)
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 64 * 1024 })
  registerErrorHandler(app)
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } })
  const ctx: RouteContext = { pool: deps.pool, hub, publicUrl: deps.publicUrl.replace(/\/+$/, ''), adminToken: deps.adminToken }

  app.get('/health', async () => ({ ok: true }))
  registerIdentityRoutes(app, ctx)
  registerContactRoutes(app, ctx)
  registerTicketRoutes(app, ctx)

  app.get('/v1/responder', { websocket: true }, (socket) => {
    const conn = hub.handleOpen(socket)
    let chain: Promise<void> = Promise.resolve()
    const enqueue = (work: () => Promise<void>) => {
      chain = chain.then(work).catch((err: unknown) => app.log.error(err))
    }
    socket.on('message', (data: Buffer) => enqueue(() => hub.handleMessage(conn, data.toString())))
    socket.on('close', () => {
      hub.markClosed(conn)
      enqueue(() => hub.handleClose(conn))
    })
  })

  await app.ready()
  return { app, hub }
}
