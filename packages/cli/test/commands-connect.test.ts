import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyApproval, createOutboundRequest, encodeLink, getContact, openStore, setProfile } from '@agentbridge/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plainSocketFactory, startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { testIdentity } from '../../core/test/support/keys'
import { AskerService } from '../src/asker/service'
import { connect, link } from '../src/commands/connect'
import { memoryOutput, type CliContext } from '../src/context'

const me = testIdentity(61)
const them = testIdentity(62)
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const NOTICE_RE = /tarda unos segundos/i

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

// Approves `them` directly through the store, as an already-completed connect_request — connect()
// on this link then always lands in the 'already_approved' branch without mining anything.
async function approveThem(declaredName: string): Promise<void> {
  const store = await openStore(home, { relayPolicy: allowAnyRelay })
  createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: [board.url], now: 2_000_000_000 })
  applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation: 1, name: declaredName, relays: [board.url], now: 2_000_000_000 })
  store.close()
}

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
    // 22 bits of proof of work, mined for real — this is the one test in its file that does
    // genuine cryptographic work rather than arranging data, and how long it takes depends on how
    // busy the machine is, not on this code. Vitest's 20-second default was enough until the suite
    // grew past 800 tests, several of which spawn real child processes and compete for the same
    // cores; then it began failing about twice in three full runs while passing every time in
    // isolation. An explicit bound, the same way tests/asker/multiprocess.test.ts bounds its own
    // real-process tests, rather than a retry — a flaky guard teaches people to re-run instead of
    // to look.
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
  }, 120_000)

  it('explains what is missing when the link is not one of ours', async () => {
    await expect(connect(['no-es-un-enlace'], ctx)).rejects.toThrow()
  })

  it('tells the person the request is already on its way instead of sending another', async () => {
    const enlace = encodeLink(them.publicKey, [board.url])
    await connect([enlace], ctx)
    ctx.out.lines.length = 0
    await connect([enlace], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).toMatch(/ya (le )?enviaste|ya está en camino/i)
    // Fix round 1, M1: a retry that finds an existing pending request mines nothing new, so the
    // "this takes a few seconds" notice must not appear here — it would be advertising work this
    // call never does.
    expect(printed).not.toMatch(NOTICE_RE)
  })

  // Fix round 1, I2: the P5c notice was previously unasserted. This pins it to the one moment it
  // actually matters — strictly before the sync call that can mine the request this same command
  // just enqueued — rather than merely checking it appears somewhere in the output.
  it('prints the "this takes a few seconds" notice before the sync that can mine the request', async () => {
    const events: string[] = []
    const originalLog = ctx.out.log.bind(ctx.out)
    ctx.out.log = (message: string) => {
      events.push(`log:${message}`)
      originalLog(message)
    }
    const originalSync = AskerService.prototype.sync
    const syncSpy = vi.spyOn(AskerService.prototype, 'sync').mockImplementation(function (this: AskerService, ...args: Parameters<typeof originalSync>) {
      events.push('sync')
      return originalSync.apply(this, args)
    })
    try {
      await connect([encodeLink(them.publicKey, [board.url])], ctx)
    } finally {
      syncSpy.mockRestore()
    }
    const noticeAt = events.findIndex((e) => e.startsWith('log:') && NOTICE_RE.test(e))
    // withAsker's own pre-operate sync (the first 'sync' event) runs before connect() has enqueued
    // anything, so it cannot mine this request; only the second sync — the one connect() calls
    // itself, right after enqueuing — can. The notice must land before *that* one.
    const secondSyncAt = events.indexOf('sync', events.indexOf('sync') + 1)
    expect(noticeAt).toBeGreaterThanOrEqual(0)
    expect(secondSyncAt).toBeGreaterThanOrEqual(0)
    expect(noticeAt).toBeLessThan(secondSyncAt)
  })
})

describe('connect: already approved', () => {
  it('never mines and never shows the "this takes a few seconds" notice', async () => {
    await approveThem('Ana')
    await connect([encodeLink(them.publicKey, [board.url])], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).toMatch(/ya te dio permiso/i)
    expect(printed).not.toMatch(NOTICE_RE)
  })

  // Fix round 1, I2. A hostile declared name — an ESC + CSI color sequence and a lone CR (a
  // cursor-to-column-0 move with no following LF) — must never survive into printed output; both are
  // exactly the kind of raw control character forTerminal (asker/format.ts) strips.
  it('sanitizes a hostile declared name before showing it', async () => {
    await approveThem('Ana\u001b[31mEVIL\u001b[0mBeto\rBoo')
    await connect([encodeLink(them.publicKey, [board.url])], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).not.toMatch(/\u001b/)
    expect(printed).not.toMatch(/\r/)
  })

  // Fix round 1, M2. A declared name with spaces or accents slugifies into a different string for
  // addressing (`applyApproval` → `uniqueLocalName` → `slugifyName`) than what `ask` itself matches
  // against (`resolveContact`, which only lowercases — it never slugifies). Showing the declared name
  // in the example command could hand back something that fails to resolve.
  it('tells the person to ask using the exact handle "ask" resolves, not the raw declared name', async () => {
    await approveThem('Ana María')
    const store = await openStore(home, { relayPolicy: allowAnyRelay })
    const localName = getContact(store, them.publicKey, 'outbound')?.localName
    store.close()
    expect(localName).toBe('ana-maria')

    await connect([encodeLink(them.publicKey, [board.url])], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).toContain('Ana María')
    expect(printed).toContain(`ask ${localName} "tu pregunta"`)
    expect(printed).not.toContain('ask Ana María')
  })
})
