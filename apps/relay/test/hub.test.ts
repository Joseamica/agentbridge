import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ResponderHub } from '../src/hub'
import { FakeSocket, insertDevice, insertGrant, insertTicket, insertUser, resetDb, testPool, ticketRow } from './helpers'

let pool: pg.Pool
let hub: ResponderHub
let dev: { id: string; handle: string }
let amieva: { id: string; handle: string }
let devToken: string
let grantId: string

async function connect(token = devToken) {
  const socket = new FakeSocket()
  const conn = hub.handleOpen(socket)
  await hub.handleMessage(conn, JSON.stringify({ type: 'auth', token }))
  return { socket, conn }
}

beforeAll(async () => {
  pool = await testPool()
})
beforeEach(async () => {
  await resetDb(pool)
  hub = new ResponderHub(pool, { authTimeoutMs: 1000 })
  dev = await insertUser(pool, 'dev', 'Dev Ejemplo')
  amieva = await insertUser(pool, 'amieva', 'Amieva')
  devToken = (await insertDevice(pool, dev.id)).token
  grantId = await insertGrant(pool, dev.id, amieva.id)
})
afterAll(async () => {
  await pool.end()
})

const ticketFor = (question: string, createdAt?: Date) =>
  insertTicket(pool, { grantId, askerId: amieva.id, responderId: dev.id, question, createdAt })

describe('ResponderHub', () => {
  it('closes the socket with 4401 when the token is invalid', async () => {
    const { socket } = await connect('x'.repeat(43))
    expect(socket.closed).toEqual({ code: 4401, reason: 'invalid token' })
  })

  it('closes the socket with 4401 when no auth arrives in time', async () => {
    hub = new ResponderHub(pool, { authTimeoutMs: 20 })
    const socket = new FakeSocket()
    hub.handleOpen(socket)
    await new Promise((r) => setTimeout(r, 60))
    expect(socket.closed?.code).toBe(4401)
  })

  it('dispatches exactly one question at a time, oldest first', async () => {
    const first = await ticketFor('primera', new Date(Date.now() - 2000))
    const second = await ticketFor('segunda', new Date(Date.now() - 1000))
    const { socket } = await connect()
    expect(socket.sent[0]).toEqual({ type: 'auth_ok', handle: 'dev' })
    expect(socket.questions()).toHaveLength(1)
    expect(socket.questions()[0]!.question).toBe('primera')
    expect(socket.questions()[0]!.from).toEqual({ handle: 'amieva', displayName: 'Amieva' })
    expect((await ticketRow(pool, first)).status).toBe('dispatched')
    expect((await ticketRow(pool, second)).status).toBe('queued')
    expect(hub.isOnline(dev.id)).toBe(true)
  })

  it('rejects an answer with the wrong code and keeps the ticket dispatched', async () => {
    const id = await ticketFor('q')
    const { socket, conn } = await connect()
    const q = socket.questions()[0]!
    const wrong = q.code === 'AAAA' ? 'BBBB' : 'AAAA'
    await hub.handleMessage(conn, JSON.stringify({ type: 'answer', attemptId: q.attemptId, code: wrong, text: 'x', source: 'y', confidence: 'creo' }))
    expect(socket.sent.at(-1)).toEqual({ type: 'answer_rejected', attemptId: q.attemptId, reason: 'wrong_code' })
    expect((await ticketRow(pool, id)).status).toBe('dispatched')
  })

  it('accepts the right answer, stores it, notifies waiters and dispatches the next question', async () => {
    const first = await ticketFor('primera', new Date(Date.now() - 2000))
    await ticketFor('segunda', new Date(Date.now() - 1000))
    const { socket, conn } = await connect()
    const q = socket.questions()[0]!
    const waiter = hub.waitForTicket(first, 5000)
    await hub.handleMessage(conn, JSON.stringify({ type: 'answer', attemptId: q.attemptId, code: q.code, text: 'Sí, v3.4.2', source: 'CHANGELOG.md', confidence: 'seguro' }))
    await waiter.promise
    const row = await ticketRow(pool, first)
    expect(row.status).toBe('answered')
    expect(row.answer).toBe('Sí, v3.4.2')
    expect(row.answer_source).toBe('CHANGELOG.md')
    expect(row.answer_confidence).toBe('seguro')
    expect(socket.sent).toContainEqual({ type: 'answer_accepted', attemptId: q.attemptId })
    expect(socket.questions()).toHaveLength(2)
    expect(socket.questions()[1]!.question).toBe('segunda')
    expect(socket.questions()[1]!.attemptId).not.toBe(q.attemptId)
  })

  it('requeues the in-flight question on disconnect and redispatches it as a new attempt', async () => {
    const id = await ticketFor('q')
    const a = await connect()
    const firstAttempt = a.socket.questions()[0]!.attemptId
    await hub.handleClose(a.conn)
    expect((await ticketRow(pool, id)).status).toBe('queued')
    expect(hub.isOnline(dev.id)).toBe(false)
    const outcome = await pool.query('select outcome from attempts where id = $1', [firstAttempt])
    expect(outcome.rows[0].outcome).toBe('disconnected')
    const b = await connect()
    expect(b.socket.questions()).toHaveLength(1)
    expect(b.socket.questions()[0]!.attemptId).not.toBe(firstAttempt)
  })

  it('does not dispatch tickets whose grant was revoked', async () => {
    await ticketFor('q')
    await pool.query('update grants set revoked_at = now() where id = $1', [grantId])
    const { socket } = await connect()
    expect(socket.questions()).toHaveLength(0)
  })

  it('closes the older connection with 4000 when the same user connects again', async () => {
    const a = await connect()
    await connect()
    expect(a.socket.closed).toEqual({ code: 4000, reason: 'replaced' })
  })

  it('sends cancel and frees the slot when an attempt is closed by the server', async () => {
    const first = await ticketFor('primera', new Date(Date.now() - 2000))
    await ticketFor('segunda', new Date(Date.now() - 1000))
    const { socket } = await connect()
    const q = socket.questions()[0]!
    await pool.query(`update attempts set closed_at = now(), outcome = 'timeout' where id = $1`, [q.attemptId])
    await pool.query(`update tickets set status = 'expired' where id = $1`, [first])
    await hub.closeAttempt(dev.id, q.attemptId, 'timeout')
    expect(socket.sent).toContainEqual({ type: 'cancel', attemptId: q.attemptId, reason: 'timeout' })
    expect(socket.questions()).toHaveLength(2)
  })

  it('does not register a connection that closed while its token was being checked', async () => {
    await ticketFor('q')
    const socket = new FakeSocket()
    const conn = hub.handleOpen(socket)
    const pending = hub.handleMessage(conn, JSON.stringify({ type: 'auth', token: devToken }))
    await hub.handleClose(conn)
    await pending
    expect(hub.isOnline(dev.id)).toBe(false)
    expect(socket.questions()).toHaveLength(0)
  })

  it('does not process any message once the connection has been marked closed', async () => {
    const socket = new FakeSocket()
    const conn = hub.handleOpen(socket)
    hub.markClosed(conn)
    await hub.handleMessage(conn, JSON.stringify({ type: 'auth', token: devToken }))
    expect(hub.isOnline(dev.id)).toBe(false)
    expect(socket.sent).toEqual([])
  })
})
