import { CLI_COMMAND, loadOrCreateIdentity, openStore, recordIncomingRequest, setProfile } from '@agentbridge/core'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { plainSocketFactory, startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { cloudSyncedPath, runDoctor } from '../src/commands/doctor'
import { RESPONDER_CONFIG_FILE } from '../src/commands/responder'

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
function check(checks: Array<{ name: string; ok: boolean; detail: string; blocking: boolean; security: boolean }>, name: string) {
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
    await writeFile(join(profileHome, RESPONDER_CONFIG_FILE), '{}')
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
    // I3/Minor 5: nothing this person's own throwaway key could have caused, so the wording never
    // points at "this key" — every wrap is signed by a fresh one the board has never seen before.
    expect(boardCheck.detail).not.toContain('llave')
  })

  it('tells apart a board that never opened a connection from one that answered and refused', async () => {
    // I3: a board that is simply unreachable (down, wrong port, failed handshake) must not be
    // reported with the same "no aceptó publicar" a board that actually answered OK false gets —
    // that is what made the dead default board (I2) misread as an active refusal instead of an
    // outage. Nothing here is a real network: ws://127.0.0.1:1 is loopback with nothing listening.
    await seedIdentity()
    const store = await openStore(identityHome, { relayPolicy: allowAnyRelay })
    setProfile(store, { relays: ['ws://127.0.0.1:1'], now: 1_700_000_001 })
    store.close()
    const boardCheck = check(await runDoctor(doctorOptions()), 'Tablero ws://127.0.0.1:1')
    expect(boardCheck.ok).toBe(false)
    expect(boardCheck.detail).toContain('no pude conectarme')
    expect(boardCheck.detail).not.toContain('no aceptó publicar')
  })

  it('reports a real refusal as a refusal even when the relay uses NIP-01\'s own "error:" prefix', async () => {
    // Follow-up to I3: NIP-01 defines `error:` as a RELAY's own catch-all prefix for a genuine
    // `OK false` — the exact same prefix this codebase's own synthesized connection failures use.
    // Classifying "could not connect" vs. "refused" by matching that text would misread a
    // perfectly spec-compliant refusal as an outage, which is the same misdiagnosis I3 exists to
    // prevent. The board here connects fine and then explicitly refuses with "error: …" — this
    // must still read as a refusal, not as "no pude conectarme".
    await seedIdentity()
    board.options = { ...board.options, rejectWrites: 'error: some internal relay problem' }
    const boardCheck = check(await runDoctor(doctorOptions()), `Tablero ${board.url}`)
    expect(boardCheck.ok).toBe(false)
    expect(boardCheck.detail).toContain('no aceptó publicar')
    expect(boardCheck.detail).not.toContain('no pude conectarme')
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
    await writeFile(join(profileHome, 'settings.json'), `${JSON.stringify(responderSettings({ kind: 'folder' }, { shareDir, identityHome, profileHome, home: identityHome }), null, 2)}\n`, { mode: 0o600 })
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
    await writeFile(join(profileHome, 'settings.json'), `${JSON.stringify(responderSettings({ kind: 'folder' }, { shareDir, identityHome, profileHome, home: identityHome }), null, 2)}\n`, { mode: 0o600 })
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

// Task 3 of 0.4: doctor holds settings.json to the scope responder.json records, says which mode is
// in force, and in mode 2 examines every extra folder the way it examines the shared one.
describe('runDoctor with the scope saved in responder.json', () => {
  // A stand-in for the personal folder: nothing here reads or names the real one.
  let home: string
  beforeEach(async () => {
    home = join(root, 'casa')
    await mkdir(home, { recursive: true })
  })

  type Scope = { kind: 'folder' } | { kind: 'home' } | { kind: 'folders'; extra: string[] }
  async function profileFor(scope: Scope, settingsScope: Scope = scope): Promise<void> {
    const { responderSettings } = await import('../src/commands/setup-responder')
    await mkdir(profileHome, { recursive: true })
    const config = { version: 2, shareDir, identityHome, model: 'sonnet', effort: 'low', scope }
    await writeFile(join(profileHome, RESPONDER_CONFIG_FILE), JSON.stringify(config), { mode: 0o600 })
    const settings = responderSettings(settingsScope, { shareDir, identityHome, profileHome, home })
    await writeFile(join(profileHome, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  }
  const doctorWith = () => runDoctor(doctorOptions({ profileHome, home }))

  // Review finding M3 of task 1, doctor's half: the saved scope, not a default. A mode-1 file
  // under a mode-3 responder.json has every mode-1 rule and the fence — only a check against the
  // saved scope sees that the caja fuerte and the personal folder are not what the file says.
  it('fails the fence check when responder.json says mode 3 and settings.json is the mode-1 file', async () => {
    await profileFor({ kind: 'home' }, { kind: 'folder' })
    const fence = check(await doctorWith(), 'Permisos del respondedor')
    expect(fence.ok).toBe(false)
    expect(fence.blocking).toBe(true)
    expect(fence.security).toBe(true)
    expect(fence.detail).toMatch(/caja fuerte/)
  })

  it('passes the fence check for mode 3 with the file setupResponder writes for it', async () => {
    await profileFor({ kind: 'home' })
    expect(check(await doctorWith(), 'Permisos del respondedor').ok).toBe(true)
  })

  it('names the mode as information, in the words setup used', async () => {
    for (const [scope, words] of [
      [{ kind: 'folder' }, 'solo la carpeta compartida'],
      [{ kind: 'home' }, 'toda tu carpeta personal, menos la caja fuerte'],
    ] as const) {
      await profileFor(scope)
      const mode = check(await doctorWith(), 'Alcance del respondedor')
      expect(mode.ok).toBe(true)
      expect(mode.blocking).toBe(false)
      expect(mode.detail).toContain(words)
    }
  })

  // The consent screen was corrected to say what the caja fuerte is — the best-known places — and
  // what it is not (task 2 review, I2). Doctor's line is the one read months later; it must not
  // promise more than the list protects.
  it('says in mode 3 what the caja fuerte covers, and what it does not', async () => {
    await profileFor({ kind: 'home' })
    const checks = await doctorWith()
    const caja = check(checks, 'Caja fuerte')
    expect(caja.ok).toBe(true)
    expect(caja.blocking).toBe(false)
    expect(caja.detail).toContain('los lugares más conocidos donde se guardan contraseñas y llaves')
    expect(caja.detail).toContain('tu llave de AgentBridge')
    expect(caja.detail).toMatch(/no lo cubre todo/i)
    expect(caja.detail).not.toMatch(/tus secretos/)
  })

  it('does not print the caja fuerte line in mode 1, where there is no caja fuerte', async () => {
    await profileFor({ kind: 'folder' })
    expect((await doctorWith()).find((c) => c.name === 'Caja fuerte')).toBeUndefined()
  })

  describe('mode 2', () => {
    let extra: string[]
    beforeEach(async () => {
      // Inside the stand-in personal folder, where people keep the folders they would add.
      extra = [join(home, 'notas'), join(home, 'clientes')]
      for (const dir of extra) await mkdir(dir, { recursive: true })
    })

    it('names the mode and every extra folder', async () => {
      await profileFor({ kind: 'folders', extra })
      const mode = check(await doctorWith(), 'Alcance del respondedor')
      expect(mode.detail).toContain('la carpeta compartida y 2 carpetas más')
      for (const dir of extra) expect(mode.detail).toContain(dir)
    })

    it('fails the fence check when settings.json is the mode-1 file', async () => {
      await profileFor({ kind: 'folders', extra }, { kind: 'folder' })
      expect(check(await doctorWith(), 'Permisos del respondedor').ok).toBe(false)
    })

    // Each extra folder gets its own lines, named, so a failure says which folder it is about — and
    // setup, which prints only the detail, can say it too.
    it('examines each extra folder on its own lines, and a clean one passes', async () => {
      await profileFor({ kind: 'folders', extra })
      const checks = await doctorWith()
      for (const dir of extra) {
        expect(check(checks, `Sin enlaces que salgan de la carpeta extra ${dir}`).ok).toBe(true)
        expect(check(checks, `Sin configuración de proyecto en la carpeta extra ${dir}`).ok).toBe(true)
      }
    })

    it('flags an escaping link in one extra folder, naming that folder and only that one', async () => {
      const [clean, leaky] = extra as [string, string]
      await symlink(join(root, 'identidad'), join(leaky, 'atajo'))
      await profileFor({ kind: 'folders', extra })
      const checks = await doctorWith()
      const bad = check(checks, `Sin enlaces que salgan de la carpeta extra ${leaky}`)
      expect(bad.ok).toBe(false)
      expect(bad.blocking).toBe(true)
      expect(bad.security).toBe(true)
      expect(bad.detail).toContain(leaky)
      expect(check(checks, `Sin enlaces que salgan de la carpeta extra ${clean}`).ok).toBe(true)
    })

    it('flags project configuration in an extra folder, naming it', async () => {
      const [, withAgents] = extra as [string, string]
      await writeFile(join(withAgents, 'AGENTS.md'), '# instructions')
      await profileFor({ kind: 'folders', extra })
      const bad = check(await doctorWith(), `Sin configuración de proyecto en la carpeta extra ${withAgents}`)
      expect(bad.ok).toBe(false)
      expect(bad.detail).toContain(withAgents)
    })

    // The persona CLAUDE.md belongs in the working directory only; an extra folder without one is
    // what it should be, and a line saying "falta CLAUDE.md" about it would be a false alarm.
    it('does not ask an extra folder for a CLAUDE.md', async () => {
      await profileFor({ kind: 'folders', extra })
      const checks = await doctorWith()
      expect(checks.filter((c) => c.name === 'Carpeta compartida')).toHaveLength(0)
      for (const c of checks) expect(c.detail).not.toMatch(/Falta CLAUDE\.md/)
    })

    it('reports an extra folder that is gone, by name, as blocking — instead of walking nothing', async () => {
      const [, gone] = extra as [string, string]
      await profileFor({ kind: 'folders', extra })
      await rm(gone, { recursive: true })
      const checks = await doctorWith()
      const missing = check(checks, `Carpeta extra ${gone}`)
      expect(missing.ok).toBe(false)
      expect(missing.blocking).toBe(true)
      expect(missing.detail).toContain(gone)
      // Nothing claims to have looked inside a folder that is not there.
      expect(checks.find((c) => c.name === `Sin enlaces que salgan de la carpeta extra ${gone}`)).toBeUndefined()
    })
  })
})

describe('runDoctor with --share alone (no --profile)', () => {
  // I1: every shared-folder check used to live inside the profile-gated function, so
  // `doctor --share <carpeta>` with no `--profile` examined nothing in it and still exited 0.
  // These prove the opposite is now true: --share brings its own checks, unconditionally.
  it('reports a shared folder missing its persona file even with no --profile', async () => {
    await seedIdentity()
    const checks = await runDoctor({ ...doctorOptions(), shareDir })
    expect(check(checks, 'Carpeta compartida').ok).toBe(false)
    // Nothing here required --profile: the check ran, and named its own missing CLAUDE.md, not
    // the profile-only checks (which must not even appear when --profile was never given).
    expect(checks.find((c) => c.name === 'Permisos del respondedor')).toBeUndefined()
  })

  it('catches an AGENTS.md sitting in the shared folder even with no --profile', async () => {
    // The exact probe from the final review: an AGENTS.md injects itself into the responder's
    // instructions at every session start, and used to sail through a --share-only run.
    await seedIdentity()
    await writeFile(join(shareDir, 'AGENTS.md'), '# instructions')
    const checks = await runDoctor({ ...doctorOptions(), shareDir })
    const projectConfig = check(checks, 'Sin configuración de proyecto en la carpeta compartida')
    expect(projectConfig.ok).toBe(false)
    expect(projectConfig.detail).toContain('se inyectan como instrucciones')
    // The exit code doctorCommand derives from `checks.some(c => !c.ok)` must therefore be 1 —
    // proven here at the level runDoctor actually controls: at least one check failed.
    expect(checks.some((c) => !c.ok)).toBe(true)
  })

  it('does not report the profile/share cross-check when --profile was never given', async () => {
    await seedIdentity()
    const checks = await runDoctor({ ...doctorOptions(), shareDir })
    expect(checks.find((c) => c.name === 'El perfil dedicado está fuera de la carpeta compartida')).toBeUndefined()
  })
})

describe('runDoctor with --share and --profile together', () => {
  // Minor (follow-up review): nothing exercised this combination, which is the only one that runs
  // the cross-check comparing the two folders — proven here in both directions.
  it('reports the cross-check as passing when the profile is outside the shared folder', async () => {
    await seedIdentity()
    await mkdir(profileHome, { recursive: true })
    const checks = await runDoctor({ ...doctorOptions(), shareDir, profileHome })
    const crossCheck = check(checks, 'El perfil dedicado está fuera de la carpeta compartida')
    expect(crossCheck.ok).toBe(true)
    // Both sides' own checks ran too — this combination must not silently drop either.
    expect(checks.some((c) => c.name === 'Carpeta compartida')).toBe(true)
    expect(checks.some((c) => c.name === 'Permisos del respondedor')).toBe(true)
  })

  it('fails the cross-check when the dedicated profile sits inside the shared folder', async () => {
    await seedIdentity()
    const profileInsideShare = join(shareDir, 'perfil')
    await mkdir(profileInsideShare, { recursive: true })
    const checks = await runDoctor({ ...doctorOptions(), shareDir, profileHome: profileInsideShare })
    const crossCheck = check(checks, 'El perfil dedicado está fuera de la carpeta compartida')
    expect(crossCheck.ok).toBe(false)
    expect(crossCheck.detail).toContain('setup-responder')
  })
})

describe('runDoctor login remediation text', () => {
  // The old text told a person to paste `CLAUDE_CONFIG_DIR='…' claude` themselves — the exact
  // shell-syntax defect this plan fixes in `setup` (I5), which survived here untouched. This
  // proves doctor's own copy of it is gone, and names the program that does it instead.
  it('never asks a person to paste CLAUDE_CONFIG_DIR=... claude', async () => {
    await mkdir(profileHome, { recursive: true })
    const { responderSettings } = await import('../src/commands/setup-responder')
    await writeFile(join(profileHome, 'settings.json'), `${JSON.stringify(responderSettings({ kind: 'folder' }, { shareDir, identityHome, profileHome, home: identityHome }), null, 2)}\n`, { mode: 0o600 })
    await mkdir(join(profileHome, 'claude'), { recursive: true })
    const notLoggedIn = async (_command: string, _args: string[], _opts: { env: NodeJS.ProcessEnv; signal?: AbortSignal }) => ({
      code: 0,
      stdout: JSON.stringify({ loggedIn: false }),
      stderr: '',
    })
    const checks = await runDoctor(doctorOptions({ profileHome, run: notLoggedIn }))
    const perfil = check(checks, 'Sesión iniciada en el perfil dedicado')
    expect(perfil.ok).toBe(false)
    expect(perfil.detail).not.toMatch(/CLAUDE_CONFIG_DIR=/)
    // Not just the word "setup" — a regression back to a bare `corre setup` (the exact defect
    // this test exists to kill) would still contain the word "setup" and pass a looser assertion.
    expect(perfil.detail).toContain(CLI_COMMAND)
  })
})

describe('cloudSyncedPath', () => {
  it('spots OneDrive, which is where a Windows home folder usually lives', () => {
    expect(cloudSyncedPath('C:\\Users\\dani\\OneDrive\\Documentos\\.agentbridge')).toBe('OneDrive')
  })

  it('spots iCloud Drive on macOS', () => {
    expect(cloudSyncedPath('/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/ab')).toBe('iCloud')
  })

  it('spots Dropbox and Google Drive', () => {
    expect(cloudSyncedPath('/home/j/Dropbox/ab')).toBe('Dropbox')
    expect(cloudSyncedPath('/home/j/Google Drive/ab')).toBe('Google Drive')
  })

  // I1: since macOS 12.3, OneDrive/Dropbox/Google Drive all mount under
  // ~/Library/CloudStorage with NO spaces around the hyphen — "OneDrive-Contoso", not
  // "OneDrive - Contoso" — and Dropbox Business has always used "Dropbox (Company)". A macOS
  // user in any of these gets no warning at all if only the Windows spelling is recognised,
  // which is exactly the silent-upload failure this check exists to prevent.
  it('spots the real macOS CloudStorage spellings, with no spaces around the hyphen', () => {
    expect(cloudSyncedPath('/Users/ana/Library/CloudStorage/OneDrive-Contoso/ab')).toBe('OneDrive')
    expect(cloudSyncedPath('/Users/ana/Library/CloudStorage/GoogleDrive-ana@gmail.com/Shared drives/x/ab')).toBe('Google Drive')
  })

  it('spots Dropbox Business, spelled "Dropbox (Company)"', () => {
    expect(cloudSyncedPath('/home/j/Dropbox (Contoso)/ab')).toBe('Dropbox')
    expect(cloudSyncedPath('/home/j/Dropbox (Personal)/ab')).toBe('Dropbox')
  })

  it('does not fire on a folder that merely contains the word', () => {
    // "mi-onedrive-notas" is not OneDrive, and a false alarm about a secret key is a sentence
    // that makes a person distrust every other line doctor prints.
    expect(cloudSyncedPath('/home/j/mi-onedrive-notas/ab')).toBeNull()
    expect(cloudSyncedPath('/home/j/proyectos/ab')).toBeNull()
  })
})

describe('doctor on Windows', () => {
  it('does not ask for POSIX permissions that cannot exist there', async () => {
    const home = join(root, 'win')
    await seedIdentity(home)
    await chmod(join(home, 'identity.json'), 0o666)
    // I5: the directory too, not only the file. loadOrCreateIdentity creates the home at 0700, so
    // an implementation that skipped only the file-mode comparison (and left the directory one
    // running) would still land on the success branch and this test would not have caught it —
    // the person's actual reported message had both halves: "la llave está en 666 ... · su
    // carpeta está en 666".
    await chmod(home, 0o755)
    const checks = await runDoctor(doctorOptions({ identityHome: home, platform: 'win32' }))
    expect(check(checks, 'Llave de AgentBridge').detail).not.toMatch(/0600|0700|666|755/)
  })

  it('still asks for them on macOS and Linux', async () => {
    const home = join(root, 'posix')
    await seedIdentity(home)
    await chmod(join(home, 'identity.json'), 0o644)
    const checks = await runDoctor(doctorOptions({ identityHome: home, platform: 'darwin' }))
    const key = check(checks, 'Llave de AgentBridge')
    expect(key.ok).toBe(false)
    expect(key.detail).toMatch(/0600/)
  })

  it('warns about a key in a cloud-synced folder, without blocking', async () => {
    const home = join(root, 'OneDrive', '.agentbridge')
    await seedIdentity(home)
    const checks = await runDoctor(doctorOptions({ identityHome: home, platform: 'win32' }))
    const warning = check(checks, 'Carpeta sincronizada con la nube')
    expect(warning.ok).toBe(false)
    // A key that is already in OneDrive is already uploaded. Telling someone to stop everything
    // does not un-upload it; telling them what happened and how to move it does.
    expect(warning.blocking).toBe(false)
    expect(warning.detail).toMatch(/OneDrive/)
    // M4: the temp home literally contains "OneDrive" as a path segment, so a detail that printed
    // the whole path would also match /OneDrive/ above. This is the assertion that actually pins
    // "name the provider, never the path".
    expect(warning.detail).not.toContain(home)
  })

  it('says nothing about the cloud when the folder is an ordinary one', async () => {
    const home = join(root, 'normal')
    await seedIdentity(home)
    const checks = await runDoctor(doctorOptions({ identityHome: home, platform: 'darwin' }))
    expect(checks.find((c) => c.name === 'Carpeta sincronizada con la nube')).toBeUndefined()
  })
})

describe('the cloud warning fires on every platform, not only Windows', () => {
  // I4: the push is deliberately not gated on `platform` — iCloud Drive syncs macOS home folders
  // too — but the only cloud-shaped test above runs on win32. Wrapping the push in
  // `if (platform === 'win32')` would keep every other test green while silently deleting this
  // half of the feature, including the `iCloud` entry, which can only ever match on macOS.
  it('warns about a cloud-synced folder on macOS too', async () => {
    const home = join(root, 'OneDrive', '.agentbridge')
    await seedIdentity(home)
    const checks = await runDoctor(doctorOptions({ identityHome: home, platform: 'darwin' }))
    const warning = check(checks, 'Carpeta sincronizada con la nube')
    expect(warning.ok).toBe(false)
    expect(warning.blocking).toBe(false)
    expect(warning.detail).toMatch(/OneDrive/)
  })
})

describe('what blocks and what does not', () => {
  it('marks a missing key as blocking; the board loop below is vacuous by construction', async () => {
    // M5: with no identity, runDoctor never enters the board loop at all (it is gated on
    // `identityResult.identity`), so the filter below is `[]` and the `for` body never runs — it
    // proves nothing about per-board blocking. That is covered for real by 'marks the aggregate
    // board check as blocking only when every board fails' and the mixed-board test below.
    const checks = await runDoctor(doctorOptions({ identityHome: join(root, 'vacia'), platform: 'darwin' }))
    expect(check(checks, 'Llave de AgentBridge').blocking).toBe(true)
    for (const c of checks.filter((c) => c.name.startsWith('Tablero '))) expect(c.blocking).toBe(false)
    // I3: `[].every(...)` is `true`, so a missing `boardChecks.length > 0` guard would fire the
    // aggregate on every run where the board loop never executed at all — telling a brand-new
    // person with no key to check their internet connection instead of to create one.
    expect(checks.find((c) => c.name === 'Tableros públicos')).toBeUndefined()
  })

  it('marks the aggregate board check as blocking only when every board fails', async () => {
    // The regression this guards against: a per-board `blocking: false` copied onto the
    // aggregate check too, which would make a total outage look like "worth knowing" instead of
    // "you cannot answer anyone right now" — see the brief's Q2/D2-shaped failure history.
    await seedIdentity()
    const store = await openStore(identityHome, { relayPolicy: allowAnyRelay })
    setProfile(store, { relays: ['ws://127.0.0.1:1'], now: 1_700_000_002 })
    store.close()
    const checks = await runDoctor(doctorOptions())
    const boardChecks = checks.filter((c) => c.name.startsWith('Tablero '))
    expect(boardChecks.length).toBeGreaterThan(0)
    for (const c of boardChecks) {
      expect(c.ok).toBe(false)
      expect(c.blocking).toBe(false)
    }
    const aggregate = check(checks, 'Tableros públicos')
    expect(aggregate.ok).toBe(false)
    expect(aggregate.blocking).toBe(true)
  })

  it('does not fire the aggregate check when boards are mixed: one works, one does not', async () => {
    // I2: with one board down and one up, `every(c => !c.ok)` is false and `some(c => !c.ok)` is
    // true. The other two tests here use all-fail and all-pass relay lists, so both give the
    // identical answer under `every` or `some` — only a genuinely mixed case tells them apart.
    await seedIdentity()
    const store = await openStore(identityHome, { relayPolicy: allowAnyRelay })
    setProfile(store, { relays: [board.url, 'ws://127.0.0.1:1'], now: 1_700_000_003 })
    store.close()
    const checks = await runDoctor(doctorOptions())
    const boardChecks = checks.filter((c) => c.name.startsWith('Tablero '))
    expect(boardChecks.some((c) => c.ok)).toBe(true)
    expect(boardChecks.some((c) => !c.ok)).toBe(true)
    expect(checks.find((c) => c.name === 'Tableros públicos')).toBeUndefined()
  })

  it('does not add the aggregate board check when at least one board works', async () => {
    await seedIdentity()
    const checks = await runDoctor(doctorOptions())
    expect(checks.find((c) => c.name === 'Tableros públicos')).toBeUndefined()
  })
})

describe('Llave de AgentBridge: blocking follows the risk, not the check', () => {
  // I6: a permission bit is hygiene — the key still works, and loadOrCreateIdentity now
  // self-repairs it on its next load (see identity.test.ts) — so it must not stop a working
  // install. Only the key actually sitting inside the shared folder, where any incoming question
  // can read it, blocks.
  it('does not block on a permission bit alone', async () => {
    await seedIdentity()
    await chmod(join(identityHome, 'identity.json'), 0o644)
    const key = check(await runDoctor(doctorOptions()), 'Llave de AgentBridge')
    expect(key.ok).toBe(false)
    expect(key.blocking).toBe(false)
    // The remedy has to name a real command now that it exists: re-running setup tightens the
    // mode automatically instead of asking for a chmod we are not allowed to print.
    expect(key.detail).toContain(CLI_COMMAND)
  })

  it('blocks when the key sits inside the shared folder', async () => {
    const inside = join(shareDir, 'identidad')
    await seedIdentity(inside)
    const key = check(await runDoctor({ ...doctorOptions(), identityHome: inside, shareDir }), 'Llave de AgentBridge')
    expect(key.ok).toBe(false)
    expect(key.blocking).toBe(true)
  })
})

// Task 5 review, I4: `blocking` answers "can this person answer questions at all", which is the
// wrong question to ask about the key's safety — the two most serious things doctor can report
// (a key in somebody's cloud folder, a key anyone on the machine can read) do not stop a single
// question from being answered. `security` is what keeps `setup` from hiding them, so the flag
// has to be on the checks whose subject really is who can read the key or the shared folder,
// and off everywhere else — a flag set everywhere means nothing.
describe('the security flag', () => {
  it('marks the cloud-synced key warning, which does not block', async () => {
    const home = join(root, 'OneDrive', '.agentbridge')
    await seedIdentity(home)
    const warning = check(await runDoctor(doctorOptions({ identityHome: home })), 'Carpeta sincronizada con la nube')
    expect(warning.blocking).toBe(false)
    expect(warning.security).toBe(true)
  })

  it('marks the key check even when a permission bit alone does not block', async () => {
    await seedIdentity()
    await chmod(join(identityHome, 'identity.json'), 0o644)
    const key = check(await runDoctor(doctorOptions()), 'Llave de AgentBridge')
    expect(key.ok).toBe(false)
    expect(key.blocking).toBe(false)
    expect(key.security).toBe(true)
  })

  it('marks every check about the shared folder and the responder fence', async () => {
    const checks = await runDoctor(doctorOptions({ shareDir, profileHome }))
    for (const name of [
      'Carpeta compartida',
      'Sin enlaces que salgan de la carpeta',
      'Sin configuración de proyecto en la carpeta compartida',
      'El perfil dedicado está fuera de la carpeta compartida',
      'Permisos del respondedor',
    ]) {
      expect(check(checks, name).security, name).toBe(true)
    }
  })

  it('leaves it off the checks that are about working, not about safety', async () => {
    await seedIdentity()
    const checks = await runDoctor(doctorOptions({ shareDir, profileHome }))
    for (const name of ['Base de datos', 'Candado del canal', 'Solicitudes pendientes', 'Configuración del respondedor', 'Plugin instalado en el perfil dedicado', 'Sesión iniciada en el perfil dedicado']) {
      expect(check(checks, name).security, name).toBe(false)
    }
    for (const c of checks.filter((c) => c.name.startsWith('Tablero '))) expect(c.security, c.name).toBe(false)
  })
})
