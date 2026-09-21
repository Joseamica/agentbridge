import { CLI_COMMAND, decodeLink, getProfile, loadIdentity, loadOrCreateIdentity, openStore, sanitizeRelayList, setProfile } from '@agentbridge/core'
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { plainSocketFactory, startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { RESPONDER_CONFIG_FILE } from '../src/commands/responder'
import { applyRelays, runSetup, setupCommand, type SetupContext } from '../src/commands/setup'
import { memoryOutput, PromptEOF } from '../src/context'

const allowAnyRelay = (inputs: readonly unknown[]): string[] => inputs.filter((x): x is string => typeof x === 'string').slice(0, 5)

let root: string
let identityHome: string
let profileHome: string
let shareDir: string
let repoDir: string
let board: FakeBoard
const cleanups: Array<() => Promise<void> | void> = []

function scripted(answers: string[]) {
  const queue = [...answers]
  const asked: string[] = []
  const prompt = async (question: string) => {
    asked.push(question)
    const next = queue.shift()
    if (next === undefined) throw new PromptEOF()
    return next
  }
  // A leftover answer means the flow asked fewer questions than the test assumed, so the test is
  // exercising a different path than its name claims.
  const expectDrained = () => expect(queue).toEqual([])
  return { prompt, asked, expectDrained }
}

const noopRunner = async () => ({ code: 0, stdout: '', stderr: '' })

function context(o: Partial<SetupContext> & { prompt: SetupContext['prompt'] }): SetupContext {
  return {
    home: identityHome,
    out: memoryOutput(),
    env: process.env,
    run: noopRunner,
    relayPolicy: allowAnyRelay,
    createSocket: plainSocketFactory,
    repoDir,
    profileHome,
    ...o,
  } as SetupContext
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ab-setup-'))
  identityHome = join(root, 'identidad')
  profileHome = join(root, 'perfil')
  shareDir = join(root, 'compartido')
  repoDir = join(root, 'repo')
  await mkdir(join(repoDir, 'plugins/agentbridge/dist'), { recursive: true })
  await writeFile(join(repoDir, 'plugins/agentbridge/dist/server.js'), '// bundle')
  board = await startFakeBoard()
  cleanups.push(() => board.close())
})

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function seedIdentityAndProfile(): Promise<void> {
  await loadOrCreateIdentity(identityHome)
  const store = await openStore(identityHome, { relayPolicy: allowAnyRelay })
  setProfile(store, { name: 'Ana', relays: [board.url], now: 1_700_000_000 })
  store.close()
}

describe('the identity step', () => {
  it('creates the key, asks for a name once, and keeps the same key on a second run', async () => {
    const out = memoryOutput()
    const first = scripted(['Ana', '2', 'n', 'n'])
    await runSetup(context({ prompt: first.prompt, out }))
    first.expectDrained()
    const created = await loadIdentity(identityHome)
    expect(created).not.toBeNull()

    // The second run must not replace the key: a new one would silently orphan every permission
    // this person already has, and nobody would connect them again without being asked.
    const second = scripted(['2', 'n', 'n'])
    await runSetup(context({ prompt: second.prompt, out: memoryOutput() }))
    second.expectDrained()
    expect((await loadIdentity(identityHome))?.publicKey).toBe(created?.publicKey)
    // And it did not ask for the name again.
    expect(second.asked.some((q) => q.includes('nombre'))).toBe(false)
  })

  it("prints this person's own link, and it decodes to their own key", async () => {
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['Ana', '2', 'n', 'n'])
    await runSetup(context({ prompt, out }))
    expectDrained()
    const printed = out.lines.flatMap((line) => line.match(/agentbridge:nprofile1[0-9a-z]+/g) ?? [])
    expect(printed.length).toBeGreaterThan(0)
    const identity = await loadIdentity(identityHome)
    expect(decodeLink(printed[0]!).publicKey).toBe(identity?.publicKey)
  })

  it('refuses a name longer than the profile allows, and asks again', async () => {
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['x'.repeat(81), 'Ana', '2', 'n', 'n'])
    await runSetup(context({ prompt, out }))
    expectDrained()
    const store = await openStore(identityHome, { relayPolicy: allowAnyRelay })
    expect(getProfile(store).name).toBe('Ana')
    store.close()
  })
})

