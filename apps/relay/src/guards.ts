import { safeEqual } from '@agentbridge/core'
import type { FastifyRequest } from 'fastify'
import { authenticateToken, type Principal } from './auth'
import type { Pool } from './db'
import { HttpError } from './errors'

function bearer(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return undefined
  return header.slice('Bearer '.length).trim()
}

export async function requireDevice(pool: Pool, req: FastifyRequest): Promise<Principal> {
  const principal = await authenticateToken(pool, bearer(req))
  if (!principal) throw new HttpError(401, 'unauthorized', 'Credencial de dispositivo inválida o revocada')
  return principal
}

export function requireAdmin(adminToken: string, req: FastifyRequest): void {
  const token = bearer(req)
  if (!token || !safeEqual(token, adminToken)) {
    throw new HttpError(401, 'unauthorized', 'Credencial de administrador inválida')
  }
}
