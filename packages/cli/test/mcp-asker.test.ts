import { LIMITS, RelayError, type ContactsView, type TicketView } from '@agentbridge/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAskerServer, type AskerApi } from '../src/mcp-asker'

const TICKET = '3b241101-e2bb-4255-8caf-4136c566a962'

class FakeApi implements AskerApi {
  waits: number[] = []
  view: TicketView = {
    ticketId: TICKET, status: 'answered', to: 'dev', question: '¿timeout?', answer: '45 segundos',
    source: 'config/timeouts.yaml', confidence: 'seguro', createdAt: '2026-09-12T10:00:00.000Z',
    answeredAt: '2026-09-12T10:00:16.000Z', latencyMs: 16000,
  }
  failAsk = false
  failNetwork = false
  async contacts(): Promise<ContactsView> {
    return { canAsk: [{ handle: 'dev', displayName: 'Dev Ejemplo', online: true }], canAskMe: [] }
  }
  async ask(to: string, question: string) {
    if (this.failNetwork) throw new TypeError('fetch failed')
    if (this.failAsk) throw new RelayError(403, 'not_allowed', `No tienes permiso para preguntarle a ${to}`)
    expect(question.length).toBeGreaterThan(0)
    return { ticketId: TICKET, status: 'queued' as const }
  }
  async ticket(_id: string, waitSeconds = 0) {
    this.waits.push(waitSeconds)
    return this.view
  }
}

let api: FakeApi
let client: Client
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args })
const text = (r: Awaited<ReturnType<typeof call>>) => (r.content as { text: string }[])[0]!.text

beforeEach(async () => {
  api = new FakeApi()
  const server = createAskerServer(api)
  const [ct, st] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'fake-claude', version: '0.0.0' })
  await Promise.all([server.connect(st), client.connect(ct)])
})

describe('asker MCP server', () => {
  it('exposes list_contacts, ask_contact and check_answer', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['ask_contact', 'check_answer', 'list_contacts'])
  })

  it('lists who you can ask', async () => {
    expect(text(await call('list_contacts'))).toContain('@dev (Dev Ejemplo) en línea')
  })

  it('creates a ticket and returns its id', async () => {
    const r = await call('ask_contact', { contact: '@dev', question: '¿Cuál es el timeout?' })
    expect(r.isError).toBeFalsy()
    expect(text(r)).toContain(`ticket_id: ${TICKET}`)
  })

  it('surfaces relay errors as tool errors', async () => {
    api.failAsk = true
    const r = await call('ask_contact', { contact: 'dev', question: 'q' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('No tienes permiso')
  })

  it('rejects an over-length question in spanish, never with zod\'s own english wording', async () => {
    const r = await call('ask_contact', { contact: 'dev', question: 'x'.repeat(LIMITS.questionMaxChars + 1) })
    expect(r.isError).toBe(true)
    const body = text(r)
    expect(body).toContain('Argumentos inválidos en: question')
    expect(body).not.toContain('Too big')
    expect(body).not.toContain('characters')
  })

  it('surfaces a network failure as the spanish relay-unreachable message, never the raw fetch error', async () => {
    api.failNetwork = true
    const r = await call('ask_contact', { contact: 'dev', question: 'q' })
    expect(r.isError).toBe(true)
    const body = text(r)
    expect(body).toContain('No se pudo conectar con el relay')
    expect(body).not.toContain('fetch failed')
  })

  it('checks an answer with a default wait of 40 s, clamped to 45 s', async () => {
    const first = await call('check_answer', { ticket_id: TICKET })
    expect(text(first)).toContain('45 segundos')
    await call('check_answer', { ticket_id: TICKET, wait_seconds: 300 })
    expect(api.waits).toEqual([40, 45])
  })
})