describe('the asking side', () => {
  it('connects with the link the person pastes', async () => {
    await seedIdentityAndProfile()
    const links: string[] = []
    const { prompt, expectDrained } = scripted(['2', 's', 'agentbridge:nprofile1ejemplo', 'n'])
    await runSetup(context({ prompt, connectWith: async (link: string) => void links.push(link) }))
    expectDrained()
    expect(links).toEqual(['agentbridge:nprofile1ejemplo'])
  })

  it('says what to do later when the person does not have a link yet', async () => {
    await seedIdentityAndProfile()
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['2', 'n', 'n'])
    await runSetup(context({ prompt, out }))
    expectDrained()
    const text = out.lines.join('\n')
    // Every instruction is copy-pasteable: never a bare command name.
    expect(text).toContain('connect')
    expect(text).not.toMatch(/^\s*connect\b/m)
  })

  it('registers the MCP server when asked to', async () => {
    await seedIdentityAndProfile()
    const calls: string[][] = []
    const { prompt, expectDrained } = scripted(['2', 'n', 's'])
    await runSetup(
      context({
        prompt,
        run: async (command, args) => {
          calls.push([command, ...args])
          return { code: 0, stdout: '', stderr: '' }
        },
      }),
    )
    expectDrained()
    expect(calls.some((c) => c[0] === 'claude' && c.includes('mcp') && c.includes('add'))).toBe(true)
  })
})

describe('the answering side', () => {
  it('prepares the shared folder and the dedicated profile, and never writes AgentBridge state into it', async () => {
    await seedIdentityAndProfile()
    const { prompt, expectDrained } = scripted(['1', shareDir, ''])
    await runSetup(context({ prompt }))
    expectDrained()
    await expect(access(join(profileHome, RESPONDER_CONFIG_FILE))).resolves.toBeUndefined()
    await expect(access(join(shareDir, 'CLAUDE.md'))).resolves.toBeUndefined()
    // Q1: the dedicated folder is Claude's profile, not a second AgentBridge home.
    await expect(access(join(profileHome, 'identity.json'))).rejects.toThrow()
    await expect(access(join(profileHome, 'agentbridge.db'))).rejects.toThrow()
    const config = JSON.parse(await readFile(join(profileHome, RESPONDER_CONFIG_FILE), 'utf8'))
    expect(config.identityHome).toBe(identityHome)
  })

  it('refuses a shared folder that would contain the identity', async () => {
    await seedIdentityAndProfile()
    const { prompt } = scripted(['1', root, ''])
    await expect(runSetup(context({ prompt }))).rejects.toThrow(/llave|identidad/i)
  })

  it("tells the person to give their link to whoever will ask them", async () => {
    await seedIdentityAndProfile()
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['1', shareDir, ''])
    await runSetup(context({ prompt, out }))
    expectDrained()
    const text = out.lines.join('\n')
    expect(text).toMatch(/agentbridge:nprofile1/)
    expect(text).toMatch(/dáselo|pásaselo|mándaselo/i)
  })

  it('quotes a non-default profile path with a space so the printed responder command still runs (Minor 1)', async () => {
    // `responder` (not start.sh) is what gets printed now; a non-default --profile still has to
    // be named on that line, or the printed command would start the wrong (default) profile.
    await seedIdentityAndProfile()
    const spacedProfile = join(root, 'mi respondedor')
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['1', shareDir, ''])
    await runSetup(context({ prompt, out, profileHome: spacedProfile }))
    expectDrained()
    const text = out.lines.join('\n')
    expect(text).toContain(`${CLI_COMMAND} responder --profile '${spacedProfile}'`)
  })

  it("lists doctor's failing checks as pending work instead of claiming it is done", async () => {
    await seedIdentityAndProfile()
    const out = memoryOutput()
    // A real diagnostic failure, not a crash: the bundle exists (so setupResponder completes) and
    // the board refuses reads, so doctor's own board check fails and the summary has to say so.
    board.options = { ...board.options, rejectReads: true }
    const { prompt, expectDrained } = scripted(['1', shareDir, ''])
    await runSetup(context({ prompt, out }))
    expectDrained()
    const text = out.lines.join('\n')
    // Searching the whole output would pass on the "[falta] Tablero …" line doctor prints on its
    // own. What this test is about is the summary: the failing check has to be repeated under
    // "Pendiente:", where the person looks for what is left to do.
    const summary = text.slice(text.indexOf('Pendiente:'))
    expect(summary).toMatch(/Tablero/)
  })
})

