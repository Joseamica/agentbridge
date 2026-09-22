import {
  CLI_COMMAND,
  decodeLink,
  getProfile,
  loadIdentity,
  loadOrCreateIdentity,
  openStore,
  sanitizeRelayList,
  setProfile,
  UserFacingError,
} from '@agentbridge/core'
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { plainSocketFactory, startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { RESPONDER_CONFIG_FILE } from '../src/commands/responder'
import { applyRelays, blockers, loginStep, mustMention, runSetup, setupCommand, type SetupContext } from '../src/commands/setup'
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

// Every handover of the terminal `setup` performs — Claude's login, and the responder itself.
// Recorded rather than performed: a test that actually spawned `claude` would need one installed,
// and would hand it this suite's own stdin.
// `at` is how many lines had been printed when the handover happened — the only ordering
// evidence available, and what makes "the responder starts last" a real assertion instead of a
// claim about a set with no order in it.
type InteractiveCall = { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string; at?: number }

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
    runInteractive: async () => ({ code: 0, spawnFailed: false }),
    // Never the real clipboard: this suite must not overwrite whatever the person running it
    // has copied, and on a headless CI box there is nothing to write to anyway.
    copyLink: async () => true,
    ...o,
  } as SetupContext
}

// `setup`'s own default answer to the folder question, in the real home of whoever runs this.
// Nothing here may create it — see the check in afterEach.
const defaultShareDir = join(homedir(), 'AgentBridge', 'compartido')
let defaultShareExistedBefore = false

beforeEach(async () => {
  defaultShareExistedBefore = await access(defaultShareDir)
    .then(() => true)
    .catch(() => false)
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
  // Answering the folder question with a plain Enter accepts `setup`'s own default, which is a
  // real path in the real home directory of whoever runs this suite — and the flow then CREATES
  // it and writes a CLAUDE.md into it. That happened for real while these tests were being
  // written (and once before, per the comment on expandUserPath): every test here must pass an
  // explicit temp folder. Fails loudly instead of deleting anything, because by the time this
  // notices, the folder may well be one the person actually wanted.
  if (!defaultShareExistedBefore) {
    const leaked = await access(defaultShareDir)
      .then(() => true)
      .catch(() => false)
    expect(leaked, `${defaultShareDir} — a test answered the folder question with Enter`).toBe(false)
  }
})

async function seedIdentityAndProfile(): Promise<void> {
  await loadOrCreateIdentity(identityHome)
  const store = await openStore(identityHome, { relayPolicy: allowAnyRelay })
  setProfile(store, { name: 'Ana', relays: [board.url], now: 1_700_000_000 })
  store.close()
}

// A whole guided run on temp directories, with every subprocess faked the way the real programs
// behave — so a flow test exercises the real branching (doctor's verdict included) instead of a
// stub of it. `run` stands in for `claude`; `runInteractive` records the handovers; `copyLink`
// answers true unless a test says otherwise.
async function responderSetupContext(o: {
  answers: string[]
  loggedIn?: boolean
  // The first-install case, and the only one where the two answers differ: doctor asks before the
  // login and is told no, the login runs, and the check right after it is told yes.
  logsInDuringSetup?: boolean
  copyLink?: (text: string) => Promise<boolean>
  relays?: string[]
  // Puts the identity (and therefore the secret key) inside a folder a sync client uploads on its
  // own — a real, temp-only path that doctor's cloudSyncedPath recognises by segment name.
  keyInCloudFolder?: boolean
  // `claude` cannot be spawned when the responder finally starts — the one failure `runResponder`
  // reports by throwing rather than by a non-zero code.
  responderSpawnFails?: boolean
}): Promise<
  SetupContext & { out: ReturnType<typeof memoryOutput>; interactiveCalls: InteractiveCall[]; expectDrained: () => void; asked: string[] }
