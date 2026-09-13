import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ResponderHub } from '../src/hub'
import { FakeSocket, authHeader, buildTestApp, enrollViaApi, resetDb, testPool, ticketRow } from './helpers'

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
})
afterEach(async () => {
  await app.close()
})
afterAll(async () => {
  await pool.end()
})

async function invite(token = devToken) {
  const res = await app.inject({ method: 'POST', url: '/v1/contact-invites', headers: authHeader(token) })
  expect(res.statusCode).toBe(201)
  return (res.json() as { acceptUrl: string }).acceptUrl.split('/').pop()!
}

async function accept(code: string, token = amievaToken) {
  return app.inject({ method: 'POST', url: '/v1/contact-invites/accept', headers: authHeader(token), payload: { code } })
}

async function contacts(token: string) {
  return (await app.inject({ method: 'GET', url: '/v1/contacts', headers: authHeader(token) })).json()
}

describe('contact routes', () => {
  it('turns an accepted invite into a directional grant', async () => {
    const res = await accept(await invite())
    expect(res.json()).toEqual({ responder: { handle: 'dev', displayName: 'Dev Ejemplo' } })
    expect(await contacts(amievaToken)).toEqual({ canAsk: [{ handle: 'dev', displayName: 'Dev Ejemplo', online: false }], canAskMe: [] })
    expect(await contacts(devToken)).toEqual({ canAsk: [], canAskMe: [{ handle: 'amieva', displayName: 'Amieva' }] })
  })

  it('makes invites single-use', async () => {
    const code = await invite()
    await accept(code)
    const thirdToken = await enrollViaApi(app, 'tercero')
    const res = await accept(code, thirdToken)
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: { code: string } }).error.code).toBe('invite_invalid')
  })

  it('rejects accepting your own invite and expired invites', async () => {
    expect((await accept(await invite(), devToken)).statusCode).toBe(400)
    const code = await invite()
    await pool.query(`update contact_invites set expires_at = now() - interval '1 minute'`)
    expect((await accept(code)).statusCode).toBe(404)
  })

  it('shows the responder as online while its channel is connected', async () => {
    await accept(await invite())
    const conn = hub.handleOpen(new FakeSocket())
    await hub.handleMessage(conn, JSON.stringify({ type: 'auth', token: devToken }))
    expect(await contacts(amievaToken)).toMatchObject({ canAsk: [{ handle: 'dev', online: true }] })
  })

  it('revokes a grant, cancels queued and in-flight questions and tells the channel', async () => {
    await accept(await invite())
    const socket = new FakeSocket()
    const conn = hub.handleOpen(socket)
    await hub.handleMessage(conn, JSON.stringify({ type: 'auth', token: devToken }))
    const grant = await pool.query<{ id: string; responder_id: string; asker_id: string }>('select id, responder_id, asker_id from grants')
    const g = grant.rows[0]!
    const inFlight = await pool.query<{ id: string }>(
      `insert into tickets (grant_id, asker_id, responder_id, question, status, expires_at)
       values ($1, $2, $3, 'uno', 'queued', now() + interval '1 day') returning id`,
      [g.id, g.asker_id, g.responder_id],
    )
    await hub.pump(g.responder_id)
    const attemptId = socket.questions()[0]!.attemptId

    const res = await app.inject({ method: 'DELETE', url: '/v1/grants/amieva', headers: authHeader(devToken) })
    expect(res.statusCode).toBe(204)
    expect((await ticketRow(pool, inFlight.rows[0]!.id)).status).toBe('cancelled')
    expect(socket.sent).toContainEqual({ type: 'cancel', attemptId, reason: 'revoked' })
    expect(await contacts(amievaToken)).toEqual({ canAsk: [], canAskMe: [] })

    const again = await app.inject({ method: 'DELETE', url: '/v1/grants/amieva', headers: authHeader(devToken) })
    expect(again.statusCode).toBe(404)
  })

  it('serves plain-text instructions for an invite link', async () => {
    const res = await app.inject({ method: 'GET', url: '/c/xyz789' })
    expect(res.body).toContain('agentbridge accept http://relay.test/c/xyz789')
  })
})
