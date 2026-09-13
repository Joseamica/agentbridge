import type { TicketView } from '@agentbridge/core'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { ResponderHub } from '../../../apps/relay/src/hub'
import { ADMIN_TOKEN, FakeSocket, buildListeningApp, resetDb, testPool } from '../../../apps/relay/test/helpers'
import { formatTicket } from '../src/commands/ask'
import { memoryOutput, type CliContext } from '../src/context'
import { run } from '../src/router'

let pool: pg.Pool
let app: FastifyInstance
let hub: ResponderHub
let relayUrl: string

beforeAll(async () => {
  pool = await testPool()
})
beforeEach(async () => {
  await resetDb(pool)
  ;({ app, hub, relayUrl } = await buildListeningApp(pool))
})
afterEach(async () => {
  await app.close()
})
afterAll(async () => {
  await pool.end()
})

async function person(handle: string, name: string) {
  const admin: CliContext & { out: ReturnType<typeof memoryOutput> } = { home: await mkdtemp(join(tmpdir(), 'ab-adm-')), out: memoryOutput(), env: {} }
  await run(['admin', 'enroll-link', '--handle', handle, '--name', name, '--relay', relayUrl, '--admin-token', ADMIN_TOKEN], admin)
  const link = admin.out.lines.join('\n').match(/agentbridge enroll (\S+)/)![1]!
  const ctx: CliContext & { out: ReturnType<typeof memoryOutput> } = { home: await mkdtemp(join(tmpdir(), 'ab-cli-')), out: memoryOutput(), env: {} }
  expect(await run(['enroll', link], ctx)).toBe(0)
  return ctx
}

const base: TicketView = {
  ticketId: '3b241101-e2bb-4255-8caf-4136c566a962', status: 'queued', to: 'dev', question: 'q', answer: null,
  source: null, confidence: null, createdAt: '2026-09-12T10:00:00.000Z', answeredAt: null, latencyMs: null,
}

describe('formatTicket', () => {
  it('describes every status in Spanish', () => {
    expect(formatTicket(base)).toContain('En cola')
    expect(formatTicket({ ...base, status: 'dispatched' })).toContain('la está contestando')
    expect(formatTicket({ ...base, status: 'expired' })).toContain('Expiró')
    expect(formatTicket({ ...base, status: 'cancelled' })).toContain('retiró el permiso')
    expect(formatTicket({ ...base, status: 'answered', answer: '45 s', source: 'a.yaml', confidence: 'seguro', latencyMs: 16_400 }))
      .toBe('@dev contestó (16 s):\n\n45 s\n\nFuente: a.yaml\nConfianza: seguro')
  })
})

describe('agentbridge ask', () => {
  it('sends a question and prints the answer when the responder replies', async () => {
    const dev = await person('dev', 'Dev Ejemplo')
    const amieva = await person('amieva', 'Amieva')
    await run(['invite'], dev)
    await run(['accept', dev.out.lines.join('\n').match(/agentbridge accept (\S+)/)![1]!], amieva)

    const socket = new FakeSocket()
    const conn = hub.handleOpen(socket)
    const devToken = JSON.parse(await readFile(join(dev.home, 'config.json'), 'utf8')).deviceToken
    await hub.handleMessage(conn, JSON.stringify({ type: 'auth', token: devToken }))

    const pending = run(['ask', 'dev', '¿Cuál', 'es', 'el', 'timeout?', '--wait', '20'], amieva)
    const start = Date.now()
    while (socket.questions().length === 0) {
      if (Date.now() - start > 5000) throw new Error('question never dispatched')
      await new Promise((r) => setTimeout(r, 20))
    }
    const q = socket.questions()[0]!
    expect(q.question).toBe('¿Cuál es el timeout?')
    await hub.handleMessage(conn, JSON.stringify({ type: 'answer', attemptId: q.attemptId, code: q.code, text: '45 segundos', source: 'config/timeouts.yaml', confidence: 'seguro' }))

    expect(await pending).toBe(0)
    const output = amieva.out.lines.join('\n')
    expect(output).toContain('ticket_id:')
    expect(output).toContain('@dev contestó')
    expect(output).toContain('45 segundos')
  })

  it('returns the ticket id immediately with --no-wait', async () => {
    const dev = await person('dev', 'Dev')
    const amieva = await person('amieva', 'Amieva')
    await run(['invite'], dev)
    await run(['accept', dev.out.lines.join('\n').match(/agentbridge accept (\S+)/)![1]!], amieva)
    expect(await run(['ask', 'dev', 'hola', '--no-wait'], amieva)).toBe(0)
    expect(amieva.out.lines.join('\n')).toMatch(/ticket_id: [0-9a-f-]{36}/)
  })
})

describe('agentbridge ticket', () => {
  it('requires a ticket_id', async () => {
    const amieva = await person('amieva', 'Amieva')
    expect(await run(['ticket'], amieva)).toBe(1)
    expect(amieva.out.errors.join('\n')).toContain('Uso: agentbridge ticket <ticket_id>')
  })

  it('rejects a non-numeric --wait locally, before any request to the relay', async () => {
    const amieva = await person('amieva', 'Amieva')
    expect(await run(['ticket', '3b241101-e2bb-4255-8caf-4136c566a962', '--wait', 'abc'], amieva)).toBe(1)
    expect(amieva.out.errors.join('\n')).toContain('--wait debe ser un número de segundos')
  })

  it('checks a ticket with the default --wait 0 (a single, immediate poll)', async () => {
    const dev = await person('dev', 'Dev')
    const amieva = await person('amieva', 'Amieva')
    await run(['invite'], dev)
    await run(['accept', dev.out.lines.join('\n').match(/agentbridge accept (\S+)/)![1]!], amieva)
    expect(await run(['ask', 'dev', 'hola', '--no-wait'], amieva)).toBe(0)
    const ticketId = amieva.out.lines.join('\n').match(/ticket_id: (\S+)/)![1]!

    expect(await run(['ticket', ticketId], amieva)).toBe(0)
    expect(amieva.out.lines.join('\n')).toContain('En cola')
  })

  it('polls the real relay until the responder answers, when --wait is given', async () => {
    const dev = await person('dev', 'Dev Ejemplo')
    const amieva = await person('amieva', 'Amieva')
    await run(['invite'], dev)
    await run(['accept', dev.out.lines.join('\n').match(/agentbridge accept (\S+)/)![1]!], amieva)
    expect(await run(['ask', 'dev', 'hola', '--no-wait'], amieva)).toBe(0)
    const ticketId = amieva.out.lines.join('\n').match(/ticket_id: (\S+)/)![1]!

    const socket = new FakeSocket()
    const conn = hub.handleOpen(socket)
    const devToken = JSON.parse(await readFile(join(dev.home, 'config.json'), 'utf8')).deviceToken
    await hub.handleMessage(conn, JSON.stringify({ type: 'auth', token: devToken }))

    const pending = run(['ticket', ticketId, '--wait', '20'], amieva)
    const start = Date.now()
    while (socket.questions().length === 0) {
      if (Date.now() - start > 5000) throw new Error('question never dispatched')
      await new Promise((r) => setTimeout(r, 20))
    }
    const q = socket.questions()[0]!
    await hub.handleMessage(conn, JSON.stringify({ type: 'answer', attemptId: q.attemptId, code: q.code, text: '45 segundos', source: 'config/timeouts.yaml', confidence: 'seguro' }))

    expect(await pending).toBe(0)
    expect(amieva.out.lines.join('\n')).toContain('@dev contestó')
  })
})