> {
  if (o.keyInCloudFolder) identityHome = join(root, 'OneDrive', 'identidad')
  await loadOrCreateIdentity(identityHome)
  const store = await openStore(identityHome, { relayPolicy: allowAnyRelay })
  // Relays but no name: the name is the first question the guided flow asks, and seeding it
  // would shift every scripted answer below by one without any test failing for the right reason.
  setProfile(store, { relays: o.relays ?? [board.url], now: 1_700_000_000 })
  store.close()

  const out = memoryOutput()
  const interactiveCalls: InteractiveCall[] = []
  const { prompt, expectDrained, asked } = scripted(o.answers)
  const loggedIn = o.loggedIn ?? true
  let authAsked = 0
  const ctx = context({
    prompt,
    out,
    run: async (_command, args) => {
      // `claude auth status --json` exits 0 whether or not there is a session — the verdict is
      // the parsed field, never the code. A fake that returned only `code: 0` would let an
      // implementation that reads the exit code pass while being wrong about the one thing here
      // that matters.
      if (args[0] === 'auth' && args[1] === 'status') {
        authAsked += 1
        // Doctor's question is the first; the one after the login is the second.
        return { code: 0, stdout: JSON.stringify({ loggedIn: o.logsInDuringSetup ? authAsked > 1 : loggedIn }), stderr: '' }
      }
      // The real `claude plugin install` leaves this behind, and doctor's "Plugin instalado"
      // check (blocking) reads exactly this file. Without it, every flow test would run against
      // a blocked install and never reach the branches it claims to test.
      if (args[0] === 'plugin' && args[1] === 'install') {
        await mkdir(join(profileHome, 'claude', 'plugins'), { recursive: true })
        await writeFile(
          join(profileHome, 'claude', 'plugins', 'installed_plugins.json'),
          JSON.stringify({ plugins: { 'agentbridge@agentbridge-local': [{ version: '0.3.0' }] } }),
        )
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    runInteractive: async (command, args, opts) => {
      interactiveCalls.push({ command, args, env: opts.env, cwd: opts.cwd, at: out.lines.length })
      const isResponder = args.includes('plugin:agentbridge@agentbridge-local')
      if (isResponder && o.responderSpawnFails) return { code: null, spawnFailed: true }
      return { code: 0, spawnFailed: false }
    },
    copyLink: o.copyLink ?? (async () => true),
  })
  // `asked` carries the questions themselves: they reach the person through `prompt`, never
  // through `out.log`, so an assertion about a question that searched `out.lines` could not fail.
  return Object.assign(ctx, { out, interactiveCalls, expectDrained, asked })
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

  // Whole-branch review, Important 2. `connect` was the one step in the flow with no error
  // handling around it, and `askWithRetries(parseNonEmpty)` only checks the string is non-empty —
  // so a truncated, line-wrapped or mistyped paste reached `decodeLink` and ended the whole run
  // on the link error: no summary, no MCP step, and on role 3 no verdict and no offer to start
  // answering, after the browser login had already succeeded.
  it('keeps going after a link that does not decode, instead of ending the run on it', async () => {
    await seedIdentityAndProfile()
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['2', 's', 'agentbridge:nprofile1-esto-esta-mal', 'n'])
    await runSetup(
      context({
        prompt,
        out,
        // Exactly what `decodeLink` throws on a mispasted link, reproduced by the reviewer live.
        connectWith: async () => {
          throw new UserFacingError('Ese enlace de AgentBridge no es válido. Pide que te lo copien completo.')
        },
      }),
    )
    expectDrained()
    const text = out.lines.join('\n')
    // What went wrong, said in its own words…
    expect(text).toContain('Ese enlace de AgentBridge no es válido.')
    // …that nothing else was lost…
    expect(text).toMatch(/no se perdió/i)
    // …the run reached its end…
    expect(text).toMatch(/== Resumen ==/)
    // …and the command that finishes this one job later is in the list of what is left.
    expect(text.slice(text.indexOf('== Resumen =='))).toMatch(/connect <enlace>/)
    // The step after it ran too, instead of being skipped along with everything else.
    expect(text).toMatch(/servidor MCP/i)
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
    const { prompt, expectDrained } = scripted(['1', shareDir, '', '', 'n'])
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
    const { prompt, expectDrained } = scripted(['1', shareDir, '', '', 'n'])
    await runSetup(context({ prompt, out }))
    expectDrained()
    const text = out.lines.join('\n')
    expect(text).toMatch(/agentbridge:nprofile1/)
    expect(text).toMatch(/dáselo|pásaselo|mándaselo/i)
  })

  it('names a non-default profile plainly, with no POSIX quoting a Windows shell would misread (review round 1, Important 4)', async () => {
    // `responder` (not start.sh) is what gets printed now; a non-default --profile still has to
    // be named on that line, or the printed command would start the wrong (default) profile.
    // It is printed unquoted on purpose: single quotes are not quotes to cmd.exe, so wrapping the
    // path in them would be wrong on a whole platform — worse than a custom profile path with a
    // space in it simply not needing escaping at all.
    await seedIdentityAndProfile()
    const spacedProfile = join(root, 'mi respondedor')
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['1', shareDir, '', '', 'n'])
    await runSetup(context({ prompt, out, profileHome: spacedProfile }))
    expectDrained()
    const text = out.lines.join('\n')
    expect(text).toContain(`${CLI_COMMAND} responder --profile ${spacedProfile}`)
    expect(text).not.toContain(`'${spacedProfile}'`)
  })

  it('says the blocking thing in its own words, and never claims it is ready to answer', async () => {
    await seedIdentityAndProfile()
    const out = memoryOutput()
    // A real diagnostic failure, not a crash: the bundle exists (so setupResponder completes) and
    // the only board refuses reads, so every board fails and doctor's aggregate "Tableros
    // públicos" check — the blocking one — fires.
    board.options = { ...board.options, rejectReads: true }
    const { prompt, expectDrained } = scripted(['1', shareDir, '', '', 'n'])
    await runSetup(context({ prompt, out }))
    expectDrained()
    const text = out.lines.join('\n')
    expect(text).toMatch(/Falta algo: Ningún tablero te dejó publicar y leer/)
    // The per-board lines are doctor's business, not this command's: exactly the detail that
    // turned 0.2's ending into seventeen lines nobody could act on. Asserted on the printed
    // lines' own shape (nothing here may look like doctor's `[ok]/[falla]` report) rather than on
    // a phrase — the previous `not.toMatch(/Tablero wss:/)` could not fail once the check list
    // was gone, because the word only ever reached the screen through that list.
    expect(out.lines.filter((line) => line.startsWith('['))).toEqual([])
    // And it must not tell them they are ready to answer while a blocking check is failing.
    expect(text).not.toMatch(/Listo para contestar/)
    // The summary names the thing, not "esto": review round 1, I2.
    const summary = text.slice(text.indexOf('== Resumen =='))
    expect(summary).toMatch(/Ningún tablero te dejó publicar y leer/)
    expect(summary).toMatch(/Después, para empezar a contestar/)
  })
})

