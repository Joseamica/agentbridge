import { ServerMessageSchema, type ServerMessage } from '@agentbridge/core'
import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildTestApp, enrollViaApi, resetDb, testPool } from './helpers'

let pool: pg.Pool
let app: FastifyInstance
let url: string

function open(): Promise<{ ws: WebSocket; messages: ServerMessage[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const messages: ServerMessage[] = []
    const closed = new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)))
    ws.addEventListener('message', (e) => messages.push(ServerMessageSchema.parse(JSON.parse(String(e.data)))))
    ws.addEventListener('open', () => resolve({ ws, messages, closed }))
    ws.addEventListener('error', reject)
  })
}

async function until(check: () => boolean, ms = 3000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeAll(async () => {
  pool = await testPool()
})
beforeEach(async () => {
  await resetDb(pool)
  app = (await buildTestApp(pool)).app
  await app.listen({ port: 0, host: '127.0.0.1' })
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/v1/responder`
})
afterEach(async () => {
  await app.close()
})
afterAll(async () => {
  await pool.end()
})

describe('responder websocket', () => {
  it('authenticates with the first message and answers auth_ok', async () => {
    const token = await enrollViaApi(app, 'dev')
    const { ws, messages } = await open()
    ws.send(JSON.stringify({ type: 'auth', token }))
    await until(() => messages.length > 0)
    expect(messages[0]).toEqual({ type: 'auth_ok', handle: 'dev' })
    ws.close()
  })

  it('processes messages in order even when sent back to back', async () => {
    const token = await enrollViaApi(app, 'dev')
    const { ws, messages } = await open()
    const attemptId = '3b241101-e2bb-4255-8caf-4136c566a962'
    ws.send(JSON.stringify({ type: 'auth', token }))
    ws.send(JSON.stringify({ type: 'answer', attemptId, code: 'Q7K2', text: 'x', source: 'y', confidence: 'creo' }))
    await until(() => messages.length >= 2)
    expect(messages.map((m) => m.type)).toEqual(['auth_ok', 'answer_rejected'])
    ws.close()
  })

  it('closes with 4401 when the first message is not a valid auth', async () => {
    const { ws, closed } = await open()
    ws.send(JSON.stringify({ type: 'auth', token: 'x'.repeat(43) }))
    expect(await closed).toBe(4401)
  })
})
