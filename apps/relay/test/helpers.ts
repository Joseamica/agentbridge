import { ServerMessageSchema, hashSecret, newSecret, type ServerMessage, type TicketStatus } from '@agentbridge/core'
import type { FastifyInstance } from 'fastify'
import { createServer, type AddressInfo } from 'node:net'
import type pg from 'pg'
import { buildApp } from '../src/app'
import { createPool, migrate } from '../src/db'
import type { ResponderSocket } from '../src/hub'

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/agentbridge_test'

export async function testPool(): Promise<pg.Pool> {
  const pool = createPool(TEST_DATABASE_URL)
  await migrate(pool)
  return pool
}

export async function resetDb(pool: pg.Pool): Promise<void> {
  await pool.query(
    'truncate events, attempts, tickets, grants, contact_invites, devices, enrollments, users restart identity cascade',
  )
}

export async function insertUser(pool: pg.Pool, handle: string, displayName = handle) {
  const r = await pool.query<{ id: string }>(
    'insert into users (handle, display_name) values ($1, $2) returning id',
    [handle, displayName],
  )
  return { id: r.rows[0]!.id, handle }
}

export async function insertDevice(pool: pg.Pool, userId: string) {
  const token = newSecret()
  const r = await pool.query<{ id: string }>(
    'insert into devices (user_id, name, token_hash) values ($1, $2, $3) returning id',
    [userId, 'test-device', hashSecret(token)],
  )
  return { id: r.rows[0]!.id, token }
}

export async function insertGrant(pool: pg.Pool, responderId: string, askerId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    'insert into grants (responder_id, asker_id) values ($1, $2) returning id',
    [responderId, askerId],
  )
  return r.rows[0]!.id
}

export async function insertTicket(
  pool: pg.Pool,
  t: {
    grantId: string
    askerId: string
    responderId: string
    question?: string
    status?: TicketStatus
    createdAt?: Date
    expiresAt?: Date
  },
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `insert into tickets (grant_id, asker_id, responder_id, question, status, created_at, expires_at)
     values ($1, $2, $3, $4, $5, coalesce($6, now()), coalesce($7, now() + interval '1 day'))
     returning id`,
    [t.grantId, t.askerId, t.responderId, t.question ?? 'pregunta de prueba', t.status ?? 'queued', t.createdAt ?? null, t.expiresAt ?? null],
  )
  return r.rows[0]!.id
}

export async function ticketRow(pool: pg.Pool, id: string): Promise<Record<string, unknown>> {
  const r = await pool.query('select * from tickets where id = $1', [id])
  return r.rows[0] as Record<string, unknown>
}

export const ADMIN_TOKEN = 'admin-token-for-tests-0123456789abcdef'
export const PUBLIC_URL = 'http://relay.test'

export function authHeader(token: string) {
  return { authorization: `Bearer ${token}` }
}

export async function buildTestApp(pool: pg.Pool) {
  return buildApp({ pool, publicUrl: PUBLIC_URL, adminToken: ADMIN_TOKEN })
}

export async function enrollViaApi(app: FastifyInstance, handle: string, displayName = handle): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/admin/enrollments',
    headers: authHeader(ADMIN_TOKEN),
    payload: { handle, displayName },
  })
  const code = (created.json() as { enrollUrl: string }).enrollUrl.split('/').pop()!
  const enrolled = await app.inject({ method: 'POST', url: '/v1/enroll', payload: { code, deviceName: `${handle}-laptop` } })
  return (enrolled.json() as { deviceToken: string }).deviceToken
}

export class FakeSocket implements ResponderSocket {
  sent: ServerMessage[] = []
  closed: { code: number; reason: string } | null = null
  send(data: string) {
    this.sent.push(ServerMessageSchema.parse(JSON.parse(data)))
  }
  close(code: number, reason: string) {
    this.closed = { code, reason }
  }
  questions() {
    return this.sent.filter((m): m is Extract<ServerMessage, { type: 'question' }> => m.type === 'question')
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

const LISTEN_ATTEMPTS = 5

// freePort() -> listen() is inherently TOCTOU: something else (another process, or a
// parallel vitest worker also calling freePort) can grab the port in between. buildApp()
// needs publicUrl before listen(), so we cannot bind first and compute the URL after.
// Instead, retry the whole build+listen a few times on EADDRINUSE, always closing the
// half-built app from the failed attempt so nothing leaks.
export async function buildListeningApp(pool: pg.Pool) {
  let lastError: unknown
  for (let attempt = 0; attempt < LISTEN_ATTEMPTS; attempt++) {
    const port = await freePort()
    const relayUrl = `http://127.0.0.1:${port}`
    const built = await buildApp({ pool, publicUrl: relayUrl, adminToken: ADMIN_TOKEN })
    try {
      await built.app.listen({ port, host: '127.0.0.1' })
      return { ...built, relayUrl }
    } catch (err) {
      await built.app.close()
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
      lastError = err
    }
  }
  throw new Error(`buildListeningApp: could not bind a free port after ${LISTEN_ATTEMPTS} attempts`, { cause: lastError })
}
