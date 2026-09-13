import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db'
import { insertGrant, insertUser, resetDb, testPool } from './helpers'

let pool: pg.Pool

beforeAll(async () => {
  pool = await testPool()
})
beforeEach(async () => {
  await resetDb(pool)
})
afterAll(async () => {
  await pool.end()
})

describe('database schema', () => {
  it('is idempotent: a second migrate applies nothing', async () => {
    expect(await migrate(pool)).toEqual([])
  })

  it('rejects an invalid handle at the database level', async () => {
    await expect(insertUser(pool, 'Not Valid')).rejects.toThrow(/check constraint/)
  })

  it('allows only one active grant per responder-asker pair', async () => {
    const dev = await insertUser(pool, 'dev')
    const amieva = await insertUser(pool, 'amieva')
    await insertGrant(pool, dev.id, amieva.id)
    await expect(insertGrant(pool, dev.id, amieva.id)).rejects.toThrow(/grants_one_active_per_pair/)
  })

  it('rejects a grant from a user to themselves', async () => {
    const dev = await insertUser(pool, 'dev')
    await expect(insertGrant(pool, dev.id, dev.id)).rejects.toThrow(/check constraint/)
  })

  it('has an index on tickets.created_at to support the retention sweeper', async () => {
    const r = await pool.query(
      "select 1 from pg_indexes where tablename = 'tickets' and indexname = 'tickets_created'",
    )
    expect(r.rows).toHaveLength(1)
  })
})
