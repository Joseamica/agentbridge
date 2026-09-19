import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyApproval,
  createOutboundRequest,
  createRumor,
  listOutboundQuestions,
  nowSeconds,
  openStore,
  setProfile,
  wrapRumor,
  type Store,
} from '@agentbridge/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { plainSocketFactory, startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { testIdentity } from '../../core/test/support/keys'
import { ask, ticket } from '../src/commands/ask'
import { memoryOutput, type CliContext } from '../src/context'

const me = testIdentity(66)
const ana = testIdentity(67)
const T0 = 2_000_000_000
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

let board: FakeBoard
let home: string
let ctx: CliContext & { out: ReturnType<typeof memoryOutput> }

const allowAnyRelay = (inputs: readonly unknown[]): string[] =>
  inputs.filter((value): value is string => typeof value === 'string' && value.startsWith('ws')).slice(0, 5)

async function withStore<T>(fn: (store: Store) => T): Promise<T> {
  const store = await openStore(home, { relayPolicy: allowAnyRelay })
  try {
    return fn(store)
  } finally {
    store.close()
  }
}

beforeEach(async () => {
  board = await startFakeBoard()
  home = join(await mkdtemp(join(tmpdir(), 'ab-ask-')), 'home')
  await withStore((store) => {
    setProfile(store, { name: 'Beto', relays: [board.url], now: T0 })
    createOutboundRequest(store, { pubkey: ana.publicKey, requestId: uuid(1), relays: [board.url], now: T0 })
    applyApproval(store, { pubkey: ana.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: T0 })
  })
  await writeFile(join(home, 'identity.json'), JSON.stringify({ version: 1, secretKey: Buffer.from(me.secretKey).toString('hex') }), { mode: 0o600 })
  ctx = { home, out: memoryOutput(), env: {}, relayPolicy: allowAnyRelay, createSocket: plainSocketFactory } as CliContext & { out: ReturnType<typeof memoryOutput> }
})

afterEach(async () => {
  await board.close()
})

describe('ask', () => {
  it('sends the question, prints its whole identifier and says how retries work', async () => {
    await ask(['ana', '¿cómo', 'se', 'despliega?', '--no-wait'], ctx)
    const questions = await withStore((store) => listOutboundQuestions(store))
    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatchObject({ text: '¿cómo se despliega?', state: 'sent' })
    const printed = ctx.out.lines.join('\n')
    // The whole id, never a prefix: a prefix the person was never shown cannot be disambiguated
    // later if two questions happen to share it.
    expect(printed).toContain(questions[0]!.questionId)
    expect(printed).toMatch(/cada vez que corres un comando/i)
  })

  it('shows the answer when it arrives while waiting', async () => {
    // The other person answers as soon as the question is on the board.
    const answering = (async () => {
      for (let i = 0; i < 100; i++) {
        const asked = await withStore((store) => listOutboundQuestions(store)[0])
        if (asked) {
          const rumor = createRumor(
            { v: 1, type: 'answer', questionId: asked.questionId, text: 'con npm run deploy', source: 'README.md', confidence: 'seguro' },
            ana,
            nowSeconds(),
          )
          board.inject(await wrapRumor(rumor, ana, me.publicKey, { now: nowSeconds() }))
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    })()

    await ask(['ana', '¿cómo se despliega?', '--wait', '20'], ctx)
    await answering
    const printed = ctx.out.lines.join('\n')
    expect(printed).toContain('con npm run deploy')
    expect(printed).toContain('README.md')
  })

  it('refuses a question for a name nobody has, without sending anything', async () => {
    await expect(ask(['nadie', 'hola', '--no-wait'], ctx)).rejects.toThrow()
    expect(await withStore((store) => listOutboundQuestions(store))).toEqual([])
  })

  it('refuses a mistyped --wait with a local Spanish message', async () => {
    await expect(ask(['ana', 'hola', '--wait', 'pronto'], ctx)).rejects.toThrow(/--wait/)
  })
})

describe('ticket', () => {
  it('shows the state of a question by a prefix of its identifier', async () => {
    await ask(['ana', 'hola', '--no-wait'], ctx)
    const asked = await withStore((store) => listOutboundQuestions(store)[0]!)
    ctx.out.lines.length = 0

    await ticket([asked.questionId.slice(0, 8)], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).toContain('hola')
    expect(printed).toMatch(/enviada|recibida/i)
  })

  it('says what to do when the identifier matches nothing', async () => {
    await expect(ticket(['00000000'], ctx)).rejects.toThrow()
  })
})
