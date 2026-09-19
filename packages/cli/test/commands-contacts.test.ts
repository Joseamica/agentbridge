import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  admitQuestion,
  applyApproval,
  createOutboundRequest,
  getContact,
  listRequests,
  openStore,
  recordIncomingRequest,
  setProfile,
  type Store,
} from '@agentbridge/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { plainSocketFactory, startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { testIdentity } from '../../core/test/support/keys'
import { approve, contacts, reject, requests, revoke, whoami } from '../src/commands/contacts'
import { memoryOutput, type CliContext } from '../src/context'

const me = testIdentity(63)
const ana = testIdentity(64)
const beto = testIdentity(65)
const T0 = 2_000_000_000
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

let board: FakeBoard
let home: string
let ctx: CliContext & { out: ReturnType<typeof memoryOutput> }

async function withStore<T>(fn: (store: Store) => T): Promise<T> {
  const store = await openStore(home, { relayPolicy: allowAnyRelay })
  try {
    return fn(store)
  } finally {
    store.close()
  }
}

const allowAnyRelay = (inputs: readonly unknown[]): string[] =>
  inputs.filter((value): value is string => typeof value === 'string' && value.startsWith('ws')).slice(0, 5)

beforeEach(async () => {
  board = await startFakeBoard()
  home = join(await mkdtemp(join(tmpdir(), 'ab-contacts-')), 'home')
  await withStore((store) => setProfile(store, { name: 'Yo', relays: [board.url], now: T0 }))
  await writeFile(join(home, 'identity.json'), JSON.stringify({ version: 1, secretKey: Buffer.from(me.secretKey).toString('hex') }), { mode: 0o600 })
  ctx = { home, out: memoryOutput(), env: {}, relayPolicy: allowAnyRelay, createSocket: plainSocketFactory } as CliContext & { out: ReturnType<typeof memoryOutput> }
})

afterEach(async () => {
  await board.close()
})

describe('contacts and whoami', () => {
  it('shows both directions with what each state means', async () => {
    await withStore((store) => {
      createOutboundRequest(store, { pubkey: ana.publicKey, requestId: uuid(1), relays: [board.url], now: T0 })
      applyApproval(store, { pubkey: ana.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: T0 })
      recordIncomingRequest(store, {
        pubkey: beto.publicKey,
        requestId: uuid(2),
        requestRumorId: 'c'.repeat(64),
        declaredName: 'Beto',
        note: 'hola',
        relays: [board.url],
        now: T0,
      })
    })
    await contacts([], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).toContain('ana')
    expect(printed).toMatch(/puedes preguntarle/i)
    expect(printed).toMatch(/te pidió permiso/i)
  })

  it('prints this person’s key, name and relays without touching the network', async () => {
    await whoami([], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).toContain(me.publicKey)
    expect(printed).toContain('Yo')
    expect(printed).toContain(board.url)
  })
})

