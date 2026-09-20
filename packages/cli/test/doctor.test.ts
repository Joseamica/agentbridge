import { loadOrCreateIdentity, openStore, recordIncomingRequest, setProfile } from '@agentbridge/core'
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { plainSocketFactory, startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { runDoctor } from '../src/commands/doctor'

// The production policy only accepts wss://, and the fake board speaks ws:// on loopback. This is
// the same three-line policy every other suite uses; importing it across the tests/ tree would tie
// a package's own unit tests to the integration harness.
const allowAnyRelay = (inputs: readonly unknown[]): string[] => inputs.filter((x): x is string => typeof x === 'string').slice(0, 5)

let root: string
let identityHome: string
let profileHome: string
let shareDir: string
let board: FakeBoard
const cleanups: Array<() => Promise<void> | void> = []

// Looked up by name so a reordering of the checks is a refactor, not a failure.
function check(checks: Array<{ name: string; ok: boolean; detail: string }>, name: string) {
  const found = checks.find((c) => c.name === name)
  if (!found) throw new Error(`doctor never reported a check called ${name}: ${checks.map((c) => c.name).join(', ')}`)
  return found
}

function doctorOptions(extra: Record<string, unknown> = {}) {
  return { identityHome, createSocket: plainSocketFactory, relayPolicy: allowAnyRelay, boardTimeoutMs: 2_000, ...extra }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ab-doctor-'))
  identityHome = join(root, 'identidad')
  profileHome = join(root, 'perfil')
  shareDir = join(root, 'compartido')
  await mkdir(shareDir, { recursive: true })
  board = await startFakeBoard()
  cleanups.push(() => board.close())
})

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function seedIdentity(home = identityHome): Promise<void> {
  await loadOrCreateIdentity(home)
  const store = await openStore(home, { relayPolicy: allowAnyRelay })
  setProfile(store, { name: 'Ana', relays: [board.url], now: 1_700_000_000 })
  store.close()
}

describe('runDoctor without an identity', () => {
  it('says there is no key yet and names the command that creates one', async () => {
    const checks = await runDoctor(doctorOptions())
    const key = check(checks, 'Llave de AgentBridge')
    expect(key.ok).toBe(false)
    expect(key.detail).toContain('setup')
  })

  it('does not create a database in a home that has none', async () => {
    const checks = await runDoctor(doctorOptions())
    expect(check(checks, 'Base de datos').ok).toBe(false)
    const { access } = await import('node:fs/promises')
    // A mistyped --home must never leave a folder and an empty database behind.
    await expect(access(join(identityHome, 'agentbridge.db'))).rejects.toThrow()
  })

  it('says a dedicated profile was mistaken for the identity home', async () => {
    await mkdir(profileHome, { recursive: true })
    await writeFile(join(profileHome, 'settings.json'), '{}')
    await writeFile(join(profileHome, 'start.sh'), '#!/bin/bash\n')
    const checks = await runDoctor({ ...doctorOptions(), identityHome: profileHome })
    expect(check(checks, 'Llave de AgentBridge').detail).toContain('--profile')
  })
})

