import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ResponderHub } from '../src/hub'
import { recoverOrphanedAttempts, sweep } from '../src/sweeper'
import { FakeSocket, insertDevice, insertGrant, insertTicket, insertUser, resetDb, testPool, ticketRow } from './helpers'

let pool: pg.Pool
let hub: ResponderHub
let ids: { dev: string; amieva: string; grant: string; devToken: string }

beforeAll(async () => {
  pool = await testPool()
})
beforeEach(async () => {
  await resetDb(pool)
  hub = new ResponderHub(pool)
  const dev = await insertUser(pool, 'dev')
  const amieva = await insertUser(pool, 'amieva')
  ids = { dev: dev.id, amieva: amieva.id, grant: await insertGrant(pool, dev.id, amieva.id), devToken: (await insertDevice(pool, dev.id)).token }
})
afterAll(async () => {
  await pool.end()
})

describe('sweep', () => {
  it('times out an attempt past its deadline, cancels it on the channel and dispatches the next ticket', async () => {
    const first = await insertTicket(pool, { grantId: ids.grant, askerId: ids.amieva, responderId: ids.dev, question: 'uno', createdAt: new Date(Date.now() - 2000) })
    await insertTicket(pool, { grantId: ids.grant, askerId: ids.amieva, responderId: ids.dev, question: 'dos', createdAt: new Date(Date.now() - 1000) })
    const socket = new FakeSocket()
    const conn = hub.handleOpen(socket)
    await hub.handleMessage(conn, JSON.stringify({ type: 'auth', token: ids.devToken }))
    const q = socket.questions()[0]!
    await pool.query(`update attempts set deadline_at = now() - interval '1 second' where id = $1`, [q.attemptId])

    const waiter = hub.waitForTicket(first, 3000)
    const result = await sweep(pool, hub)
    await waiter.promise

    expect(result.timedOut).toBe(1)
    expect((await ticketRow(pool, first)).status).toBe('expired')
    expect(socket.sent).toContainEqual({ type: 'cancel', attemptId: q.attemptId, reason: 'timeout' })
    expect(socket.questions()).toHaveLength(2)
    expect(socket.questions()[1]!.question).toBe('dos')
  })

  it('expires queued tickets past their TTL', async () => {
    const id = await insertTicket(pool, { grantId: ids.grant, askerId: ids.amieva, responderId: ids.dev, expiresAt: new Date(Date.now() - 1000) })
    expect((await sweep(pool, hub)).expired).toBe(1)
    expect((await ticketRow(pool, id)).status).toBe('expired')
  })

  it('purges ticket content after 7 days and audit events after 30 days', async () => {
    const old = await insertTicket(pool, { grantId: ids.grant, askerId: ids.amieva, responderId: ids.dev, status: 'answered', createdAt: new Date(Date.now() - 8 * 86_400_000) })
    const recent = await insertTicket(pool, { grantId: ids.grant, askerId: ids.amieva, responderId: ids.dev, status: 'answered' })
    await pool.query(`insert into events (kind, at) values ('viejo', now() - interval '31 days'), ('nuevo', now())`)

    expect((await sweep(pool, hub)).purged).toBe(1)
    expect(await ticketRow(pool, old)).toBeUndefined()
    expect(await ticketRow(pool, recent)).toBeDefined()
    const kinds = (await pool.query<{ kind: string }>('select kind from events')).rows.map((r) => r.kind)
    expect(kinds).toContain('nuevo')
    expect(kinds).not.toContain('viejo')
  })
})

describe('recoverOrphanedAttempts', () => {
  async function openAttempt(ticketId: string, code: string): Promise<string> {
    const device = await insertDevice(pool, ids.dev)
    const r = await pool.query<{ id: string }>(
      `insert into attempts (ticket_id, device_id, code, deadline_at)
       values ($1, $2, $3, now() + interval '10 minutes') returning id`,
      [ticketId, device.id, code],
    )
    return r.rows[0]!.id
  }

  it('closes an orphaned attempt and requeues its still-live ticket, recording a requeued event', async () => {
    const ticketId = await insertTicket(pool, { grantId: ids.grant, askerId: ids.amieva, responderId: ids.dev, status: 'dispatched' })
    const attemptId = await openAttempt(ticketId, 'ABCD')

    const requeued = await recoverOrphanedAttempts(pool)

    expect(requeued).toBe(1)
    expect((await ticketRow(pool, ticketId)).status).toBe('queued')
    const attempt = await pool.query<{ outcome: string; closed_at: Date | null }>('select outcome, closed_at from attempts where id = $1', [attemptId])
    expect(attempt.rows[0]!.outcome).toBe('disconnected')
    expect(attempt.rows[0]!.closed_at).not.toBeNull()

    const events = await pool.query<{ ticket_id: string; detail: { attemptId: string; reason: string } }>(
      `select ticket_id, detail from events where kind = 'requeued'`,
    )
    expect(events.rows).toHaveLength(1)
    expect(events.rows[0]!.ticket_id).toBe(ticketId)
    expect(events.rows[0]!.detail).toEqual({ attemptId, reason: 'startup_recovery' })
  })

  it('closes an orphaned attempt without requeuing a ticket that has already expired', async () => {
    const ticketId = await insertTicket(pool, {
      grantId: ids.grant,
      askerId: ids.amieva,
      responderId: ids.dev,
      status: 'dispatched',
      expiresAt: new Date(Date.now() - 1000),
    })
    const attemptId = await openAttempt(ticketId, 'WXYZ')

    const requeued = await recoverOrphanedAttempts(pool)

    expect(requeued).toBe(0)
    expect((await ticketRow(pool, ticketId)).status).toBe('dispatched')
    const attempt = await pool.query<{ outcome: string }>('select outcome from attempts where id = $1', [attemptId])
    expect(attempt.rows[0]!.outcome).toBe('disconnected')
  })
})
