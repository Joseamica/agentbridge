import { execFile } from 'node:child_process'
import { mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { DB_FILE, MIGRATIONS, UserFacingError, installSqliteWarningFilter, openStore, type Migration } from '@agentbridge/core'

const run = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '../../..')
const newHome = async () => join(await mkdtemp(join(tmpdir(), 'ab-store-')), 'home')
const counterMigration: Migration = { version: 1, name: 'counter', sql: 'CREATE TABLE counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL); INSERT INTO counter (id, n) VALUES (1, 0);' }

describe('openStore', () => {
  it('creates a private database whose WAL and SHM files are private too', async () => {
    const home = await newHome()
    const store = await openStore(home)
    store.tx(() => store.db.prepare("INSERT INTO cursors (relay, role, day_start, complete, updated_at) VALUES ('wss://a.example.com', 'asker', 0, 0, 1)").run())
    expect((await stat(home)).mode & 0o777).toBe(0o700)
    const files = (await readdir(home)).filter((f) => f.startsWith(DB_FILE))
    expect(files.sort()).toEqual([DB_FILE, `${DB_FILE}-shm`, `${DB_FILE}-wal`])
    for (const f of files) expect((await stat(join(home, f))).mode & 0o777).toBe(0o600)
    store.close()
  })

  it('applies each migration exactly once across reopenings', async () => {
    const home = await newHome()
    const first = await openStore(home)
    const versions = () => first.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version)
    expect(versions()).toEqual(MIGRATIONS.map((m) => m.version))
    first.close()
    const second = await openStore(home)
    expect(second.db.prepare('SELECT count(*) AS n FROM schema_version').get()?.n).toBe(MIGRATIONS.length)
    second.close()
  })

  it('refuses a database written by a newer AgentBridge, in Spanish', async () => {
    const home = await newHome()
    const store = await openStore(home)
    store.db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (999, ?, 1)').run('future')
    store.close()
    const err = await openStore(home).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UserFacingError)
    expect((err as Error).message).toMatch(/versión más nueva/)
  })

  it('uses sanitizeRelayList as the relay policy unless a test injects another one', async () => {
    const store = await openStore(await newHome())
    expect(store.relayPolicy(['ws://127.0.0.1:7777', 'wss://relay.primal.net/'])).toEqual(['wss://relay.primal.net'])
    store.close()
    const permissive = await openStore(await newHome(), { relayPolicy: (xs) => xs.filter((x): x is string => typeof x === 'string') })
    expect(permissive.relayPolicy(['ws://127.0.0.1:7777'])).toEqual(['ws://127.0.0.1:7777'])
    permissive.close()
  })
})

describe('Store.tx', () => {
  it('commits on success and rolls back on a thrown error', async () => {
    const store = await openStore(await newHome(), { migrations: [counterMigration] })
    const read = () => store.db.prepare('SELECT n FROM counter WHERE id = 1').get()?.n
    store.tx(() => store.db.prepare('UPDATE counter SET n = n + 1').run())
    expect(read()).toBe(1)
    expect(() =>
      store.tx(() => {
        store.db.prepare('UPDATE counter SET n = n + 1').run()
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(read()).toBe(1)
    store.close()
  })

  it('joins an outer transaction, so an inner failure rolls back the outer work', async () => {
    const store = await openStore(await newHome(), { migrations: [counterMigration] })
    expect(() =>
      store.tx(() => {
        store.db.prepare('UPDATE counter SET n = 10').run()
        store.tx(() => {
          store.db.prepare('UPDATE counter SET n = 20').run()
          throw new Error('inner')
        })
      }),
    ).toThrow('inner')
    expect(store.db.prepare('SELECT n FROM counter WHERE id = 1').get()?.n).toBe(0)
    store.close()
  })

  it('rejects asynchronous callbacks and rolls back what they started', async () => {
    const store = await openStore(await newHome(), { migrations: [counterMigration] })
    expect(() =>
      store.tx(() => {
        store.db.prepare('UPDATE counter SET n = 5').run()
        return Promise.resolve()
      }),
    ).toThrow(/synchronous/)
    expect(store.db.prepare('SELECT n FROM counter WHERE id = 1').get()?.n).toBe(0)
    store.close()
  })

  it('serializes read-modify-write across processes without losing updates', async () => {
    const home = await newHome()
    ;(await openStore(home, { migrations: [counterMigration] })).close()
    const script = `import { openStore } from ${JSON.stringify(join(repoRoot, 'packages/core/src/store/db.ts'))}
const store = await openStore(${JSON.stringify(home)}, { migrations: ${JSON.stringify([counterMigration])} })
for (let i = 0; i < 50; i++) {
  store.tx(() => {
    const n = store.db.prepare('SELECT n FROM counter WHERE id = 1').get().n
    store.db.prepare('UPDATE counter SET n = ? WHERE id = 1').run(n + 1)
  })
}
store.close()`
    await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: repoRoot })))
    const store = await openStore(home, { migrations: [counterMigration] })
    expect(store.db.prepare('SELECT n FROM counter WHERE id = 1').get()?.n).toBe(200)
    store.close()
  })

  it('lets several processes race openStore from a cold start without losing the lock race', async () => {
    const home = await newHome()
    const script = `import { openStore } from ${JSON.stringify(join(repoRoot, 'packages/core/src/store/db.ts'))}
const store = await openStore(${JSON.stringify(home)}, { migrations: ${JSON.stringify([counterMigration])} })
for (let i = 0; i < 5; i++) {
  store.tx(() => {
    const n = store.db.prepare('SELECT n FROM counter WHERE id = 1').get().n
    store.db.prepare('UPDATE counter SET n = ? WHERE id = 1').run(n + 1)
  })
}
store.close()`
    // No pre-creation here: all 6 processes call openStore on the SAME brand-new home at once, so
    // they race each other to create the file, switch journal_mode to WAL and apply migration 1.
    await Promise.all(
      Array.from({ length: 6 }, () => run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: repoRoot })),
    )
    const store = await openStore(home, { migrations: [counterMigration] })
    expect(store.db.prepare('SELECT n FROM counter WHERE id = 1').get()?.n).toBe(30)
    expect(store.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version)).toEqual([1])
    store.close()
  })
})

describe('installSqliteWarningFilter', () => {
  it('suppresses only the SQLite experimental warning', async () => {
    installSqliteWarningFilter()
    const seen: string[] = []
    const listener = (w: Error) => seen.push(`${w.name}: ${w.message}`)
    // Node prints warnings from its own 'warning' listener. Only this test's listener stays attached
    // while the two warnings are emitted, so the one that passes the filter is observed, not printed.
    const others = process.listeners('warning')
    process.removeAllListeners('warning')
    process.on('warning', listener)
    try {
      process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning')
      process.emitWarning('Something else is experimental', 'ExperimentalWarning')
      await new Promise((r) => setImmediate(r))
    } finally {
      process.off('warning', listener)
      for (const other of others) process.on('warning', other)
    }
    expect(seen).toEqual(['ExperimentalWarning: Something else is experimental'])
  })
})
