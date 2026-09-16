import { CLI_COMMAND } from '@agentbridge/core'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_TOKEN, authHeader, buildTestApp, enrollViaApi, resetDb, testPool } from './helpers'

let pool: pg.Pool
let app: FastifyInstance

beforeAll(async () => {
  pool = await testPool()
})
beforeEach(async () => {
  await resetDb(pool)
  app = (await buildTestApp(pool)).app
})
afterEach(async () => {
  await app.close()
})
afterAll(async () => {
  await pool.end()
})

async function createEnrollment(handle = 'dev') {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/admin/enrollments',
    headers: authHeader(ADMIN_TOKEN),
    payload: { handle, displayName: 'Dev Ejemplo' },
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { enrollUrl: string }).enrollUrl.split('/').pop()!
}

describe('identity routes', () => {
  it('reports health without authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toEqual({ ok: true })
  })

  it('rejects admin calls without the admin token', async () => {
    const missing = await app.inject({ method: 'POST', url: '/v1/admin/enrollments', payload: { handle: 'dev', displayName: 'Dev' } })
    const wrong = await app.inject({ method: 'POST', url: '/v1/admin/enrollments', headers: authHeader('nope-nope-nope-nope-nope'), payload: { handle: 'dev', displayName: 'Dev' } })
    expect(missing.statusCode).toBe(401)
    expect(wrong.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } })
  })

  it('rejects an invalid handle with 400 invalid_request', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/admin/enrollments', headers: authHeader(ADMIN_TOKEN), payload: { handle: 'Bad Handle', displayName: 'x' } })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('invalid_request')
    expect(body.error.message).toBe('Datos inválidos en: handle')
  })

  it('rejects a malformed JSON body with a generic Spanish message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enroll',
      headers: { 'content-type': 'application/json' },
      payload: 'not json',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: { code: 'invalid_request', message: 'Solicitud inválida' } })
  })

  it('returns a uniform 404 envelope for unmatched routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/no-existe' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Ruta no encontrada' } })
  })

  it('enrolls a device once and authenticates it', async () => {
    const code = await createEnrollment()
    const enrolled = await app.inject({ method: 'POST', url: '/v1/enroll', payload: { code, deviceName: 'mac' } })
    expect(enrolled.statusCode).toBe(201)
    const { deviceToken, handle } = enrolled.json() as { deviceToken: string; handle: string }
    expect(handle).toBe('dev')
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: authHeader(deviceToken) })
    expect(me.json()).toEqual({ handle: 'dev', displayName: 'Dev Ejemplo' })

    const again = await app.inject({ method: 'POST', url: '/v1/enroll', payload: { code, deviceName: 'other' } })
    expect(again.statusCode).toBe(404)
    expect((again.json() as { error: { code: string } }).error.code).toBe('enrollment_invalid')
  })

  it('rejects an expired enrollment link', async () => {
    const code = await createEnrollment()
    await pool.query(`update enrollments set expires_at = now() - interval '1 minute'`)
    const res = await app.inject({ method: 'POST', url: '/v1/enroll', payload: { code, deviceName: 'mac' } })
    expect(res.statusCode).toBe(404)
  })

  it('stores only token hashes and rejects revoked devices', async () => {
    const token = await enrollViaApi(app, 'dev')
    const rows = await pool.query('select token_hash from devices')
    expect(rows.rows[0].token_hash).not.toBe(token)
    expect(JSON.stringify(rows.rows)).not.toContain(token)
    await pool.query('update devices set revoked_at = now()')
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: authHeader(token) })
    expect(me.statusCode).toBe(401)
  })

  it('serves plain-text instructions for an enrollment link', async () => {
    const res = await app.inject({ method: 'GET', url: '/e/abc123' })
    expect(res.headers['content-type']).toContain('text/plain')
    // Someone opening their link in a browser copies this line straight into a terminal.
    expect(res.body).toContain(`${CLI_COMMAND} enroll http://relay.test/e/abc123`)
  })
})