describe('the login step', () => {
  it('does nothing and asks nothing when the profile is already logged in', async () => {
    const out = memoryOutput()
    const calls: string[] = []
    const ok = await loginStep({
      claudeConfigDir: '/perfil/claude',
      env: {},
      out,
      prompt: async () => {
        calls.push('asked')
        return ''
      },
      run: async () => {
        calls.push('ran')
        return { code: 0, stdout: '{"loggedIn":true}', stderr: '' }
      },
      runInteractive: async (command) => {
        calls.push(command)
        return { code: 0, spawnFailed: false }
      },
      alreadyLoggedIn: true,
    })
    expect(ok).toBe(true)
    expect(calls).toEqual([])
    expect(out.lines).toEqual([])
  })

  it('opens Claude in the dedicated profile and confirms afterwards', async () => {
    const out = memoryOutput()
    const spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
    const ok = await loginStep({
      claudeConfigDir: '/perfil/claude',
      env: { PATH: '/usr/bin' },
      out,
      prompt: async () => '',
      // The check that runs AFTER the person comes back. `claude auth status --json` exits 0
      // either way, so the verdict is the parsed field — a fake that returned only `code: 0`
      // would let a broken implementation pass.
      run: async () => ({ code: 0, stdout: '{"loggedIn":true}', stderr: '' }),
      runInteractive: async (command, args, opts) => {
        spawned.push({ command, args, env: opts.env })
        return { code: 0, spawnFailed: false }
      },
      alreadyLoggedIn: false,
    })
    expect(ok).toBe(true)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.command).toBe('claude')
    // The dedicated subcommand, not the whole interface: nothing for the person to type inside.
    expect(spawned[0]?.args).toEqual(['auth', 'login'])
    // The whole point of the dedicated profile: this login must not touch their everyday one.
    expect(spawned[0]?.env.CLAUDE_CONFIG_DIR).toBe('/perfil/claude')
    // And the rest of the environment survives — a login spawned with only CLAUDE_CONFIG_DIR
    // would not find `claude` on PATH in the first place.
    expect(spawned[0]?.env.PATH).toBe('/usr/bin')
    // Never a shell line for them to paste.
    expect(out.lines.join('\n')).not.toMatch(/CLAUDE_CONFIG_DIR=/)
  })

  it('says plainly that the session is still not started, without blaming them', async () => {
    const out = memoryOutput()
    const ok = await loginStep({
      claudeConfigDir: '/perfil/claude',
      env: {},
      out,
      // Enter to open it, then "no" to the offer of another try.
      prompt: scripted(['', 'n']).prompt,
      // Exit 0 with loggedIn:false — what really happens when someone opens Claude and closes it
      // without logging in. A test that used a non-zero code here would pass against an
      // implementation that only checks the exit code, which is the bug this pins.
      run: async () => ({ code: 0, stdout: '{"loggedIn":false}', stderr: '' }),
      runInteractive: async () => ({ code: 0, spawnFailed: false }),
      alreadyLoggedIn: false,
    })
    expect(ok).toBe(false)
    expect(out.lines.join('\n')).toMatch(/no quedó iniciada/i)
    expect(out.lines.join('\n')).toContain(`${CLI_COMMAND} setup`)
  })

  it('does not call a session started when the status output is not JSON at all', async () => {
    // A `claude` that printed a banner, or an error, or nothing: unparseable is not a session.
    const out = memoryOutput()
    const ok = await loginStep({
      claudeConfigDir: '/perfil/claude',
      env: {},
      out,
      prompt: scripted(['', 'n']).prompt,
      run: async () => ({ code: 0, stdout: 'Welcome to Claude Code', stderr: '' }),
      runInteractive: async () => ({ code: 0, spawnFailed: false }),
      alreadyLoggedIn: false,
    })
    expect(ok).toBe(false)
  })

  it('opens the login again in place instead of sending them back through the whole assistant', async () => {
    // Review round 1, I3: closing the browser before the login finishes is the most likely
    // first-run outcome, and "vuelve a correr setup" for it asks a person to redo six questions
    // for a step the program is standing right there to repeat.
    const out = memoryOutput()
    let opened = 0
    const { prompt, expectDrained } = scripted(['', 's', ''])
    const ok = await loginStep({
      claudeConfigDir: '/perfil/claude',
      env: {},
      out,
      prompt,
      // Not logged in the first time it is asked, logged in the second: the person went back and
      // finished it.
      run: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: opened > 1 }), stderr: '' }),
      runInteractive: async () => {
        opened += 1
        return { code: 0, spawnFailed: false }
      },
      alreadyLoggedIn: false,
    })
    expectDrained()
    expect(ok).toBe(true)
    expect(opened).toBe(2)
    // And it never sent them back to the beginning to get there.
    expect(out.lines.join('\n')).not.toContain(`${CLI_COMMAND} setup`)
  })

  it('stops after a bounded number of tries, however many times the person says yes', async () => {
    // A retry loop with no bound is a dead end somebody has to Ctrl+C out of.
    const out = memoryOutput()
    let opened = 0
    let offeredAgain = 0
    const ok = await loginStep({
      claudeConfigDir: '/perfil/claude',
      env: {},
      out,
      // Always Enter, always "sí": the loop itself has to be what stops.
      prompt: async (question) => {
        if (!question.includes('otra vez? [s/n]')) return ''
        offeredAgain += 1
        return 's'
      },
      run: async () => ({ code: 0, stdout: '{"loggedIn":false}', stderr: '' }),
      runInteractive: async () => {
        opened += 1
        return { code: 0, spawnFailed: false }
      },
      alreadyLoggedIn: false,
    })
    expect(ok).toBe(false)
    expect(opened).toBe(3)
    // And the offer is never made on the last attempt: asking "¿otra vez?" and then ignoring the
    // answer because the loop is over is its own small betrayal.
    expect(offeredAgain).toBe(2)
  })

  it('explains that Claude Code is missing instead of pretending it opened', async () => {
    const out = memoryOutput()
    let opened = 0
    const ok = await loginStep({
      claudeConfigDir: '/perfil/claude',
      env: {},
      out,
      prompt: scripted(['']).prompt,
      run: async () => ({ code: 0, stdout: '{"loggedIn":false}', stderr: '' }),
      runInteractive: async () => {
        opened += 1
        return { code: null, spawnFailed: true }
      },
      alreadyLoggedIn: false,
    })
    expect(ok).toBe(false)
    expect(out.lines.join('\n')).toMatch(/claude\.com\/claude-code/)
    // No retry for this one: opening it again cannot install a program that is not there. A
    // second attempt would also read the scripted queue dry and fail this test loudly.
    expect(opened).toBe(1)
  })
})

