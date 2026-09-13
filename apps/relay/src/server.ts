import { buildApp } from './app'
import { createPool, migrate } from './db'
import { recoverOrphanedAttempts, startSweeper } from './sweeper'

function required(name: string, value = process.env[name]): string {
  if (!value) {
    console.error(`[relay] missing required environment variable ${name}`)
    process.exit(1)
  }
  return value
}

const databaseUrl = required('DATABASE_URL')
const adminToken = required('ADMIN_TOKEN')
if (adminToken.length < 32) {
  console.error('[relay] ADMIN_TOKEN must be at least 32 characters')
  process.exit(1)
}
const publicUrl = required('PUBLIC_URL', process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL)

const pool = createPool(databaseUrl)
const applied = await migrate(pool)
if (applied.length > 0) console.log(`[relay] migrations applied: ${applied.join(', ')}`)

const requeued = await recoverOrphanedAttempts(pool)
if (requeued > 0) console.log(`[relay] requeued ${requeued} orphaned question(s)`)

const { app, hub } = await buildApp({ pool, publicUrl, adminToken, logger: true })
const stopSweeper = startSweeper(pool, hub)
await app.listen({ port: Number(process.env.PORT ?? 8080), host: '0.0.0.0' })

async function shutdown() {
  stopSweeper()
  await app.close()
  await pool.end()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
