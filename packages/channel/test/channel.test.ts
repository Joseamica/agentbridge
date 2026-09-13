import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { createChannelServer } from '../src/channel'
import type { AnswerPayload, CancelMessage, QuestionMessage, RelayConnection } from '../src/relay-client'

class FakeRelay implements RelayConnection {
  answers: AnswerPayload[] = []
  result: 'accepted' | 'rejected' = 'accepted'
  private q: ((m: QuestionMessage) => void)[] = []
  private c: ((m: CancelMessage) => void)[] = []
  private d: (() => void)[] = []
  onQuestion(fn: (m: QuestionMessage) => void) {
    this.q.push(fn)
  }
  onCancel(fn: (m: CancelMessage) => void) {
    this.c.push(fn)
  }
  onDisconnect(fn: () => void) {
    this.d.push(fn)
  }
  async sendAnswer(a: AnswerPayload) {
    this.answers.push(a)
    return this.result
  }
  question(code: string, attemptId = `3b241101-e2bb-4255-8caf-4136c566a9${code === 'BBBB' ? '63' : '62'}`) {
    const m: QuestionMessage = { type: 'question', attemptId, code, from: { handle: 'amieva', displayName: 'Amieva' }, question: '¿Ya quedó el fix?' }
    this.q.forEach((fn) => fn(m))
    return m
  }
  cancel(attemptId: string) {
    this.c.forEach((fn) => fn({ type: 'cancel', attemptId, reason: 'timeout' }))
  }
  disconnect() {
    this.d.forEach((fn) => fn())
  }
}

type Note = { method: string; params?: { content?: string; meta?: Record<string, string> } }

async function until(check: () => boolean, ms = 2000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

let relay: FakeRelay
let client: Client
let notes: Note[]

const reply = (args: Record<string, unknown>) => client.callTool({ name: 'reply', arguments: args })
const textOf = (r: Awaited<ReturnType<typeof reply>>) => (r.content as { text: string }[])[0]!.text

beforeEach(async () => {
  relay = new FakeRelay()
  const { server } = createChannelServer(relay)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'fake-claude', version: '0.0.0' })
  notes = []
  client.fallbackNotificationHandler = async (n) => {
    notes.push(n as Note)
  }
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

describe('channel MCP server', () => {
  it('declares the channel capability without permission relay and explains the reply tool', () => {
    const caps = client.getServerCapabilities()
    expect(caps?.experimental?.['claude/channel']).toEqual({})
    expect(caps?.experimental?.['claude/channel/permission']).toBeUndefined()
    expect(client.getInstructions()).toContain('reply')
  })

  it('exposes only the reply tool', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['reply'])
  })

  it('pushes a question into the session with identifier-only meta keys', async () => {
    relay.question('Q7K2')
    await until(() => notes.length === 1)
    // Note: SDK 1.30.0 delivers the raw JSON-RPC envelope (adds `jsonrpc: "2.0"`) to
    // fallbackNotificationHandler, so we assert on method/params rather than the whole object.
    expect(notes[0]!.method).toBe('notifications/claude/channel')
    expect(notes[0]!.params).toEqual({ content: '¿Ya quedó el fix?', meta: { code: 'Q7K2', from_handle: 'amieva', from_name: 'Amieva' } })
    for (const key of Object.keys(notes[0]!.params!.meta!)) expect(key).toMatch(/^[A-Za-z0-9_]+$/)
  })

  it('rejects a mistyped code, names the active code and sends nothing', async () => {
    relay.question('Q7K2')
    const r = await reply({ code: 'Q7KK', answer: 'sí', source: 'CHANGELOG.md', confidence: 'seguro' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('Q7K2')
    expect(relay.answers).toHaveLength(0)
  })

  it('delivers the answer with the real attempt and code when the code matches', async () => {
    const q = relay.question('Q7K2')
    const r = await reply({ code: ' q7k2', answer: 'Sí, v3.4.2', source: 'CHANGELOG.md', confidence: 'seguro' })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toBe('Respuesta entregada a Amieva.')
    expect(relay.answers).toEqual([{ attemptId: q.attemptId, code: 'Q7K2', text: 'Sí, v3.4.2', source: 'CHANGELOG.md', confidence: 'seguro' }])
  })

  it('announces a cancellation and refuses a late answer to it', async () => {
    const q = relay.question('AAAA')
    relay.cancel(q.attemptId)
    await until(() => notes.length === 2)
    expect(notes[1]!.params!.meta).toEqual({ code: 'AAAA', event: 'cancelled' })
    relay.question('BBBB')
    const r = await reply({ code: 'AAAA', answer: 'tarde', source: 'x', confidence: 'creo' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('cancelada')
    expect(relay.answers).toHaveLength(0)
  })

  it('treats the active question as cancelled when the relay connection drops', async () => {
    relay.question('AAAA')
    relay.disconnect()
    await until(() => notes.length === 2)
    const r = await reply({ code: 'AAAA', answer: 'x', source: 'y', confidence: 'creo' })
    expect(textOf(r)).toContain('cancelada')
  })

  it('reports a relay rejection as an error and frees the question', async () => {
    relay.result = 'rejected'
    relay.question('AAAA')
    const r = await reply({ code: 'AAAA', answer: 'x', source: 'y', confidence: 'creo' })
    expect(r.isError).toBe(true)
    const again = await reply({ code: 'AAAA', answer: 'x', source: 'y', confidence: 'creo' })
    expect(textOf(again)).toContain('cancelada')
  })

  it('rejects invalid arguments and replies with no active question', async () => {
    relay.question('AAAA')
    const bad = await reply({ code: 'AAAA', answer: 'x', source: 'y', confidence: 'quizá' })
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toBe('Argumentos inválidos en: confidence')
    await reply({ code: 'AAAA', answer: 'x', source: 'y', confidence: 'creo' })
    const none = await reply({ code: 'CCCC', answer: 'x', source: 'y', confidence: 'creo' })
    expect(none.isError).toBe(true)
    expect(textOf(none)).toContain('No hay ninguna pregunta activa')
  })
})
