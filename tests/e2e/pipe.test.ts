import { RelayHttpClient } from '@agentbridge/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { authHeader, buildListeningApp, enrollViaApi, resetDb, testPool } from '../../apps/relay/test/helpers'
import { createChannelServer } from '../../packages/channel/src/channel'
import { RelayWsClient } from '../../packages/channel/src/relay-client'
import { createAskerServer } from '../../packages/cli/src/mcp-asker'

type Note = { method: string; params: { content: string; meta: Record<string, string> } }

async function until<T>(get: () => T | undefined, ms = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

// Client.callTool()'s declared return type is CompatibilityCallToolResult, a union that
// also includes the pre-2024-11-05 `{ toolResult: unknown }` shape with no `content` field
// at all. Every server in this codebase replies with the modern `content`-array shape, so
// asserting `content` is present (rather than typing textOf to tolerate the legacy shape
// and silently returning something meaningless) is the correct strictness here, not a
// weakened assertion.
type ToolCallResult = Awaited<ReturnType<Client['callTool']>>
const textOf = (r: ToolCallResult): string => {
  if (!('content' in r)) throw new Error('tool result had no content (legacy toolResult shape)')
  return (r.content as { text: string }[])[0]!.text
}

let pool: pg.Pool
let app: FastifyInstance
let relayUrl: string
let responderRelay: RelayWsClient
let responderClaude: Client
let askerClaude: Client
let notes: Note[]
let devToken: string

beforeAll(async () => {
  pool = await testPool()
})

beforeEach(async () => {
  await resetDb(pool)
  ;({ app, relayUrl } = await buildListeningApp(pool))
  devToken = await enrollViaApi(app, 'dev', 'Dev Ejemplo')
  const amievaToken = await enrollViaApi(app, 'amieva', 'Amieva')
  const inv = await app.inject({ method: 'POST', url: '/v1/contact-invites', headers: authHeader(devToken) })
  const code = (inv.json() as { acceptUrl: string }).acceptUrl.split('/').pop()!
  await app.inject({ method: 'POST', url: '/v1/contact-invites/accept', headers: authHeader(amievaToken), payload: { code } })

  let connected = false
  responderRelay = new RelayWsClient({ relayUrl, token: devToken, log: () => {} })
  responderRelay.onConnected(() => (connected = true))
  const { server: channel } = createChannelServer(responderRelay)
  const [rc, rs] = InMemoryTransport.createLinkedPair()
  responderClaude = new Client({ name: 'responder-claude', version: '0.0.0' })
  notes = []
  responderClaude.fallbackNotificationHandler = async (n) => {
    notes.push(n as unknown as Note)
  }
  await Promise.all([channel.connect(rs), responderClaude.connect(rc)])
  responderRelay.start()
  await until(() => (connected ? true : undefined))

  const asker = createAskerServer(new RelayHttpClient({ relayUrl, token: amievaToken }))
  const [ac, as] = InMemoryTransport.createLinkedPair()
  askerClaude = new Client({ name: 'asker-claude', version: '0.0.0' })
  await Promise.all([asker.connect(as), askerClaude.connect(ac)])
})

afterEach(async () => {
  responderRelay.stop()
  // Client.close() closes its own end of the InMemoryTransport pair, which cascades to close
  // the linked (server-side) end too — closing both clients therefore tears down all four
  // transport endpoints (responder + asker, client + server side of each) instead of leaking
  // them across tests.
  await Promise.all([responderClaude.close(), askerClaude.close()])
  await app.close()
})

afterAll(async () => {
  await pool.end()
})

async function askDev(question: string): Promise<string> {
  const r = await askerClaude.callTool({ name: 'ask_contact', arguments: { contact: '@dev', question } })
  return textOf(r).match(/ticket_id: ([0-9a-f-]{36})/)![1]!
}

const questionNotes = () => notes.filter((n) => n.params.meta.event !== 'cancelled')

describe('end-to-end pipe', () => {
  it('delivers a question to the responder session and the answer back to the asker', async () => {
    const ticketId = await askDev('¿Cuál es el timeout de lectura de tarjeta?')
    const note = await until(() => questionNotes()[0])
    expect(note.method).toBe('notifications/claude/channel')
    expect(note.params.content).toBe('¿Cuál es el timeout de lectura de tarjeta?')
    expect(note.params.meta.from_handle).toBe('amieva')

    const wrong = await responderClaude.callTool({ name: 'reply', arguments: { code: 'ZZZZ', answer: 'x', source: 'y', confidence: 'creo' } })
    expect(wrong.isError).toBe(true)
    expect(textOf(wrong)).toContain(note.params.meta.code)

    const ok = await responderClaude.callTool({
      name: 'reply',
      arguments: { code: note.params.meta.code, answer: '60 segundos', source: 'config/timeouts.yaml', confidence: 'seguro' },
    })
    expect(textOf(ok)).toBe('Respuesta entregada a Amieva.')

    const check = await askerClaude.callTool({ name: 'check_answer', arguments: { ticket_id: ticketId, wait_seconds: 10 } })
    expect(textOf(check)).toContain('60 segundos')
    expect(textOf(check)).toContain('Confianza: seguro')
  })

  it('keeps answers on the right ticket across a responder reconnect', async () => {
    const ticketId = await askDev('¿Ya quedó el fix?')
    const first = await until(() => questionNotes()[0])

    responderRelay.stop()
    await until(() => notes.find((n) => n.params.meta.event === 'cancelled'))
    responderRelay.start()
    const second = await until(() => questionNotes()[1])
    expect(second.params.content).toBe('¿Ya quedó el fix?')

    if (second.params.meta.code !== first.params.meta.code) {
      const late = await responderClaude.callTool({ name: 'reply', arguments: { code: first.params.meta.code, answer: 'tarde', source: 'x', confidence: 'creo' } })
      expect(textOf(late)).toContain('cancelada')
    }
    await responderClaude.callTool({ name: 'reply', arguments: { code: second.params.meta.code, answer: 'Sí, v3.4.2', source: 'CHANGELOG.md', confidence: 'seguro' } })
    const check = await askerClaude.callTool({ name: 'check_answer', arguments: { ticket_id: ticketId, wait_seconds: 10 } })
    expect(textOf(check)).toContain('Sí, v3.4.2')
  })

  it('stops a revoked asker at the relay', async () => {
    await app.inject({ method: 'DELETE', url: '/v1/grants/amieva', headers: authHeader(devToken) })
    const r = await askerClaude.callTool({ name: 'ask_contact', arguments: { contact: 'dev', question: '¿sigo teniendo permiso?' } })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('No tienes permiso')
  })
})
