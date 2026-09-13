import type { TicketView } from '@agentbridge/core'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ResponderHub } from '../src/hub'
import { FakeSocket, authHeader, buildTestApp, enrollViaApi, insertTicket, resetDb, testPool } from './helpers'

let pool: pg.Pool
let app: FastifyInstance
let hub: ResponderHub
let devToken: string
let amievaToken: string

beforeAll(async () => {
  pool = await testPool()
})
beforeEach(async () => {
  await resetDb(pool)
  ;({ app, hub } = await buildTestApp(pool))
  devToken = await enrollViaApi(app, 'dev', 'Dev Ejemplo')
  amievaToken = await enrollViaApi(app, 'amieva', 'Amieva')
  const inv = await app.inject({ method: 'POST', url: '/v1/contact-invites', headers: authHeader(devToken) })
  const code = (inv.json() as { acceptUrl: string }).acceptUrl.split('/').pop()!
  await app.inject({ method: 'POST', url: '/v1/contact-invites/accept', headers: authHeader(amievaToken), payload: { code } })
})
afterEach(async () => {
  await app.close()
})
afterAll(async () => {
  await pool.end()
})

const ask = (question: string, to = 'dev', token = amievaToken) =>
  app.inject({ method: 'POST', url: '/v1/tickets', headers: authHeader(token), payload: { to, question } })

const read = (id: string, token: string, wait = 0) =>
  app.inject({ method: 'GET', url: `/v1/tickets/${id}?wait=${wait}`, headers: authHeader(token) })

describe('ticket routes', () => {
  it('creates a queued ticket readable by asker and responder only', async () => {
    const res = await ask('¿Ya quedó el fix?')
    expect(res.statusCode).toBe(201)
    const { ticketId, status } = res.json() as { ticketId: string; status: string }
    expect(status).toBe('queued')
    const view = (await read(ticketId, amievaToken)).json() as TicketView
    expect(view).toMatchObject({ ticketId, status: 'queued', to: 'dev', question: '¿Ya quedó el fix?', answer: null, latencyMs: null })
    expect((await read(ticketId, devToken)).statusCode).toBe(200)
    const stranger = await enrollViaApi(app, 'extrano')
    expect((await read(ticketId, stranger)).statusCode).toBe(404)
  })

  it('answers 403 not_allowed both without a grant and for an unknown handle', async () => {
    const noGrant = await ask('q', 'amieva', devToken)
    const unknown = await ask('q', 'nadie')
    expect(noGrant.statusCode).toBe(403)
    expect(unknown.statusCode).toBe(403)
    expect(unknown.json()).toEqual(noGrant.json())
  })

  it('rejects an empty or oversized question', async () => {
    expect((await ask('   ')).statusCode).toBe(400)
    expect((await ask('x'.repeat(4001))).statusCode).toBe(400)
  })

  it('limits open tickets per pair to 5', async () => {
    for (let i = 0; i < 5; i++) expect((await ask(`q${i}`)).statusCode).toBe(201)
    const sixth = await ask('q6')
    expect(sixth.statusCode).toBe(429)
    expect((sixth.json() as { error: { code: string } }).error.code).toBe('too_many_open')
  })

  it('limits tickets per pair to 20 per rolling day', async () => {
    const g = (await pool.query<{ id: string; responder_id: string; asker_id: string }>('select id, responder_id, asker_id from grants')).rows[0]!
    for (let i = 0; i < 20; i++) {
      await insertTicket(pool, { grantId: g.id, askerId: g.asker_id, responderId: g.responder_id, status: 'answered' })
    }
    const res = await ask('una más')
    expect(res.statusCode).toBe(429)
    expect((res.json() as { error: { code: string } }).error.code).toBe('daily_limit')
  })

  it('returns immediately when wait is 0 and times out when nothing happens', async () => {
    const { ticketId } = (await ask('q')).json() as { ticketId: string }
    const started = Date.now()
    expect(((await read(ticketId, amievaToken, 1)).json() as TicketView).status).toBe('queued')
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  it('releases a long-poll as soon as the responder answers', async () => {
    const socket = new FakeSocket()
    const conn = hub.handleOpen(socket)
    await hub.handleMessage(conn, JSON.stringify({ type: 'auth', token: devToken }))
    const { ticketId } = (await ask('¿Cuál es el timeout?')).json() as { ticketId: string }
    const devId = (await pool.query<{ id: string }>(`select id from users where handle = 'dev'`)).rows[0]!.id
    await hub.pump(devId)
    const q = socket.questions()[0]!

    const started = Date.now()
    const pending = read(ticketId, amievaToken, 30)
    await hub.handleMessage(conn, JSON.stringify({ type: 'answer', attemptId: q.attemptId, code: q.code, text: '45 segundos', source: 'config/timeouts.yaml', confidence: 'seguro' }))
    const view = (await pending).json() as TicketView
    expect(Date.now() - started).toBeLessThan(5000)
    expect(view).toMatchObject({ status: 'answered', answer: '45 segundos', source: 'config/timeouts.yaml', confidence: 'seguro' })
    expect(view.latencyMs).toBeGreaterThanOrEqual(0)
  })
})