describe('runDoctor with an identity', () => {
  it('reports the key, its permissions and the database', async () => {
    await seedIdentity()
    const checks = await runDoctor(doctorOptions())
    expect(check(checks, 'Llave de AgentBridge').ok).toBe(true)
    expect(check(checks, 'Base de datos').ok).toBe(true)
  })

  it('fails the key check when identity.json is readable by anyone', async () => {
    await seedIdentity()
    await chmod(join(identityHome, 'identity.json'), 0o644)
    const key = check(await runDoctor(doctorOptions()), 'Llave de AgentBridge')
    expect(key.ok).toBe(false)
    expect(key.detail).toContain('0600')
  })

  it('refuses an identity that lives inside the shared folder', async () => {
    const inside = join(shareDir, 'identidad')
    await seedIdentity(inside)
    const key = check(await runDoctor({ ...doctorOptions(), identityHome: inside, shareDir }), 'Llave de AgentBridge')
    expect(key.ok).toBe(false)
    expect(key.detail).toContain('compartida')
  })

  it('follows a symlink: a key file that points into the shared folder is still exposed', async () => {
    // The folder passes the containment check and the key still sits inside the shared folder,
    // which is exactly the arrangement a person would believe is safe.
    await seedIdentity()
    const realKey = join(shareDir, 'identity.json')
    const { rename } = await import('node:fs/promises')
    await rename(join(identityHome, 'identity.json'), realKey)
    await chmod(realKey, 0o600)
    await symlink(realKey, join(identityHome, 'identity.json'))
    const key = check(await runDoctor({ ...doctorOptions(), shareDir }), 'Llave de AgentBridge')
    expect(key.ok).toBe(false)
    expect(key.detail).toContain('compartida')
  })

  it('says the channel lock is free when nobody holds it', async () => {
    await seedIdentity()
    expect(check(await runDoctor(doctorOptions()), 'Candado del canal').ok).toBe(true)
  })

  it('publishes and reads back on a board that works', async () => {
    await seedIdentity()
    const boardCheck = check(await runDoctor(doctorOptions()), `Tablero ${board.url}`)
    expect(boardCheck.ok).toBe(true)
    expect(boardCheck.detail).toContain('publicar y leer')
    // The probe is addressed to a throwaway key, so this person's own subscriptions can never
    // fetch it and nothing of theirs is written because of a diagnostic.
    const published = board.events.at(-1)
    expect(published?.tags.some((t) => t[0] === 'p')).toBe(true)
    const identity = await loadOrCreateIdentity(identityHome)
    expect(published?.tags.some((t) => t[0] === 'p' && t[1] === identity.identity.publicKey)).toBe(false)
  })

  it('fails a board that refuses to publish', async () => {
    await seedIdentity()
    // A board that requires registration to write, and never offers a challenge this person could
    // answer: connecting works, publishing does not, and only publishing tells them apart.
    board.options = { ...board.options, requireAuthToWrite: true, sendAuthChallenge: false }
    const boardCheck = check(await runDoctor(doctorOptions()), `Tablero ${board.url}`)
    expect(boardCheck.ok).toBe(false)
    expect(boardCheck.detail).toContain('no aceptó publicar')
  })

  it('fails a board that accepts the event and then does not keep it', async () => {
    await seedIdentity()
    board.options = { ...board.options, dropIncoming: () => true }
    const boardCheck = check(await runDoctor(doctorOptions()), `Tablero ${board.url}`)
    expect(boardCheck.ok).toBe(false)
    expect(boardCheck.detail).toContain('no me devolvió')
  })

  it('fails a board that accepts the event but refuses to be read', async () => {
    await seedIdentity()
    board.options = { ...board.options, rejectReads: true }
    const boardCheck = check(await runDoctor(doctorOptions()), `Tablero ${board.url}`)
    expect(boardCheck.ok).toBe(false)
    expect(boardCheck.detail).toContain('leer')
  })

  it('fails a board that answers with a corrupted copy of what was published', async () => {
    await seedIdentity()
    // The board keeps nothing (so its own retained copy cannot satisfy the read) and answers the
    // read with the same event id and a different content — the shape a board would use to make a
    // probe believe a message is there when what it has is not what was published.
    let captured: Record<string, unknown> | null = null
    board.options = {
      ...board.options,
      dropIncoming: (event) => {
        captured = { ...(event as unknown as Record<string, unknown>) }
        return true
      },
      beforeEose: () => (captured ? [{ ...captured, content: 'otra cosa' }] : []),
    }
    expect(check(await runDoctor(doctorOptions()), `Tablero ${board.url}`).ok).toBe(false)
  })

  it('counts pending requests and says how to see them', async () => {
    await seedIdentity()
    const store = await openStore(identityHome, { relayPolicy: allowAnyRelay })
    const now = Math.floor(Date.now() / 1000)
    recordIncomingRequest(store, {
      pubkey: 'b'.repeat(64),
      requestId: '11111111-1111-4111-8111-111111111111',
      requestRumorId: 'c'.repeat(64),
      declaredName: 'Beto',
      note: 'hola',
      relays: [board.url],
      // Fresh, against the same clock doctor uses: a 2023 timestamp would be expired by the time
      // `requests` ran, and doctor would be announcing something that vanishes when the person
      // types the command it just told them to type.
      now,
    })
    store.close()
    const requests = check(await runDoctor(doctorOptions()), 'Solicitudes pendientes')
    expect(requests.detail).toContain('1')
    expect(requests.detail).toContain('requests')
  })

  it('does not count a request that has already aged out', async () => {
    await seedIdentity()
    const store = await openStore(identityHome, { relayPolicy: allowAnyRelay })
    const { NOSTR } = await import('@agentbridge/core')
    recordIncomingRequest(store, {
      pubkey: 'd'.repeat(64),
      requestId: '22222222-2222-4222-8222-222222222222',
      requestRumorId: 'e'.repeat(64),
      declaredName: 'Vieja',
      note: '',
      relays: [board.url],
      now: Math.floor(Date.now() / 1000) - NOSTR.requestMaxAgeSeconds - 60,
    })
    store.close()
    expect(check(await runDoctor(doctorOptions()), 'Solicitudes pendientes').detail).toContain('ninguna')
  })
})