describe('blockers', () => {
  it('keeps only the failing checks that stop the person from answering', () => {
    const checks = [
      { name: 'Base de datos', ok: true, detail: 'ok', blocking: true, security: false },
      { name: 'Tablero wss://uno', ok: false, detail: 'no', blocking: false, security: false },
      { name: 'Llave de AgentBridge', ok: false, detail: 'falta', blocking: true, security: true },
    ]
    expect(blockers(checks).map((c) => c.name)).toEqual(['Llave de AgentBridge'])
  })

  it('mustMention adds the failing security checks that do not block, and still hides the weather', () => {
    // Review round 1, I4. The middle one is the shape that matters: nothing is broken, the person
    // can answer questions perfectly — and their secret key is being uploaded to somebody else's
    // servers. `blocking` says "no need to mention"; it is the most serious line in the program.
    const checks = [
      { name: 'Tablero wss://uno', ok: false, detail: 'no contestó', blocking: false, security: false },
      { name: 'Carpeta sincronizada con la nube', ok: false, detail: 'Tu llave está dentro de OneDrive', blocking: false, security: true },
      { name: 'Tableros públicos', ok: false, detail: 'ninguno', blocking: true, security: false },
      { name: 'Llave de AgentBridge', ok: true, detail: 'presente', blocking: true, security: true },
    ]
    expect(mustMention(checks).map((c) => c.name)).toEqual(['Carpeta sincronizada con la nube', 'Tableros públicos'])
  })
})

