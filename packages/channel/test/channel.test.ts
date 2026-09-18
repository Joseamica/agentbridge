import type { AnswerOutcome } from '@agentbridge/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { CHANNEL_INSTRUCTIONS, createChannelServer, replyResult } from '../src/channel'
import type { ReplyArgs } from '../src/dispatcher'

type Note = { method: string; params?: { content?: string; meta?: Record<string, string> } }

let calls: ReplyArgs[]
let nextOutcome: AnswerOutcome
let failWith: Error | null
let logs: string[]
let client: Client
let notes: Note[]
let channel: ReturnType<typeof createChannelServer>

beforeEach(async () => {
  calls = []
  nextOutcome = { kind: 'answered', fromName: 'beto', code: 'ABCD' }
  failWith = null
  logs = []
  channel = createChannelServer(
    {
      reply: (args) => {
        calls.push(args)
        if (failWith) throw failWith
        return nextOutcome
      },
    },
    { log: (line) => logs.push(line) },
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'fake-claude', version: '0.0.0' })
  notes = []
  client.fallbackNotificationHandler = async (n) => {
    notes.push(n as Note)
  }
  await Promise.all([channel.server.connect(serverTransport), client.connect(clientTransport)])
})

const reply = (args: Record<string, unknown>) => client.callTool({ name: 'reply', arguments: args })
const textOf = (r: Awaited<ReturnType<typeof reply>>) => (r.content as { text: string }[])[0]!.text
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}

describe('channel MCP server', () => {
  it('declares the channel capability and explains the reply tool and the tag format', () => {
    expect(client.getServerCapabilities()?.experimental?.['claude/channel']).toEqual({})
    expect(client.getServerCapabilities()?.experimental?.['claude/channel/permission']).toBeUndefined()
    expect(client.getInstructions()).toBe(CHANNEL_INSTRUCTIONS)
    expect(CHANNEL_INSTRUCTIONS).toContain('from_name')
    expect(CHANNEL_INSTRUCTIONS).toContain('reply')
  })

  it('exposes only the reply tool', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['reply'])
  })

  it('pushes a question with its code and sender name, and a cancellation', async () => {
    await channel.deliverQuestion({ code: 'ABCD', fromName: 'beto', text: '¿Ya quedó el fix?' })
    await channel.cancelQuestion('ABCD', 'revoked')
    await until(() => notes.length === 2)
    expect(notes[0]).toMatchObject({ method: 'notifications/claude/channel', params: { content: '¿Ya quedó el fix?', meta: { code: 'ABCD', from_name: 'beto' } } })
    expect(notes[1]!.params?.meta).toEqual({ code: 'ABCD', event: 'cancelled' })
    expect(notes[1]!.params?.content).toMatch(/ABCD.*No la contestes/)
  })

  it('passes valid arguments to the backend and says the answer is saved and on its way', async () => {
    const result = await reply({ code: 'abcd', answer: ' Sí, el viernes. ', source: 'plan.md', confidence: 'creo' })
    expect(calls).toEqual([{ code: 'abcd', answer: 'Sí, el viernes.', source: 'plan.md', confidence: 'creo' }])
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toMatch(/guardada/)
    expect(textOf(result)).toMatch(/beto/)
  })

  it('rejects invalid arguments without calling the backend', async () => {
    const result = await reply({ code: 'ABCD', answer: '', source: 'plan.md', confidence: 'tal vez' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/answer/)
    expect(textOf(result)).toMatch(/confidence/)
    expect(calls).toEqual([])
  })

  it('rejects a whitespace-only answer without calling the backend', async () => {
    const result = await reply({ code: 'ABCD', answer: '   ', source: 'plan.md', confidence: 'seguro' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/answer/)
    expect(calls).toEqual([])
  })

  it('rejects a whitespace-only source without calling the backend', async () => {
    const result = await reply({ code: 'ABCD', answer: 'x', source: '  ', confidence: 'seguro' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/source/)
    expect(calls).toEqual([])
  })

  it('turns an unexpected backend error into a generic tool error that does not repeat the error text', async () => {
    failWith = new Error('disk I/O error near PRIVATE_DECRYPTED_CANARY')
    const result = await reply({ code: 'ABCD', answer: 'x', source: 'y', confidence: 'seguro' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/error interno/)
    expect(textOf(result)).not.toContain('PRIVATE_DECRYPTED_CANARY')
    expect(logs).toEqual(['reply failed (Error)'])
  })

  it('turns every refusal into a Spanish tool error', async () => {
    nextOutcome = { kind: 'wrong_code', activeCode: 'WXYZ' }
    const wrong = await reply({ code: 'ABCD', answer: 'x', source: 'y', confidence: 'seguro' })
    expect(wrong.isError).toBe(true)
    expect(textOf(wrong)).toMatch(/WXYZ/)
  })
})

describe('replyResult', () => {
  it('has a message for every outcome, and only an answer is not an error', () => {
    const outcomes: AnswerOutcome[] = [
      { kind: 'answered', fromName: 'beto', code: 'ABCD' },
      { kind: 'no_active' },
      { kind: 'wrong_code', activeCode: 'WXYZ' },
      { kind: 'cancelled', activeCode: null },
      { kind: 'cancelled', activeCode: 'WXYZ' },
      { kind: 'late' },
      { kind: 'revoked' },
      { kind: 'too_large' },
      { kind: 'fenced' },
    ]
    for (const outcome of outcomes) {
      const result = replyResult(outcome, 'ABCD')
      expect(result.text.length).toBeGreaterThan(10)
      expect(result.isError).toBe(outcome.kind !== 'answered')
    }
    expect(replyResult({ kind: 'cancelled', activeCode: 'WXYZ' }, 'abcd').text).toMatch(/ABCD[\s\S]*WXYZ/)
  })
})
