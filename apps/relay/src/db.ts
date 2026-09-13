import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

export type Pool = pg.Pool
export type Db = pg.Pool | pg.PoolClient

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined,
  })
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(
    'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
  )
  const done = new Set(
    (await pool.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
  )
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []
  for (const file of files) {
    if (done.has(file)) continue
    const sql = await readFile(join(dir, file), 'utf8')
    await withTx(pool, async (c) => {
      await c.query(sql)
      await c.query('insert into schema_migrations (name) values ($1)', [file])
    })
    applied.push(file)
  }
  return applied
}