describe('runDoctor with a dedicated profile', () => {
  it('fails when the locked-down settings are missing', async () => {
    await seedIdentity()
    await mkdir(profileHome, { recursive: true })
    expect(check(await runDoctor(doctorOptions({ profileHome })), 'Permisos del respondedor').ok).toBe(false)
  })

  it('passes with the settings setupResponder writes', async () => {
    await seedIdentity()
    await mkdir(profileHome, { recursive: true })
    const { responderSettings } = await import('../src/commands/setup-responder')
    await writeFile(join(profileHome, 'settings.json'), `${JSON.stringify(responderSettings(), null, 2)}\n`, { mode: 0o600 })
    expect(check(await runDoctor(doctorOptions({ profileHome })), 'Permisos del respondedor').ok).toBe(true)
  })

  it('reports the login check as failed when the runner reports its own bound firing, and passes it a signal', async () => {
    // A hung `claude auth status` is not something doctor itself can bound with a mock runner —
    // a mock has no OS process for anything to kill. That is proven separately, against a real
    // child, in setup-responder.test.ts's "kills a real hung child" test for `defaultRunner`
    // (the production runner). This test only checks doctor's half of the contract: it must pass
    // an AbortSignal through, and must map the bounded runner's own report of that signal firing
    // (code 124) to the existing Spanish detail — fast, with no real waiting.
    await mkdir(profileHome, { recursive: true })
    const { responderSettings } = await import('../src/commands/setup-responder')
    await writeFile(join(profileHome, 'settings.json'), `${JSON.stringify(responderSettings(), null, 2)}\n`, { mode: 0o600 })
    await mkdir(join(profileHome, 'claude'), { recursive: true })
    let sawSignal: AbortSignal | undefined
    const boundedRunner = async (_command: string, _args: string[], opts: { env: NodeJS.ProcessEnv; signal?: AbortSignal }) => {
      sawSignal = opts.signal
      return { code: 124, stdout: '', stderr: '' }
    }
    const checks = await runDoctor(doctorOptions({ profileHome, run: boundedRunner }))
    const auth = check(checks, 'Sesión iniciada en el perfil dedicado')
    expect(auth.ok).toBe(false)
    expect(auth.detail).toContain('15 segundos')
    expect(sawSignal).toBeInstanceOf(AbortSignal)
  })
})
