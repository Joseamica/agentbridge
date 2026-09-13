import { hashSecret } from '@agentbridge/core'
import type { Pool } from './db'

export type Principal = { userId: string; deviceId: string; handle: string; displayName: string }

export async function authenticateToken(pool: Pool, token: string | undefined): Promise<Principal | null> {
  if (!token || token.length < 20) return null
  const r = await pool.query<{ device_id: string; user_id: string; handle: string; display_name: string }>(
    `select d.id as device_id, u.id as user_id, u.handle, u.display_name
       from devices d join users u on u.id = d.user_id
      where d.token_hash = $1 and d.revoked_at is null`,
    [hashSecret(token)],
  )
  const row = r.rows[0]
  return row ? { userId: row.user_id, deviceId: row.device_id, handle: row.handle, displayName: row.display_name } : null
}