describe('the guided flow as a whole', () => {
  it('prints no shell syntax and no technical check list when everything works', async () => {
    const ctx = await responderSetupContext({ answers: ['Dani', '1', shareDir, '', 'n'] })
    await runSetup(ctx)
    ctx.expectDrained()
    const out = ctx.out
    const text = out.lines.join('\n')
    expect(text).not.toMatch(/CLAUDE_CONFIG_DIR=/)
    expect(text).not.toMatch(/start\.sh/)
    // Nothing that looks like doctor's own report. Asserted on the line shape rather than on
    // `[ok]`/`[falta]`: doctorCommand prints `[falla]`, so a literal `[falta]` search matched
    // nothing that this program could ever print, whatever it did.
    expect(out.lines.filter((line) => line.startsWith('['))).toEqual([])
    expect(text).toContain('agentbridge:nprofile1')
    expect(text).toMatch(/portapapeles/)
    // Nothing blocks, so the offer to start is the last thing asked — and "n" ends it with the
    // one command that starts it later, not with a diagnosis.
    expect(text).toMatch(/Cuando quieras empezar a contestar/)
  })

  it('names the one thing that blocks, and nothing else', async () => {
    // A run where one board is unreachable (not blocking — the other one works) and the login
    // never happened (blocking). Port 9 on loopback refuses immediately: nothing here needs a
    // network, and nothing waits on a timeout.
    const ctx = await responderSetupContext({
      answers: ['Dani', '1', shareDir, '', ''],
      loggedIn: false,
      relays: [board.url, 'wss://127.0.0.1:9/'],
    })
    await runSetup(ctx)
    ctx.expectDrained()
    const text = ctx.out.lines.join('\n')
    expect(text).toMatch(/no quedó iniciada/i)
    // The dead board is real — doctor saw it fail — and this command still says nothing about it.
    // Asserted on the "Falta algo:" lines themselves rather than on the whole transcript: the
    // word "tablero" appears legitimately up top ("usas N tableros públicos"), so a search over
    // everything would pass no matter what this branch printed.
    expect(ctx.out.lines.filter((line) => line.startsWith('Falta algo:'))).toEqual([])
    expect(text).not.toMatch(/\[falta\]/)
    // It did open the login rather than telling them to open it.
    expect(ctx.interactiveCalls.map((c) => c.args.join(' '))).toContain('auth login')
    // And with no session there is nothing to start, so it never offers. Asserted against the
    // questions actually asked: a question reaches the person through `prompt`, never through
    // `out.log`, so searching the transcript for it could not fail.
    expect(ctx.asked.some((q) => q.includes('¿Empiezo a contestar ahora?'))).toBe(false)
    expect(ctx.interactiveCalls.some((c) => c.args.includes('plugin:agentbridge@agentbridge-local'))).toBe(false)
  })

  it('starts answering when asked to', async () => {
    const ctx = await responderSetupContext({ answers: ['Dani', '1', shareDir, '', 's'] })
    await runSetup(ctx)
    ctx.expectDrained()
    expect(ctx.interactiveCalls.map((c) => c.args.join(' ')).join('\n')).toContain('plugin:agentbridge@agentbridge-local')
  })

  it('offers to start after a login that happened during this very run', async () => {
    // The first install, which is the ONLY way most people will ever see this command: doctor ran
    // before the login and recorded "no session". Deciding whether the responder can start from
    // that recorded answer — instead of from what the login itself reported — refuses to start a
    // responder that works perfectly, on the single most common path through this flow.
    const ctx = await responderSetupContext({ answers: ['Dani', '1', shareDir, '', '', 's'], logsInDuringSetup: true })
    await runSetup(ctx)
    ctx.expectDrained()
    const text = ctx.out.lines.join('\n')
    expect(text).toMatch(/la sesión quedó iniciada/i)
    expect(text).not.toMatch(/no quedó iniciada/i)
    // It did offer, and it did start.
    expect(text).not.toMatch(/Cuando esté resuelto/)
    expect(ctx.interactiveCalls.map((c) => c.args.join(' ')).join('\n')).toContain('plugin:agentbridge@agentbridge-local')
  })

  it('does not skip the asking side when the person chose both roles', async () => {
    // The ordering bug this plan nearly shipped: starting the responder from inside the answering
    // branch would return before `connect` and the MCP registration ever ran, and the person would
    // have no way to know what they did not get.
    const ctx = await responderSetupContext({ answers: ['Dani', '3', shareDir, '', 'n', 'n', 's'] })
    await runSetup(ctx)
    ctx.expectDrained()
    const text = ctx.out.lines.join('\n')
    expect(text).toMatch(/servidor MCP/i)
    // And the responder still starts, AFTER everything else — not merely at some point during
    // the run. `at` is the line count when the handover happened.
    const mcpLine = ctx.out.lines.findIndex((line) => /servidor MCP/i.test(line))
    const responderCall = ctx.interactiveCalls.find((c) => c.args.includes('plugin:agentbridge@agentbridge-local'))
    expect(mcpLine).toBeGreaterThanOrEqual(0)
    expect(responderCall?.at).toBeGreaterThan(mcpLine)
  })

  // The role-3 half of Important 2, which is the one that would actually catch a person: the
  // folder, the dedicated profile and the browser login have all already succeeded when the link
  // they were sent over WhatsApp turns out to be mispasted. Losing the verdict AND the offer to
  // start answering over that is the failure class this whole branch exists to end.
  it('keeps the verdict and the offer to start answering when the pasted link is bad on role 3', async () => {
    const ctx = await responderSetupContext({ answers: ['Dani', '3', shareDir, '', 's', 'enlace-mal-pegado', 'n', 's'] })
    ctx.connectWith = async () => {
      throw new UserFacingError('Ese enlace de AgentBridge no es válido. Pide que te lo copien completo.')
    }
    await runSetup(ctx)
    ctx.expectDrained()
    const text = ctx.out.lines.join('\n')
    expect(text).toContain('Ese enlace de AgentBridge no es válido.')
    expect(text).toMatch(/== Resumen ==/)
    expect(text).toMatch(/Listo para contestar desde esta computadora/)
    // It still offered — and still started.
    expect(ctx.asked.some((q) => q.includes('¿Empiezo a contestar ahora?'))).toBe(true)
    expect(ctx.interactiveCalls.some((c) => c.args.includes('plugin:agentbridge@agentbridge-local'))).toBe(true)
  })

  it('never says "Ya quedó" over a summary that still says "Te falta"', async () => {
    // Review round 1, I1, from a real role-3 transcript: the person was shown two pending items
    // and then, four lines later, "Ya quedó. A partir de aquí:" — and then the responder took the
    // terminal until Ctrl+C, so the only way to do what they still owed was to kill the session
    // they had just been told to leave open. On role 3 this is not an edge case: the asking side
    // always ends with "reinicia tu sesión de Claude Code".
    const ctx = await responderSetupContext({ answers: ['Dani', '3', shareDir, '', 'n', 'n', 's'] })
    await runSetup(ctx)
    ctx.expectDrained()
    const text = ctx.out.lines.join('\n')
    expect(text).toMatch(/Te falta:/)
    expect(text).not.toMatch(/Ya quedó/)
    // What it says instead names the conflict and how to get out of it.
    expect(text).toMatch(/Lo que te falta \(arriba\) lo puedes hacer cuando pares con Ctrl\+C/)
    // And the person was told what "sí" costs before they answered, not after.
    expect(text).toMatch(/esta terminal se queda contestando hasta que la pares con Ctrl\+C/)
  })

  it('still says "Ya quedó" when there is genuinely nothing left', async () => {
    // The other half of the same rule: the wording is gated on the truth, not removed.
    const ctx = await responderSetupContext({ answers: ['Dani', '1', shareDir, '', 's'] })
    await runSetup(ctx)
    ctx.expectDrained()
    const text = ctx.out.lines.join('\n')
    expect(text).not.toMatch(/Te falta:/)
    expect(text).toMatch(/Ya quedó/)
  })

  it('says out loud that the key is being uploaded, even though nothing is blocked', async () => {
    // Review round 1, I4: `blocking` answers "can this person answer questions", and the honest
    // answer for a key sitting in OneDrive is yes — so filtering the install's report by
    // `blocking` alone silenced the single most serious thing this program can say, at the exact
    // moment the person is still choosing folders.
    const ctx = await responderSetupContext({ answers: ['Dani', '1', shareDir, '', 'n'], keyInCloudFolder: true })
    await runSetup(ctx)
    ctx.expectDrained()
    const text = ctx.out.lines.join('\n')
    expect(text).toMatch(/se sube sola a la nube/)
    // Said as a warning, not as something that stopped the install — because it did not.
    expect(text).toMatch(/^Ojo: /m)
    expect(text).not.toMatch(/Falta algo: Tu llave/)
    // It is still in the summary, which is the part people scroll back to…
    expect(text.slice(text.indexOf('== Resumen =='))).toMatch(/se sube sola a la nube/)
    // …and the closing pointer no longer conditions the report on something being broken.
    expect(text).toMatch(/Para revisar todo con detalle/)
    expect(text).not.toMatch(/Si algo no funciona/)
    // Nothing blocked, so it still offered to start answering.
    expect(ctx.asked.some((q) => q.includes('¿Empiezo a contestar ahora?'))).toBe(true)
  })

  it('proposes the folder this computer is already sharing, so a re-run cannot repoint it', async () => {
    // Review round 1, I3(b): every remedy this command prints says "vuelve a correr setup", and
    // the folder question used to offer a hard-coded `~/AgentBridge/compartido` no matter what was
    // already configured — so pressing Enter there (the quick start's own worked example) silently
    // repointed a working responder at a brand-new empty folder.
    const first = await responderSetupContext({ answers: ['Dani', '1', shareDir, '', 'n'] })
    await runSetup(first)
    first.expectDrained()

    const second = await responderSetupContext({ answers: ['1', '', '', 'n'] })
    await runSetup(second)
    second.expectDrained()
    // The question offered the saved folder, and plain Enter kept it.
    expect(second.asked.some((q) => q.includes(`Enter para usar ${shareDir}`))).toBe(true)
    expect(second.out.lines.join('\n')).toContain(`Voy a usar esta carpeta: ${shareDir}`)
    const config = JSON.parse(await readFile(join(profileHome, RESPONDER_CONFIG_FILE), 'utf8'))
    expect(config.shareDir).toBe(shareDir)
  })

  it('does not turn a finished setup into an error when Claude Code cannot be started', async () => {
    // Review round 1, M3: `runResponder` reports one of its two failures by throwing and the other
    // with a non-zero code. Everything this command was asked to do already worked by then, so
    // both are said the same way — ending on "Error:" would read as if the setup itself failed.
    const ctx = await responderSetupContext({ answers: ['Dani', '1', shareDir, '', 's'], responderSpawnFails: true })
    await expect(runSetup(ctx)).resolves.toBeUndefined()
    ctx.expectDrained()
    expect(ctx.out.lines.join('\n')).toMatch(/No pude ejecutar Claude Code/)
  })

  it('still prints the link when no clipboard tool exists', async () => {
    const ctx = await responderSetupContext({ answers: ['Dani', '1', shareDir, '', 'n'], copyLink: async () => false })
    await runSetup(ctx)
    ctx.expectDrained()
    const text = ctx.out.lines.join('\n')
    expect(text).toContain('agentbridge:nprofile1')
    expect(text).not.toMatch(/portapapeles/)
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
    const { prompt, expectDrained } = scripted(['1', shareDir, '', 'CONFIRMAR', '', 'n'])
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
    const { prompt, expectDrained } = scripted(['1', shareDir, '', 'CONFIRMAR', '', 'n'])
    await runSetup(context({ prompt, out }))
    expectDrained()
    expect(out.lines.join('\n')).toMatch(/enlaces simbólicos/)
  })

  it('flags an un-descended node_modules instead of silently skipping what is inside it', async () => {
    await seedIdentityAndProfile()
    await mkdir(join(shareDir, 'node_modules', 'algun-paquete'), { recursive: true })
    await writeFile(join(shareDir, 'node_modules', 'algun-paquete', '.env'), 'SECRET=y')
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['1', shareDir, '', 'CONFIRMAR', '', 'n'])
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
