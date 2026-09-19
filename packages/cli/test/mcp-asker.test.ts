import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyApproval, createOutboundRequest, encodeLink, getContact, listOutboundQuestions, openStore, setProfile, type Store } from '@agentbridge/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { plainSocketFactory, startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { testIdentity } from '../../core/test/support/keys'
import { AskerService } from '../src/asker/service'
import { createAskerServer } from '../src/mcp-asker'

const me = testIdentity(68)
const ana = testIdentity(69)
const T0 = 2_000_000_000
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const allowAnyRelay = (inputs: readonly unknown[]): string[] =>
  inputs.filter((value): value is string => typeof value === 'string' && value.startsWith('ws')).slice(0, 5)

let board: FakeBoard
let store: Store
let service: AskerService
let client: Client

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
  return { text: result.content.map((c) => c.text).join('\n'), isError: result.isError === true }
}

beforeEach(async () => {
  board = await startFakeBoard()
  const home = join(await mkdtemp(join(tmpdir(), 'ab-mcp-')), 'home')
  store = await openStore(home, { relayPolicy: allowAnyRelay })
  setProfile(store, { name: 'Beto', relays: [board.url], now: T0 })
  await writeFile(join(home, 'identity.json'), JSON.stringify({ secretKey: Buffer.from(me.secretKey).toString('hex') }), { mode: 0o600 })
  service = new AskerService({ store, identity: me, createSocket: plainSocketFactory })
  const server = createAskerServer(service)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

afterEach(async () => {
  await client.close()
  await service.close()
  store.close()
  await board.close()
})

function approved(): void {
  createOutboundRequest(store, { pubkey: ana.publicKey, requestId: uuid(1), relays: [board.url], now: T0 })
  applyApproval(store, { pubkey: ana.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: T0 })
}

describe('the asker MCP server', () => {
  it('offers exactly the four tools, described in English', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['ask_contact', 'check_answer', 'connect', 'list_contacts'])
    for (const tool of tools) expect(tool.description).toMatch(/^[\x20-\x7E]+$/)
  })

  it('lists contacts without ever claiming someone is online', async () => {
    approved()
    const { text } = await call('list_contacts')
    expect(text).toContain('ana')
    expect(text).not.toMatch(/en línea|online|desconectad/i)
  })

  it('says so, in Spanish, when nobody has given permission yet', async () => {
    const { text } = await call('list_contacts')
    expect(text).toMatch(/nadie/i)
  })

  it('sends a question and gives back an identifier for check_answer', async () => {
    approved()
    const { text, isError } = await call('ask_contact', { contact: 'ana', question: '¿cómo se despliega?' })
    expect(isError).toBe(false)
    const asked = listOutboundQuestions(store)[0]!
    expect(text).toContain(asked.questionId)
    expect(asked.text).toBe('¿cómo se despliega?')
    expect(text).toMatch(/enviada|pendiente de envío/)
  })

  it('says a question is only saved when no relay took it', async () => {
    approved()
    await board.close() // every relay is gone before the tool runs
    const { text } = await call('ask_contact', { contact: 'ana', question: '¿hay alguien?' })
    expect(text).toMatch(/pendiente de envío/)
  })

  it('refuses a blank question without sending anything', async () => {
    approved()
    const { isError } = await call('ask_contact', { contact: 'ana', question: '   ' })
    expect(isError).toBe(true)
    expect(listOutboundQuestions(store)).toEqual([])
  })

  it('reports the state of a question, saying received rather than answered', async () => {
    approved()
    await call('ask_contact', { contact: 'ana', question: 'hola' })
    const asked = listOutboundQuestions(store)[0]!
    const { text } = await call('check_answer', { question_id: asked.questionId, wait_seconds: 0 })
    expect(text).toMatch(/enviada|recibida/i)
    expect(text).not.toMatch(/contestada/i)
  })

  it('asks for permission through connect', async () => {
    const { isError } = await call('connect', { link: encodeLink(ana.publicKey, [board.url]), note: 'soy Beto' })
    expect(isError).toBe(false)
    expect(getContact(store, ana.publicKey, 'outbound')?.state).toBe('pending')
  })

  // A hostile declared name is exactly what forTerminal exists to strip (see commands-connect.test.ts's
  // "sanitizes a hostile declared name before showing it") — connect's own already_approved branch, and
  // this MCP tool's, must apply the same rule to the same field instead of printing it straight through
  // to whatever surface is reading the tool's text (a terminal, or a chat transcript rendered from one).
  it('sanitizes a hostile declared name before showing it in the already_approved reply', async () => {
    createOutboundRequest(store, { pubkey: ana.publicKey, requestId: uuid(2), relays: [board.url], now: T0 })
    applyApproval(store, { pubkey: ana.publicKey, requestId: uuid(2), generation: 1, name: 'Ana\u001b[31mEVIL\u001b[0mBeto\rBoo', relays: [board.url], now: T0 })
    const { text, isError } = await call('connect', { link: encodeLink(ana.publicKey, [board.url]) })
    expect(isError).toBe(false)
    expect(text).not.toMatch(/\u001b/)
    expect(text).not.toMatch(/\r/)
  })

  it('turns an unexpected failure into a Spanish tool error without leaking its text', async () => {
    approved()
    const broken = new AskerService({ store, identity: me, createSocket: plainSocketFactory })
    // A service whose store is closed fails inside the tool call.
    store.close()
    const server = createAskerServer(broken)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const other = new Client({ name: 'test', version: '0' }, { capabilities: {} })
    await Promise.all([server.connect(serverTransport), other.connect(clientTransport)])
    const result = (await other.callTool({ name: 'list_contacts', arguments: {} })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).not.toMatch(/SQLITE|database/i)
    await other.close()
    await broken.close()
    // Reopened so afterEach can close it uniformly.
    store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-mcp-tail-')), 'home'), { relayPolicy: allowAnyRelay })
  })
})