describe('requests, approve and reject', () => {
  async function incoming(): Promise<string> {
    await withStore((store) =>
      recordIncomingRequest(store, {
        pubkey: beto.publicKey,
        requestId: uuid(3),
        requestRumorId: 'd'.repeat(64),
        declaredName: 'Beto',
        note: 'trabajo contigo',
        relays: [board.url],
        now: T0,
      }),
    )
    return beto.publicKey.slice(0, 8)
  }

  it('lists a request with its identifier, its note and the shared-folder warning', async () => {
    const id = await incoming()
    await requests([], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).toContain(id)
    expect(printed).toContain('Beto')
    expect(printed).toContain('trabajo contigo')
    expect(printed.toLowerCase()).toContain('carpeta compartida')
  })

  it('approves by identifier and says what changed', async () => {
    const id = await incoming()
    await approve([id], ctx)
    expect(await withStore((store) => getContact(store, beto.publicKey, 'inbound')?.state)).toBe('approved')
    expect(ctx.out.lines.join('\n')).toMatch(/puede preguntarte/i)
  })

  it('rejects by identifier', async () => {
    const id = await incoming()
    await reject([id], ctx)
    expect(await withStore((store) => getContact(store, beto.publicKey, 'inbound')?.state)).toBe('rejected')
    expect(await withStore((store) => listRequests(store, T0))).toEqual([])
  })

  it('refuses a list position but accepts an all-digit identifier', async () => {
    await incoming()
    await expect(approve(['1'], ctx)).rejects.toThrow()
    // A key prefix is hexadecimal: '12345678' is a perfectly valid identifier, not an index.
    await expect(approve(['12345678'], ctx)).rejects.toThrow(/solicitud/i)
  })

  it('never lets a declared name repaint the listing', async () => {
    await withStore((store) =>
      recordIncomingRequest(store, {
        pubkey: ana.publicKey,
        requestId: uuid(9),
        requestRumorId: 'f'.repeat(64),
        declaredName: 'Ana\u001b[2K\rAPROBADA',
        note: 'linea1\nlinea2',
        relays: [board.url],
        now: T0,
      }),
    )
    await requests([], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).not.toContain('\u001b')
    expect(printed).toContain('linea1 linea2')
  })

  // reject() prints `contact.declaredName` directly (unlike approve(), whose printed name is always
  // an already-safe slug) — its own forTerminal call is the only thing standing between this raw,
  // attacker-controlled field and the terminal. Covered on its own so that guard is never just an
  // unverified claim (Task 8's review lesson).
  it('sanitizes a hostile declared name when rejecting', async () => {
    const ESC = '\u001b'
    await withStore((store) =>
      recordIncomingRequest(store, {
        pubkey: ana.publicKey,
        requestId: uuid(10),
        requestRumorId: 'a'.repeat(64),
        declaredName: `Ana${ESC}[2K\rAPROBADA`,
        note: '',
        relays: [board.url],
        now: T0,
      }),
    )
    await reject([ana.publicKey.slice(0, 8)], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).not.toContain(ESC)
    expect(printed).not.toContain('\r')
  })

  // approve()'s printed name is `contact.localName`, always an already-computed slug by the time this
  // runs (approveRequest sets it unconditionally) — so this is defense in depth, not the load-bearing
  // case, but the same hostile input is worth proving harmless here too.
  it('sanitizes a hostile declared name when approving', async () => {
    const ESC = '\u001b'
    await withStore((store) =>
      recordIncomingRequest(store, {
        pubkey: ana.publicKey,
        requestId: uuid(11),
        requestRumorId: 'b'.repeat(64),
        declaredName: `Ana${ESC}[2K\rAPROBADA`,
        note: '',
        relays: [board.url],
        now: T0,
      }),
    )
    await approve([ana.publicKey.slice(0, 8)], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).not.toContain(ESC)
    expect(printed).not.toContain('\r')
  })

  // I2: a prefix that matches a contact whose decision already went the other way must say so, not
  // read like the generic "not found" a truly unknown id gets.
  it('tells the truth in Spanish when approving something already rejected', async () => {
    const id = await incoming()
    await reject([id], ctx)
    await expect(approve([id], ctx)).rejects.toThrow(/ya le dijiste que no/i)
  })

  it('tells the truth in Spanish when rejecting something already approved', async () => {
    const id = await incoming()
    await approve([id], ctx)
    await expect(reject([id], ctx)).rejects.toThrow(/ya le diste permiso/i)
  })

  // M1: a repeated decision must say nothing changed, not repeat the fresh-decision message as if it
  // had acted again.
  it('says nothing changed on a repeated approve of the same contact', async () => {
    const id = await incoming()
    await approve([id], ctx)
    ctx.out.lines.length = 0
    await approve([id], ctx)
    expect(ctx.out.lines.join('\n')).toMatch(/ya habías aprobado/i)
  })

  it('says nothing changed on a repeated reject of the same contact', async () => {
    const id = await incoming()
    await reject([id], ctx)
    ctx.out.lines.length = 0
    await reject([id], ctx)
    expect(ctx.out.lines.join('\n')).toMatch(/ya habías rechazado/i)
  })

  // M2: requireId enforced a minimum length but no maximum, so a pasted paragraph reached the store
  // as a query instead of being refused up front as the clean, cheap Spanish error it should be.
  it('refuses an identifier longer than a pubkey can ever be, before it reaches the store', async () => {
    await incoming()
    await expect(approve(['a'.repeat(65)], ctx)).rejects.toThrow(/demasiado largo/i)
  })
})

describe('revoke', () => {
  it('revokes by name and reports how many waiting questions it closed', async () => {
    await withStore((store) => {
      recordIncomingRequest(store, {
        pubkey: beto.publicKey,
        requestId: uuid(4),
        requestRumorId: 'e'.repeat(64),
        declaredName: 'Beto',
        note: '',
        relays: [board.url],
        now: T0,
      })
    })
    await approve([beto.publicKey.slice(0, 8)], ctx)
    // Give Beto a received, unanswered question before revoking, so the "Cerré N pregunta(s)..."
    // branch this test's own name promises is actually exercised (fix round 1, I1 — the brief's own
    // test never gave the contact a question to close, so `rejectedQuestions` was always 0).
    await withStore((store) =>
      admitQuestion(store, {
        identity: me,
        senderPubkey: beto.publicKey,
        questionId: uuid(20),
        rumorId: '1'.repeat(64),
        rumorCreatedAt: T0,
        generation: 1,
        text: '¿me ayudas?',
        now: T0,
      }),
    )
    ctx.out.lines.length = 0

    const name = await withStore((store) => getContact(store, beto.publicKey, 'inbound')!.localName!)
    await revoke([name], ctx)
    expect(await withStore((store) => getContact(store, beto.publicKey, 'inbound')?.state)).toBe('revoked')
    const printed = ctx.out.lines.join('\n')
    expect(printed).toMatch(/ya no puede preguntarte/i)
    expect(printed).toMatch(/Cerré 1 pregunta/i)
  })

  it('says which names exist when the one given does not', async () => {
    await expect(revoke(['nadie'], ctx)).rejects.toThrow()
  })

  // Final review, Important I2: revokeConnection's own idempotent early return (already revoked,
  // nothing sent again — connect_revoked's policy is 'once') must not be announced the same way a
  // fresh revoke is, matching approve/reject's own "no cambié nada" branch (Ruling 24/M1).
  it('says nothing changed on a repeated revoke of the same contact', async () => {
    await withStore((store) => {
      recordIncomingRequest(store, {
        pubkey: beto.publicKey,
        requestId: uuid(5),
        requestRumorId: 'aa'.repeat(32),
        declaredName: 'Beto',
        note: '',
        relays: [board.url],
        now: T0,
      })
    })
    await approve([beto.publicKey.slice(0, 8)], ctx)
    const name = await withStore((store) => getContact(store, beto.publicKey, 'inbound')!.localName!)
    await revoke([name], ctx)
    ctx.out.lines.length = 0
    await revoke([name], ctx)
    expect(ctx.out.lines.join('\n')).toMatch(/ya habías revocado/i)
  })
})
