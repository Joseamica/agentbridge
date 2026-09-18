import { describe, expect, it } from 'vitest'
import { NOSTR, type Message, type OpenedMessage, type ResponderInboundOutcome } from '@agentbridge/core'
import { responderMessageHandler } from '../src/inbound'

const sender = 'ab'.repeat(32)
const opened = (message: Message): OpenedMessage => ({
  ok: true,
  wrapId: 'c'.repeat(64),
  senderPubkey: sender,
  rumor: { id: 'd'.repeat(64), pubkey: sender, created_at: 1, kind: NOSTR.rumorKind, tags: [], content: JSON.stringify(message) },
  message,
  powBits: message.type === 'connect_request' ? 22 : 16,
})
const question: Message = { v: 1, type: 'question', questionId: '00000000-0000-4000-8000-000000000001', generation: 1, text: 'texto privado' }
const request: Message = { v: 1, type: 'connect_request', requestId: '00000000-0000-4000-8000-000000000002', name: 'Nombre Privado', note: 'nota privada', relays: ['wss://r.example.com'] }

function recorder() {
  const calls: string[] = []
  const handle = responderMessageHandler({ wakeDispatcher: () => calls.push('wake'), notifyRequests: () => calls.push('notify'), log: (line) => calls.push(line) })
  return { calls, handle: (message: Message, outcome: ResponderInboundOutcome) => handle(opened(message), outcome) }
}

describe('responderMessageHandler', () => {
  it('wakes the dispatcher for a queued question and tries the notice for a stored request', () => {
    const { calls, handle } = recorder()
    handle(question, { kind: 'question', outcome: { kind: 'queued' } })
    handle(request, { kind: 'request', outcome: 'stored' })
    expect(calls).toEqual(['wake', 'notify'])
  })

  it('logs identity conflicts with identifiers only', () => {
    const { calls, handle } = recorder()
    handle(question, { kind: 'question', outcome: { kind: 'dropped', reason: 'conflict' } })
    handle(request, { kind: 'request', outcome: 'conflict' })
    expect(calls).toEqual([
      'dropped a question that reuses question id 00000000-0000-4000-8000-000000000001 with different content (sender abababab)',
      'dropped a connection request that reuses request id 00000000-0000-4000-8000-000000000002 with different content (sender abababab)',
    ])
    expect(calls.join(' ')).not.toMatch(/privad/i)
  })

  it('logs a dropped question with identifiers only when a decision could not be resent or a contact has no relays', () => {
    const { calls, handle } = recorder()
    handle(question, { kind: 'question', outcome: { kind: 'dropped', reason: 'abandoned' } })
    handle(question, { kind: 'question', outcome: { kind: 'dropped', reason: 'no_relays' } })
    expect(calls).toEqual([
      'dropped question 00000000-0000-4000-8000-000000000001 (sender abababab): a stored decision could no longer be sent',
      'dropped question 00000000-0000-4000-8000-000000000001 (sender abababab): the contact has no usable relays',
    ])
    expect(calls.join(' ')).not.toMatch(/privad/i)
  })

  it('does nothing for every other outcome', () => {
    const { calls, handle } = recorder()
    handle(question, { kind: 'question', outcome: { kind: 'regenerated' } })
    handle(question, { kind: 'question', outcome: { kind: 'dropped', reason: 'unrelated' } })
    handle(request, { kind: 'request', outcome: 'duplicate' })
    handle(question, { kind: 'ignored', reason: 'other_role' })
    expect(calls).toEqual([])
  })
})
