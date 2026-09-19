import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeLink, getContact, openStore, setProfile } from '@agentbridge/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { plainSocketFactory, startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { testIdentity } from '../../core/test/support/keys'
import { connect, link } from '../src/commands/connect'
import { memoryOutput, type CliContext } from '../src/context'

const me = testIdentity(61)
const them = testIdentity(62)

let board: FakeBoard
let home: string
let ctx: CliContext & { out: ReturnType<typeof memoryOutput> }

// Every relay here is a local fake board, so the store is opened with a policy that accepts
// ws://127.0.0.1 — the same relaxation the responder harness uses. The identity file is written in
// the exact shape `loadIdentity` parses (`version: 1` plus a 64-character hex key); anything else
// is reported as a damaged identity.
const allowAnyRelay = (inputs: readonly unknown[]): string[] =>
  inputs.filter((value): value is string => typeof value === 'string' && value.startsWith('ws')).slice(0, 5)

async function seedHome(): Promise<void> {
  home = join(await mkdtemp(join(tmpdir(), 'ab-connect-')), 'home')
  const store = await openStore(home, { relayPolicy: allowAnyRelay })
  setProfile(store, { name: 'Beto', relays: [board.url], now: 2_000_000_000 })
  store.close()
  await writeFile(join(home, 'identity.json'), JSON.stringify({ version: 1, secretKey: Buffer.from(me.secretKey).toString('hex') }), { mode: 0o600 })
}

beforeEach(async () => {
  board = await startFakeBoard()
  await seedHome()
  ctx = { home, out: memoryOutput(), env: {}, relayPolicy: allowAnyRelay, createSocket: plainSocketFactory } as CliContext & { out: ReturnType<typeof memoryOutput> }
})

afterEach(async () => {
  await board.close()
})

describe('link', () => {
  it('prints this person’s own link and what to do with it', async () => {
    await link([], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).toContain('agentbridge:')
    expect(printed.toLowerCase()).toContain('comparte')
  })
})

describe('connect', () => {
  it('stores the request, publishes it, and says so in Spanish', async () => {
    await connect([encodeLink(them.publicKey, [board.url]), '--note', 'soy Beto'], ctx)
    const store = await openStore(home, { relayPolicy: allowAnyRelay })
    expect(getContact(store, them.publicKey, 'outbound')).toMatchObject({ state: 'pending' })
    store.close()
    expect(ctx.out.lines.join('\n')).toMatch(/solicitud/i)
  })

  it('refuses a note longer than the protocol allows, without storing anything', async () => {
    await expect(connect([encodeLink(them.publicKey, [board.url]), '--note', 'x'.repeat(501)], ctx)).rejects.toThrow()
    const store = await openStore(home, { relayPolicy: allowAnyRelay })
    expect(getContact(store, them.publicKey, 'outbound')).toBeNull()
    store.close()
  })

  it('explains what is missing when the link is not one of ours', async () => {
    await expect(connect(['no-es-un-enlace'], ctx)).rejects.toThrow()
  })

  it('tells the person the request is already on its way instead of sending another', async () => {
    const enlace = encodeLink(them.publicKey, [board.url])
    await connect([enlace], ctx)
    ctx.out.lines.length = 0
    await connect([enlace], ctx)
    expect(ctx.out.lines.join('\n')).toMatch(/ya (le )?enviaste|ya está en camino/i)
  })
})
