import { chmod, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { UserFacingError } from '../errors'
import { nowSeconds } from '../nostr-constants'
import { CLI_COMMAND } from '../published'
import { sanitizeRelayList } from '../relay-url'
import { MIGRATIONS, type Migration } from './schema'

export { MIGRATIONS, type Migration } from './schema'

export const DB_FILE = 'agentbridge.db'

export type RelayPolicy = (inputs: readonly unknown[]) => string[]

export type Store = {
  readonly db: DatabaseSync
  readonly path: string
  readonly relayPolicy: RelayPolicy
  tx<T>(fn: () => T): T
  close(): void
}

let warningFilterInstalled = false

// Node prints an ExperimentalWarning the first time node:sqlite loads on some versions. It would
// land in the middle of Spanish CLI output. Only that exact warning is dropped.
export function installSqliteWarningFilter(): void {
  if (warningFilterInstalled) return
  warningFilterInstalled = true
  const original = process.emitWarning.bind(process) as (...args: unknown[]) => void
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message
    const first = rest[0]
    const type =
      typeof first === 'string' ? first : ((first as { type?: string } | undefined)?.type ?? (warning instanceof Error ? warning.name : undefined))
    if (type === 'ExperimentalWarning' && /sqlite/i.test(message)) return
    original(warning, ...rest)
  }) as typeof process.emitWarning
}

// SQLite's own busy handler (armed by the `PRAGMA busy_timeout` below) does not reliably cover
// the one-time transition of a brand-new file into WAL mode: when several connections race that
// exact transition, one wins and the rest can still see a bare `SQLITE_BUSY` ("database is
// locked") from the `journal_mode = WAL` statement itself, instead of the handler retrying it
// for them. Verified by reproduction (see task-4-report.md): even with busy_timeout set as the
// very first statement on the connection, a 6-process cold start still hit this exact error at
// that exact statement in roughly 1 run in 6. The fix below retries the whole open-and-migrate
// sequence — closing and recreating the connection — only for that specific, transient error.
const isTransientLockError = (err: unknown): boolean =>
  err instanceof Error && (err as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR' && /database is locked/i.test(err.message)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function openStore(
  home: string,
  options: { migrations?: readonly Migration[]; relayPolicy?: RelayPolicy } = {},
): Promise<Store> {
  installSqliteWarningFilter()
  const { DatabaseSync } = await import('node:sqlite')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await chmod(home, 0o700)
  const path = join(home, DB_FILE)
  // SQLite creates the -wal and -shm files with the main file's permissions, so the main file
  // exists as 0600 before SQLite ever opens it.
  const handle = await open(path, 'a', 0o600)
  await handle.close()
  await chmod(path, 0o600)

  const migrations = [...(options.migrations ?? MIGRATIONS)].sort((a, b) => a.version - b.version)
  const known = migrations.at(-1)?.version ?? 0

  const maxAttempts = 25
  for (let attempt = 1; ; attempt++) {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(path)
      const conn = db
      // busy_timeout must be the very first statement on a new connection: SQLite's default
      // timeout is 0, so any earlier statement (journal_mode included) that meets another
      // process's lock fails immediately with SQLITE_BUSY instead of waiting. Several processes
      // (CLI, MCP server, channel) open this same file concurrently, so this ordering is
      // load-bearing — it is necessary, though (see above) not sufficient on its own.
      conn.exec('PRAGMA busy_timeout = 5000;')
      conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')

      let depth = 0
      const tx = <T>(fn: () => T): T => {
        const guard = (result: T): T => {
          if (result instanceof Promise) throw new Error('Store.tx callbacks must be synchronous')
          return result
        }
        if (depth > 0) return guard(fn())
        conn.exec('BEGIN IMMEDIATE')
        depth++
        try {
          const result = guard(fn())
          conn.exec('COMMIT')
          return result
        } catch (err) {
          try {
            conn.exec('ROLLBACK')
          } catch {
            // The transaction was already closed by SQLite (for example after a failed COMMIT).
          }
          throw err
        } finally {
          depth--
        }
      }

      conn.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
      const newest = conn.prepare('SELECT max(version) AS v FROM schema_version').get()?.v
      if (typeof newest === 'number' && newest > known) {
        conn.close()
        throw new UserFacingError(
          `La base de datos de AgentBridge en ${home} es de una versión más nueva. Actualiza con: ${CLI_COMMAND} --help`,
        )
      }
      for (const migration of migrations) {
        tx(() => {
          if (conn.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(migration.version)) return
          conn.exec(migration.sql)
          conn.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, nowSeconds())
        })
      }

      return { db: conn, path, relayPolicy: options.relayPolicy ?? sanitizeRelayList, tx, close: () => conn.close() }
    } catch (err) {
      if (db) {
        try {
          db.close()
        } catch {
          // Already closed, or broken beyond closing cleanly (for example mid-failed-pragma) —
          // there is nothing more to release.
        }
      }
      if (!isTransientLockError(err) || attempt >= maxAttempts) throw err
      await sleep(Math.min(20 * attempt, 200))
    }
  }
}