// This coverage was deleted with the 0.1 relay in commit 7054236 and promised to return once
// plans 3/4 rewrote `setup` — the underlying logic (scanShareDirForDanger, the CONFIRMAR gate,
// the hard refusals) is unchanged from 0.1, but until now nothing in the repo exercised it. Every
// test here drives the real flow through `runSetup`, the same way a person would answer it, not
// `assessShareDir`/`scanShareDirForDanger` in isolation.
describe('the shared-folder protection', () => {
  it('flags a git repo and a credential-looking file, and only proceeds once CONFIRMAR is typed', async () => {
    await seedIdentityAndProfile()
    await mkdir(join(shareDir, '.git'), { recursive: true })
    await writeFile(join(shareDir, '.env'), 'SECRET=x')
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['1', shareDir, '', 'CONFIRMAR'])
    await runSetup(context({ prompt, out }))
    expectDrained()
    const text = out.lines.join('\n')
    expect(text).toMatch(/repositorio de git/)
    expect(text).toMatch(/parecen credenciales/)
    // It really did proceed past the gate, not just print the warning and stop.
    await expect(access(join(shareDir, 'CLAUDE.md'))).resolves.toBeUndefined()
  })

  it('leaves a dangerous folder untouched when the person never types CONFIRMAR', async () => {
    await seedIdentityAndProfile()
    await mkdir(join(shareDir, '.git'), { recursive: true })
    await writeFile(join(shareDir, '.env'), 'SECRET=x')
    // MAX_ATTEMPTS is 3: three wrong answers exhaust the retry budget and end the run.
    const { prompt } = scripted(['1', shareDir, '', 'no', 'no', 'no'])
    await expect(runSetup(context({ prompt }))).rejects.toThrow(/CONFIRMAR/)
    await expect(access(join(shareDir, 'CLAUDE.md'))).rejects.toThrow()
  })

  it('flags a symlink inside the folder as a reason to confirm, without following it', async () => {
    await seedIdentityAndProfile()
    await mkdir(shareDir, { recursive: true })
    await symlink(root, join(shareDir, 'enlace'))
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['1', shareDir, '', 'CONFIRMAR'])
    await runSetup(context({ prompt, out }))
    expectDrained()
    expect(out.lines.join('\n')).toMatch(/enlaces simbólicos/)
  })

  it('flags an un-descended node_modules instead of silently skipping what is inside it', async () => {
    await seedIdentityAndProfile()
    await mkdir(join(shareDir, 'node_modules', 'algun-paquete'), { recursive: true })
    await writeFile(join(shareDir, 'node_modules', 'algun-paquete', '.env'), 'SECRET=y')
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['1', shareDir, '', 'CONFIRMAR'])
    await runSetup(context({ prompt, out }))
    expectDrained()
    // Specifically the "did not look inside" reason, not "found credentials in there" — the
    // latter would mean the scan recursed into node_modules after all, which it must never do.
    expect(out.lines.join('\n')).toMatch(/no revisé dentro de node_modules/)
  })

  it('refuses the home directory outright — no CONFIRMAR can override it', async () => {
    await seedIdentityAndProfile()
    const { prompt } = scripted(['1', homedir(), ''])
    await expect(runSetup(context({ prompt }))).rejects.toThrow(/carpeta de usuario/i)
  })

  it('refuses a folder that would contain the identity, naming the key as the stake', async () => {
    await seedIdentityAndProfile()
    const { prompt } = scripted(['1', root, ''])
    await expect(runSetup(context({ prompt }))).rejects.toThrow(/llave/i)
  })

  it('refuses a folder that would contain the dedicated profile, naming settings/responder.json — not the key — as the stake', async () => {
    await seedIdentityAndProfile()
    // A folder that contains only the (custom) profile home, not the identity home: root also
    // holds identityHome as a sibling, so the conflict must be scoped to a fresh subtree.
    const conflictParent = join(root, 'perfil-en-conflicto')
    const conflictProfileHome = join(conflictParent, 'perfil')
    const { prompt } = scripted(['1', conflictParent, ''])
    const err: unknown = await runSetup(context({ prompt, profileHome: conflictProfileHome })).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/settings\.json/)
    expect((err as Error).message).toMatch(/responder\.json/)
    // The overclaim this replaces: the profile branch holds no key, so it must not say so.
    expect((err as Error).message).not.toMatch(/llave secreta es tu identidad entera/)
  })
})

describe('closed input vs. no terminal at all', () => {
  it('reports "se cerró la entrada" — never "no es una terminal interactiva" — when the stream ends mid-run', async () => {
    // Ends right after the name question, before the role question is ever asked: a real Ctrl-D
    // partway through, not a session that never had a prompt to begin with (that case is
    // setupCommand's own upfront check and uses a different, unrelated message).
    const { prompt } = scripted(['Ana'])
    const err: unknown = await runSetup(context({ prompt })).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/se cerró la entrada/i)
    expect((err as Error).message).not.toMatch(/terminal interactiva/i)
  })
})

