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

  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')

  let depth = 0
  const tx = <T>(fn: () => T): T => {
    const guard = (result: T): T => {
      if (result instanceof Promise) throw new Error('Store.tx callbacks must be synchronous')
      return result
    }
    if (depth > 0) return guard(fn())
    db.exec('BEGIN IMMEDIATE')
    depth++
    try {
      const result = guard(fn())
      db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // The transaction was already closed by SQLite (for example after a failed COMMIT).
      }
      throw err
    } finally {
      depth--
    }
  }

  const migrations = [...(options.migrations ?? MIGRATIONS)].sort((a, b) => a.version - b.version)
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
  const newest = db.prepare('SELECT max(version) AS v FROM schema_version').get()?.v
  const known = migrations.at(-1)?.version ?? 0
  if (typeof newest === 'number' && newest > known) {
    db.close()
    throw new UserFacingError(
      `La base de datos de AgentBridge en ${home} es de una versión más nueva. Actualiza con: ${CLI_COMMAND} --help`,
    )
  }
  for (const migration of migrations) {
    tx(() => {
      if (db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(migration.version)) return
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, nowSeconds())
    })
  }

  return { db, path, relayPolicy: options.relayPolicy ?? sanitizeRelayList, tx, close: () => db.close() }
}