describe('the retry loop', () => {
  it('asks the same question again after an invalid answer, instead of failing the whole run', async () => {
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['Ana', 'x', '2', 'n', 'n'])
    await runSetup(context({ prompt, out }))
    expectDrained()
    expect(out.lines.join('\n')).toMatch(/No entendí "x"/)
  })

  it('gives up with the Spanish message once every retry attempt is spent', async () => {
    // The name question passes on the first try; the role question then gets three wrong answers
    // in a row, exhausting MAX_ATTEMPTS.
    const { prompt } = scripted(['Ana', 'x', 'y', 'z'])
    await expect(runSetup(context({ prompt }))).rejects.toThrow(/No pude entender qué ibas a hacer/)
  })
})

// I5: `--relays` must do only what it says — write the list and exit — never fall through into
// the guided interview. These test the standalone path directly (`applyRelays`, and `setupCommand`
// end to end), not `runSetup`: the guided flow no longer reads a relay list from its context at
// all, so there is nothing left there for a --relays test to exercise.
describe('--relays', () => {
  it('writes the list and prints it, with no prompt and no interview, via the CLI entry point', async () => {
    await seedIdentityAndProfile()
    const out = memoryOutput()
    // No `prompt` in this context at all: proves the path is not gated behind an interactive
    // terminal the way the guided flow it used to fall through into would be.
    await setupCommand(['--relays', 'wss://uno.example,wss://dos.example'], {
      home: identityHome,
      out,
      env: process.env,
      relayPolicy: allowAnyRelay,
      createSocket: plainSocketFactory,
    })
    const store = await openStore(identityHome, { relayPolicy: allowAnyRelay })
    expect(getProfile(store).relays).toEqual(['wss://uno.example', 'wss://dos.example'])
    store.close()
    expect(out.lines.join('\n')).toMatch(/Cambié tus tableros: ahora usas 2/)
    expect(out.lines.join('\n')).toContain('wss://uno.example')
    expect(out.lines.join('\n')).toContain('wss://dos.example')
  })

  it('changes an already-configured list on a rerun, not only a first-time one', async () => {
    await seedIdentityAndProfile()
    await applyRelays({ home: identityHome, out: memoryOutput(), env: process.env, relayPolicy: allowAnyRelay }, ['wss://nuevo.example'])
    const store = await openStore(identityHome, { relayPolicy: allowAnyRelay })
    expect(getProfile(store).relays).toEqual(['wss://nuevo.example'])
    store.close()
  })

  it('refuses a malformed list the way setProfile does, and leaves the existing one in place', async () => {
    await seedIdentityAndProfile()
    // The permissive allowAnyRelay used everywhere else in this file would let a bogus string
    // through, so this test uses the real production policy to actually exercise the rejection.
    await expect(
      applyRelays({ home: identityHome, out: memoryOutput(), env: process.env, relayPolicy: sanitizeRelayList }, ['not-a-real-relay']),
    ).rejects.toThrow(/tablero/i)
    const store = await openStore(identityHome, { relayPolicy: allowAnyRelay })
    expect(getProfile(store).relays).toEqual([board.url])
    store.close()
  })

  it('never touches the dedicated profile or its saved configuration (I5)', async () => {
    // The bug this closes: following doctor's own remediation line used to fall through into the
    // whole guided interview, and pressing Enter at its folder prompt — the quick start's own
    // worked example for that exact prompt — silently repointed the profile's saved config at a
    // brand-new, empty folder. Proving --relays never touches it is the regression test for that.
    await seedIdentityAndProfile()
    await mkdir(profileHome, { recursive: true })
    const configPath = join(profileHome, RESPONDER_CONFIG_FILE)
    await writeFile(configPath, '{"version":1,"shareDir":"/original","identityHome":"/original-id","model":"sonnet","effort":"low"}\n', {
      mode: 0o600,
    })
    const before = await readFile(configPath, 'utf8')
    const beforeEntries = new Set(await import('node:fs/promises').then((fs) => fs.readdir(profileHome)))

    await setupCommand(['--relays', 'wss://nuevo.example'], {
      home: identityHome,
      out: memoryOutput(),
      env: process.env,
      relayPolicy: allowAnyRelay,
      createSocket: plainSocketFactory,
    })

    expect(await readFile(configPath, 'utf8')).toBe(before)
    const afterEntries = new Set(await import('node:fs/promises').then((fs) => fs.readdir(profileHome)))
    expect(afterEntries).toEqual(beforeEntries)
  })
})
