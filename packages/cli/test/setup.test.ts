import type { FastifyInstance } from 'fastify'
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_TOKEN, buildListeningApp, resetDb, testPool } from '../../../apps/relay/test/helpers'
import type { CommandRunner } from '../src/commands/setup-responder'
import { expandUserPath, runSetup } from '../src/commands/setup'
import { memoryOutput, PromptEOF, type Prompt } from '../src/context'
import { run } from '../src/router'

let pool: pg.Pool
let app: FastifyInstance
let relayUrl: string
let root: string
let repoDir: string

// The dedicated responder profile lives under --home; nothing in these tests may ever point
// that (or the asker identity's --home) at the real ~/.agentbridge or ~/.agentbridge-responder.
beforeAll(async () => {
  pool = await testPool()
})
beforeEach(async () => {
  await resetDb(pool)
  ;({ app, relayUrl } = await buildListeningApp(pool))
  root = await mkdtemp(join(tmpdir(), 'ab-setup-cmd-'))
  repoDir = join(root, 'repo')
  await mkdir(join(repoDir, 'plugins/agentbridge/dist'), { recursive: true })
  await writeFile(join(repoDir, 'plugins/agentbridge/dist/server.js'), '// bundle')
})
afterEach(async () => {
  await app.close()
})
afterAll(async () => {
  await pool.end()
})

// Mirrors what the real readlinePrompt does when its input stream ends before an answer comes
// back: rejects with PromptEOF, the same way a closed/exhausted real stdin does — never a plain
// Error, and never a resolved string. This is what lets a test feed fewer answers than a flow
// needs and get the same "needs an interactive terminal" abort a real dried-up stdin would
// produce, instead of an unrelated crash.
function scriptedPrompt(answers: string[]): Prompt {
  const queue = [...answers]
  return async () => {
    if (queue.length === 0) throw new PromptEOF()
    return queue.shift()!
  }
}

// runSetup calls doctor internally, whose default `run` would otherwise spawn a real `claude`
// binary for `claude auth status`. Every test must inject a CommandRunner instead.
function trackingRunner(overrides: Record<string, { code: number; stdout: string; stderr: string }> = {}): {
  run: CommandRunner
  calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[]
} {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
  const run: CommandRunner = async (command, args, opts) => {
    calls.push({ command, args, env: opts.env })
    if (command === 'claude' && args[0] === 'auth') return { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: '' }
    const key = args.join(' ')
    return overrides[key] ?? { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

async function createEnrollLink(handle: string, name: string): Promise<string> {
  const admin = { home: await mkdtemp(join(tmpdir(), 'ab-admin-')), out: memoryOutput(), env: {} }
  expect(
    await run(['admin', 'enroll-link', '--handle', handle, '--name', name, '--relay', relayUrl, '--admin-token', ADMIN_TOKEN], admin),
  ).toBe(0)
  return admin.out.lines.join('\n').match(/agentbridge enroll (\S+)/)![1]!
}

async function newBaseContext(): Promise<{ home: string; out: ReturnType<typeof memoryOutput>; env: NodeJS.ProcessEnv; repoDir: string }> {
  return { home: await mkdtemp(join(tmpdir(), 'ab-setup-home-')), out: memoryOutput(), env: {}, repoDir }
}

describe('agentbridge setup — non-interactive safety', () => {
  it('refuses instead of hanging when stdin is not interactive (no prompt injected), with a Spanish exit 1', async () => {
    const ctx = { home: await mkdtemp(join(tmpdir(), 'ab-setup-noninteractive-')), out: memoryOutput(), env: {} }
    const start = Date.now()
    const code = await run(['setup'], ctx)
    expect(Date.now() - start).toBeLessThan(2000)
    expect(code).toBe(1)
    const err = ctx.out.errors.join('\n')
    expect(err).toContain('terminal interactiva')
    expect(err).not.toMatch(/^(Error|TypeError):/m)
  })

  it('prints the equivalent non-interactive commands so the person is not stuck', async () => {
    const ctx = { home: await mkdtemp(join(tmpdir(), 'ab-setup-noninteractive-2-')), out: memoryOutput(), env: {} }
    await run(['setup'], ctx)
    const err = ctx.out.errors.join('\n')
    expect(err).toContain('agentbridge enroll')
    expect(err).toContain('agentbridge setup-responder')
    expect(err).toContain('agentbridge doctor')
  })
})

describe('agentbridge setup — identity', () => {
  it('greets an already-enrolled device and never asks for an enrollment link', async () => {
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const base = await newBaseContext()
    expect(await run(['enroll', link], base)).toBe(0)
    base.out.lines.length = 0 // clear the enroll command's own output before driving setup

    const { run: runner } = trackingRunner()
    // Only ever answers the role question ('2') then declines mcp ('n') — if setup tried to
    // ask for a link first, this queue would be consumed out of order and the assertions below
    // on out.lines would fail to find the "ya está dada de alta" message before role-specific
    // output, or scriptedPrompt would run out and throw.
    const prompt = scriptedPrompt(['2', 'n'])
    await runSetup({ ...base, prompt, run: runner })

    const text = base.out.lines.join('\n')
    expect(text).toContain('ya está dada de alta')
    expect(text).toContain('@dev')
    expect(text).not.toContain('Enlace de alta')
  })
})

describe('agentbridge setup — dangerous shared folder', () => {
  it('refuses the user home directory outright, with no override', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const { run: runner, calls } = trackingRunner()
    // '' after the path confirms "yes, use the resolved path shown" (chooseShareDir's own
    // confirm-the-resolved-path step) — the isHome hard refusal fires right after that, inside
    // assessShareDir, so no CONFIRMAR prompt is ever reached.
    const prompt = scriptedPrompt([link, '1', homedir(), ''])
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/es tu carpeta de usuario/i)
    expect(calls).toEqual([])
  })

  it('refuses the caller’s own AgentBridge identity directory as the shared folder outright (C3)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const { run: runner, calls } = trackingRunner()
    // base.home IS ctx.home (the identity established in step 1) — answering with it must be
    // refused before setupResponder ever runs, the same severity as the home-directory case: a
    // crafted question could read config.json (the device token) straight out of the fence.
    const prompt = scriptedPrompt([link, '1', base.home, ''])
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/token del dispositivo/i)
    expect(calls).toEqual([])
  })

  it('refuses the responder’s own dedicated-profile directory as the shared folder outright (C3)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const responderHome = join(root, 'responder-c3')
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', responderHome, ''])
    await expect(runSetup({ ...base, responderHome, prompt, run: runner })).rejects.toThrow(/token del dispositivo/i)
    expect(calls).toEqual([])
  })

  it('re-asks the confirmation on a wrong answer instead of ending the run, and still refuses after 3 wrong tries', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const dangerous = join(root, 'repo-de-trabajo')
    await mkdir(join(dangerous, '.git'), { recursive: true })
    const { run: runner, calls } = trackingRunner()
    // Three wrong confirmation attempts, none of them "CONFIRMAR" — FIX1 means each one gets a
    // fresh chance instead of ending the run on the first, and only running out at the third
    // attempt ends it, with the CliError this always threw.
    const prompt = scriptedPrompt([link, '1', dangerous, '', 'no gracias', 'tampoco', 'de plano no'])
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/CONFIRMAR/)
    const text = base.out.lines.join('\n')
    expect(text).toContain('No entendí "no gracias"')
    expect(text).toContain('No entendí "tampoco"')
    expect(calls).toEqual([])
  })

  it('accepts the confirmation case- and whitespace-insensitively, on the first attempt', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const dangerous = join(root, 'repo-de-trabajo-2')
    await mkdir(join(dangerous, '.git'), { recursive: true })
    const responderHome = join(root, 'responder-2')
    const { run: runner } = trackingRunner()
    // Lowercase and padded with whitespace — FIX2: "confirmar", "CONFIRMAR" and "Confirmar "
    // must all work, but this must never accept "sí"/"s"/"y" (a separate test below covers that).
    const prompt = scriptedPrompt([link, '1', dangerous, '', '  confirmar  '])
    await runSetup({ ...base, responderHome, prompt, run: runner })
    await expect(access(join(responderHome, 'settings.json'))).resolves.toBeUndefined()
  })

  it('retries a wrong confirmation and then proceeds once a later attempt matches (case-insensitively)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const dangerous = join(root, 'repo-de-trabajo-3')
    await mkdir(join(dangerous, '.git'), { recursive: true })
    const responderHome = join(root, 'responder-3')
    const { run: runner } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', dangerous, '', 'no gracias', 'Confirmar'])
    await runSetup({ ...base, responderHome, prompt, run: runner })
    await expect(access(join(responderHome, 'settings.json'))).resolves.toBeUndefined()
  })

  it('never accepts "sí", "s" or "y" as the confirmation word — only the word itself', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const dangerous = join(root, 'repo-de-trabajo-4')
    await mkdir(join(dangerous, '.git'), { recursive: true })
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', dangerous, '', 'sí', 's', 'y'])
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/CONFIRMAR/)
    expect(calls).toEqual([])
  })

  it('detects a nested .git two levels deep, not just at the top (C1)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const shareDir = join(root, 'proyectos')
    await mkdir(join(shareDir, 'sub', 'project', '.git'), { recursive: true })
    const responderHome = join(root, 'responder-c1-git')
    const { run: runner } = trackingRunner()
    // '' confirms the resolved path; 'CONFIRMAR' accepts the danger warning this test is
    // actually about — a bare top-level readdir would have found nothing here at all and
    // proceeded with zero warning.
    const prompt = scriptedPrompt([link, '1', shareDir, '', 'CONFIRMAR'])
    await runSetup({ ...base, responderHome, prompt, run: runner })
    const text = base.out.lines.join('\n')
    expect(text).toContain('repositorio de git')
    expect(text).toContain(join('sub', 'project', '.git'))
    await expect(access(join(responderHome, 'settings.json'))).resolves.toBeUndefined()
  })

  it('detects a nested credential-looking file two levels deep, not just at the top (C1)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const shareDir = join(root, 'proyectos-2')
    await mkdir(join(shareDir, 'sub', 'config'), { recursive: true })
    await writeFile(join(shareDir, 'sub', 'config', '.env'), 'AWS_SECRET=xyz\n')
    const responderHome = join(root, 'responder-c1-env')
    const { run: runner } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', shareDir, '', 'CONFIRMAR'])
    await runSetup({ ...base, responderHome, prompt, run: runner })
    const text = base.out.lines.join('\n')
    expect(text).toContain('parecen credenciales')
    expect(text).toContain(join('sub', 'config', '.env'))
    await expect(access(join(responderHome, 'settings.json'))).resolves.toBeUndefined()
  })

  it('a symlinked subdirectory hiding a .git no longer walks past the gate (bug: symlink bypass)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const shareDir = join(root, 'proyectos-symlink')
    const realRepo = join(root, 'real-repo-elsewhere')
    await mkdir(join(realRepo, '.git'), { recursive: true })
    await mkdir(shareDir, { recursive: true })
    // share/repo -> realrepo (with a .git inside) — the exact reproduction: a plain readdir
    // that skips every symlink without a trace previously let this straight through with no
    // `Ojo:`, no gate, and setup went on to create the profile, write CLAUDE.md, and copy the
    // device credential before doctor ever got a chance to notice.
    await symlink(realRepo, join(shareDir, 'repo'))
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', shareDir, '', 'no gracias', 'tampoco', 'de plano no'])
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/CONFIRMAR/)
    const text = base.out.lines.join('\n')
    expect(text).toContain('enlaces simbólicos')
    expect(text).toContain('repo')
    expect(calls).toEqual([])
  })

  it('still proceeds (with CONFIRMAR) once warned about a symlink it could not look inside', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const shareDir = join(root, 'proyectos-symlink-2')
    const realRepo = join(root, 'real-repo-elsewhere-2')
    await mkdir(join(realRepo, '.git'), { recursive: true })
    await mkdir(shareDir, { recursive: true })
    await symlink(realRepo, join(shareDir, 'repo'))
    const responderHome = join(root, 'responder-symlink')
    const { run: runner } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', shareDir, '', 'CONFIRMAR'])
    await runSetup({ ...base, responderHome, prompt, run: runner })
    await expect(access(join(responderHome, 'settings.json'))).resolves.toBeUndefined()
  })

  it('detects a .git FILE (a git worktree or submodule checkout), not just a .git directory', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const shareDir = join(root, 'proyectos-worktree')
    await mkdir(shareDir, { recursive: true })
    await writeFile(join(shareDir, '.git'), 'gitdir: ../elsewhere/.git/worktrees/x\n')
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', shareDir, '', 'no gracias', 'tampoco', 'de plano no'])
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/CONFIRMAR/)
    const text = base.out.lines.join('\n')
    expect(text).toContain('repositorio de git')
    expect(calls).toEqual([])
  })

  it('hitting the depth limit in one deep branch still lets it find danger in a shallow sibling directory', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const shareDir = join(root, 'proyectos-profundo')
    // A branch nested well past the depth cap, with nothing dangerous in it...
    await mkdir(join(shareDir, 'a/b/c/d/e/f/g/h/i/j'), { recursive: true })
    // ...and a completely unrelated SIBLING directory, much shallower, that DOES have a .git.
    // An earlier version set a single global `truncated` flag on hitting the depth cap, which
    // aborted the ENTIRE remaining walk — including sibling directories never even visited yet
    // — so this .git would have gone unreported.
    await mkdir(join(shareDir, 'otro-proyecto', '.git'), { recursive: true })
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', shareDir, '', 'no gracias', 'tampoco', 'de plano no'])
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/CONFIRMAR/)
    const text = base.out.lines.join('\n')
    expect(text).toContain('repositorio de git')
    expect(text).toContain(join('otro-proyecto', '.git'))
    expect(calls).toEqual([])
  })

  it('does not treat a .git buried inside node_modules as this folder’s own repo, but does name node_modules as unreviewed', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const shareDir = join(root, 'proyectos-3')
    // A .git buried inside node_modules (a real, if odd, occurrence with vendored packages)
    // must not be treated as this folder's own working repo — but node_modules itself is still
    // named as unreviewed (Grep can still read a stray .env in there), so this still requires
    // CONFIRMAR rather than sailing through silently.
    await mkdir(join(shareDir, 'node_modules', 'some-pkg', '.git'), { recursive: true })
    await writeFile(join(shareDir, 'readme.txt'), 'hola\n')
    const responderHome = join(root, 'responder-nm')
    const { run: runner } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', shareDir, '', 'CONFIRMAR'])
    await runSetup({ ...base, responderHome, prompt, run: runner })
    const text = base.out.lines.join('\n')
    expect(text).toContain('node_modules')
    expect(text).not.toContain('repositorio de git')
    await expect(access(join(responderHome, 'settings.json'))).resolves.toBeUndefined()
  })

  it('refuses an existing plain file at the chosen path instead of crashing (I5)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const notAFolder = join(root, 'ya-es-un-archivo')
    await writeFile(notAFolder, 'contenido\n')
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', notAFolder, ''])
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/no es una carpeta/i)
    expect(calls).toEqual([])
  })

  it('refuses a dangling symlink at the chosen path instead of crashing (I5)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const brokenLink = join(root, 'enlace-roto')
    await symlink(join(root, 'no-existe-nada-aqui'), brokenLink)
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', brokenLink, ''])
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/enlace roto/i)
    expect(calls).toEqual([])
  })

  // Pure string logic, checked directly against the real home directory rather than through a
  // full `runSetup` — this test creates nothing on disk. An earlier version of this test instead
  // ran a full guided setup against `~/AgentBridge/ab-tilde-test-<timestamp>`, and when an
  // assertion failed partway through (no try/finally around the cleanup line), it left that
  // folder behind in the real home directory rather than a temp one — exactly the mistake this
  // whole feature exists to prevent people from making with their OWN shared folder.
  it('expands a leading ~ or $HOME against the real home directory (I6)', () => {
    expect(expandUserPath('~')).toBe(homedir())
    expect(expandUserPath('~/AgentBridge/compartido')).toBe(join(homedir(), 'AgentBridge/compartido'))
    expect(expandUserPath('$HOME')).toBe(homedir())
    expect(expandUserPath('$HOME/AgentBridge/compartido')).toBe(join(homedir(), 'AgentBridge/compartido'))
    // Never touches a bare relative path or an already-absolute one — those are handled by
    // chooseShareDir's own resolve() call against the current working directory, not by this
    // function, which only expands a LEADING ~ or $HOME.
    expect(expandUserPath('relativo/compartido')).toBe('relativo/compartido')
    expect(expandUserPath('/ya/es/absoluta')).toBe('/ya/es/absoluta')
  })

  it('shows the resolved absolute path and re-asks for a different folder when the person says no (I6)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const firstTry = join(root, 'primera-opcion')
    const secondTry = join(root, 'segunda-opcion')
    const responderHome = join(root, 'responder-retry-folder')
    const { run: runner } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', firstTry, 'n', secondTry, ''])
    await runSetup({ ...base, responderHome, prompt, run: runner })
    const text = base.out.lines.join('\n')
    expect(text).toContain(`Voy a usar esta carpeta: ${firstTry}`)
    expect(text).toContain('Bien, dime otra carpeta.')
    expect(text).toContain(`Voy a usar esta carpeta: ${secondTry}`)
    await expect(access(join(responderHome, 'settings.json'))).resolves.toBeUndefined()
    await expect(access(firstTry)).rejects.toThrow()
  })
})

describe('agentbridge setup — happy path, answering', () => {
  it('enrolls, sets up a responder end to end, runs doctor and lists what is left to do', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const shareDir = join(root, 'compartido')
    const responderHome = join(root, 'responder-happy')
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', shareDir, ''])

    await runSetup({ ...base, responderHome, prompt, run: runner })

    const text = base.out.lines.join('\n')
    // Identity ran through the real enroll path.
    expect(text).toContain('Dev Ejemplo')
    // Never silently creates the folder.
    expect(text).toContain(shareDir)
    expect(text).toMatch(/no existe|la voy a crear/)
    // setup-responder's own log lines came through unmodified (orchestration, not reimplementation).
    expect(text).toContain('Respondedor preparado en')
    // But its own "Siguientes pasos" reminder — which starts by telling the person to spend
    // their enrollment link on step 1 — must be suppressed here: step 1 already happened, in
    // this very run, through THIS orchestration's own identity step, using the only link this
    // person has (bug: contradicts itself about enrollment).
    expect(text).not.toContain('Siguientes pasos:')
    expect(text).not.toContain('Da de alta este dispositivo')
    // doctor's own check lines came through.
    expect(text).toContain('Alta del dispositivo')
    expect(text).toContain('Sesión iniciada en el perfil dedicado')
    // The manual steps that remain, in order, with concrete paths.
    expect(text).toContain(join(responderHome, 'start.sh'))
    expect(text).toContain('agentbridge invite')
    expect(text).toMatch(/CLAUDE_CONFIG_DIR.*claude/)
    // Verdict names the pending login as the next step, since the fake `claude auth status` said not logged in.
    expect(text).toContain('Pendiente')
    expect(text.toLowerCase()).toContain('inicia sesión')

    await expect(access(shareDir)).resolves.toBeUndefined()
    await expect(access(join(responderHome, 'settings.json'))).resolves.toBeUndefined()
    expect(calls.some((c) => c.args.join(' ').includes('plugin marketplace add'))).toBe(true)
  })

  it('drops "inicia sesión" from the closing steps once doctor already reports an active session (bug: contradicted itself)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const shareDir = join(root, 'compartido-logged-in')
    const responderHome = join(root, 'responder-logged-in')
    const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
    const runner: CommandRunner = async (command, args, opts) => {
      calls.push({ command, args, env: opts.env })
      if (command === 'claude' && args[0] === 'auth') return { code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const prompt = scriptedPrompt([link, '1', shareDir, ''])

    await runSetup({ ...base, responderHome, prompt, run: runner })

    const text = base.out.lines.join('\n')
    expect(text).toContain('Sesión activa')
    // The closing "en este orden" list must not repeat "inicia sesión" once doctor already
    // found an active session — telling someone to redo something already done.
    const closingSection = text.split('Para terminar de dejarlo contestando, en este orden:')[1]!.split('== Resumen ==')[0]!
    expect(closingSection.toLowerCase()).not.toContain('inicia sesión')
    expect(closingSection).toContain('Arráncalo')
    // And the pending list must not mention it either, for the same reason.
    const pendingSection = text.split('Pendiente:')[1] ?? ''
    expect(pendingSection.toLowerCase()).not.toContain('inicia sesión')
  })

  it('copies the very same device credential into the responder home so it can actually connect (C2)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const shareDir = join(root, 'compartido-c2')
    const responderHome = join(root, 'responder-c2')
    const { run: runner } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', shareDir, ''])

    await runSetup({ ...base, responderHome, prompt, run: runner })

    // ctx.home (base.home) is where step 1's enroll actually wrote — the identity's canonical
    // home. The dedicated responder session always runs with AGENTBRIDGE_HOME=<responderHome>
    // (see setup-responder.ts's startScript()), so unless the SAME device token also exists
    // there, the channel plugin's own entry point (packages/channel/src/main.ts) finds no
    // config and exits 1 — the exact bug this fixes. One enrollment link, one device token,
    // valid from both directories.
    const identityConfig = JSON.parse(await readFile(join(base.home, 'config.json'), 'utf8'))
    const responderConfig = JSON.parse(await readFile(join(responderHome, 'config.json'), 'utf8'))
    expect(responderConfig).toEqual(identityConfig)
    expect(responderConfig.deviceToken).toBeTruthy()
    const text = base.out.lines.join('\n')
    expect(text).toContain('Copié tu credencial al perfil dedicado')
  })

  it('does not overwrite a responder home that already has a different identity (C2)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const shareDir = join(root, 'compartido-c2b')
    const responderHome = join(root, 'responder-c2b')
    const otherLink = await createEnrollLink('otra', 'Otra Persona')
    expect(await run(['enroll', otherLink], { home: responderHome, out: memoryOutput(), env: {} })).toBe(0)
    const before = await readFile(join(responderHome, 'config.json'), 'utf8')

    const { run: runner } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', shareDir, ''])
    await runSetup({ ...base, responderHome, prompt, run: runner })

    const after = await readFile(join(responderHome, 'config.json'), 'utf8')
    expect(after).toBe(before)
    const text = base.out.lines.join('\n')
    expect(text).toContain('ya tenía otra identidad')
  })

  it('refreshes a stale responder credential — same handle, rotated token — instead of leaving it silently mismatched (bug: stale token)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const shareDir = join(root, 'compartido-stale-token')
    const responderHome = join(root, 'responder-stale-token')
    // Same handle as the identity step 1 is about to establish, but a device token that no
    // longer matches — e.g. this identity was re-enrolled since setup last ran here. Before this
    // fix, only a DIFFERENT handle was ever noticed; a stale token for the SAME handle passed
    // through both branches silently, leaving the responder holding a token the relay might no
    // longer honor.
    await mkdir(responderHome, { recursive: true })
    await writeFile(
      join(responderHome, 'config.json'),
      JSON.stringify({ relayUrl: 'http://127.0.0.1:1', deviceToken: 'un-token-viejo-y-distinto', handle: 'dev', displayName: 'Dev Ejemplo' }),
    )

    const { run: runner } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', shareDir, ''])
    await runSetup({ ...base, responderHome, prompt, run: runner })

    const after = JSON.parse(await readFile(join(responderHome, 'config.json'), 'utf8'))
    const identityConfig = JSON.parse(await readFile(join(base.home, 'config.json'), 'utf8'))
    expect(after).toEqual(identityConfig)
    expect(after.deviceToken).not.toBe('un-token-viejo-y-distinto')
    const text = base.out.lines.join('\n')
    expect(text).toContain('Actualicé la credencial')
  })

  it('the responder actually connects to a real relay after a guided enrollment, instead of exiting 1 (C2, live)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const shareDir = join(root, 'compartido-live')
    const responderHome = join(root, 'responder-live')
    const { run: runner } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', shareDir, ''])
    await runSetup({ ...base, responderHome, prompt, run: runner })

    // Drives the channel plugin's own real entry point — exactly what start.sh's `claude
    // --dangerously-load-development-channels plugin:agentbridge@agentbridge-local` spawns as
    // its MCP server subprocess — with AGENTBRIDGE_HOME pointed at the responder home setup
    // just prepared, against the SAME real relay+Postgres this test suite already runs
    // against. No real `claude` binary involved: this only proves the channel process itself
    // finds its config and completes a real WebSocket handshake, which is exactly what C2 was
    // about (packages/channel/src/main.ts exits 1 with "no config" otherwise). Resolved from
    // the repo root (vitest's own cwd), never from `root` (a throwaway tmpdir).
    const { spawn } = await import('node:child_process')
    const channelEntry = join(process.cwd(), 'packages/channel/src/main.ts')
    const child = spawn(process.execPath, ['--import', 'tsx', channelEntry], {
      env: { ...process.env, AGENTBRIDGE_HOME: responderHome, AGENTBRIDGE_RELAY_URL: relayUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += String(d)))
    const connected = await new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(false), 8000)
      child.stderr.on('data', () => {
        if (/connected to/.test(stderr)) {
          clearTimeout(timer)
          resolvePromise(true)
        }
      })
      child.on('exit', () => {
        clearTimeout(timer)
        resolvePromise(/connected to/.test(stderr))
      })
    })
    child.kill()
    expect(stderr).not.toContain('no config')
    expect(connected).toBe(true)
  }, 15000)
})

describe('agentbridge setup — happy path, asking', () => {
  it('registers the MCP server and explains how to ask, telling the person to restart their session', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('ana', 'Ana')
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, '2', 's'])

    await runSetup({ ...base, prompt, run: runner })

    const text = base.out.lines.join('\n')
    expect(calls).toEqual([
      { command: 'claude', args: ['mcp', 'add', 'agentbridge', '--scope', 'user', '--', 'npx', '-y', 'agentbridge@latest', 'mcp'], env: base.env },
    ])
    expect(text).toContain('MCP')
    expect(text).toMatch(/reinicia|reinici/i)
    expect(text).toContain('agentbridge ask')
    expect(text).toContain('Pendiente')
    // I7: the asker is told to redeem an invite — without it they have no contacts and every
    // `ask` fails.
    expect(text).toContain('agentbridge accept')
    expect(text).toContain('Acepta la invitación')
  })

  it('still explains how to ask, and names the manual command, when the person declines registering the MCP server', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('ana', 'Ana')
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, '2', 'n'])

    await runSetup({ ...base, prompt, run: runner })

    expect(calls).toEqual([])
    const text = base.out.lines.join('\n')
    expect(text).toContain('claude mcp add agentbridge')
    expect(text).toContain('agentbridge ask')
    expect(text).toContain('agentbridge accept')
  })

  it('treats an unrecognized MCP answer, exhausted 3 times, as "no" and still prints the full summary (I8)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('ana', 'Ana')
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, '2', 'tal vez', 'quizás', 'ni idea'])
    // Must NOT throw — exhausting the MCP yes/no must not discard the verdict.
    await runSetup({ ...base, prompt, run: runner })
    expect(calls).toEqual([])
    const text = base.out.lines.join('\n')
    expect(text).toContain('== Resumen ==')
    expect(text).toContain('claude mcp add agentbridge')
  })

  it('does not discard the whole run’s verdict when both roles are chosen and only MCP registration is unclear (I8, ambas)', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('ana', 'Ana')
    const responderHome = join(root, 'responder-i8-both')
    const shareDir = join(root, 'compartido-i8-both')
    const { run: runner } = trackingRunner()
    const prompt = scriptedPrompt([link, '3', shareDir, '', 'tal vez', 'quizás', 'ni idea'])
    await runSetup({ ...base, responderHome, prompt, run: runner })
    const text = base.out.lines.join('\n')
    // The responder side's own success must still show up in the verdict.
    expect(text).toContain('Perfil dedicado preparado en')
    expect(text).toContain('== Resumen ==')
  })
})

describe('agentbridge setup — the verdict reflects what doctor actually found', () => {
  it('lists every failing doctor check as pending, not just whether the profile logged in', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const shareDir = join(root, 'compartido-verdict')
    const responderHome = join(root, 'responder-verdict')
    const { run: runner } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', shareDir, ''])
    await runSetup({ ...base, responderHome, prompt, run: runner })
    const text = base.out.lines.join('\n')
    const pendingSection = text.split('Pendiente:')[1] ?? ''
    expect(pendingSection).toContain('Sesión iniciada en el perfil dedicado')
    // Generic, not tied to which specific check fails: every doctor line printed as [falta]
    // above must also be echoed verbatim into Pendiente — the "Also" bug was that only the
    // login check made it there, discarding the other nine regardless of what they found.
    const doctorFailingNames = text
      .split('\n')
      .filter((l) => l.startsWith('[falta] '))
      .map((l) => l.slice('[falta] '.length).split(':')[0]!.trim())
    for (const name of doctorFailingNames) expect(pendingSection).toContain(name)
  })
})

describe('agentbridge setup — re-asks instead of aborting on a mistyped answer', () => {
  it('re-asks the role question on an unrecognized answer instead of ending the run', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('ana', 'Ana')
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, 'que', '2', 'n'])
    await runSetup({ ...base, prompt, run: runner })
    const text = base.out.lines.join('\n')
    expect(text).toContain('No entendí "que"')
    expect(text).toContain('Escribe 1, 2 o 3')
    expect(calls).toEqual([])
  })

  it('gives up with the usual Spanish error after 3 unrecognized role answers', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('ana', 'Ana')
    const { run: runner } = trackingRunner()
    const prompt = scriptedPrompt([link, 'que', 'como', 'mande'])
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/1, 2 o 3/)
  })

  it('re-asks the MCP yes/no question on an unrecognized answer instead of ending the run', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('ana', 'Ana')
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, '2', 'tal vez', 'n'])
    await runSetup({ ...base, prompt, run: runner })
    const text = base.out.lines.join('\n')
    expect(text).toContain('No entendí "tal vez"')
    expect(calls).toEqual([])
  })

  it('re-asks the enrollment-link question when the answer is empty instead of ending the run', async () => {
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const base = await newBaseContext()
    const { run: runner } = trackingRunner()
    const prompt = scriptedPrompt(['', link, '2', 'n'])
    await runSetup({ ...base, prompt, run: runner })
    const text = base.out.lines.join('\n')
    expect(text).toContain('No escribiste nada')
    expect(text).toContain('Dev Ejemplo')
  })
})

describe('agentbridge setup — EOF safety (a stream that runs out is never retried)', () => {
  it('aborts immediately, instead of spinning, when the answers run out before the flow needs them', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const { run: runner } = trackingRunner()
    // Only the identity question is answered. The role question right after it has nothing
    // left in the scripted queue — scriptedPrompt throws PromptEOF for that, exactly as a real
    // closed/exhausted stdin would. A naive retry loop would treat "no more input" the same as
    // "invalid input" and keep re-asking (spinning, since there is never anything left to
    // read); this must instead abort right away — with the "input closed" message, since a real
    // prompt was already answered once — and never touch the retry budget.
    const prompt = scriptedPrompt([link])
    const start = Date.now()
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/se cerró la entrada/i)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('also aborts immediately when the stream runs out mid-retry, not just before the first attempt', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const { run: runner } = trackingRunner()
    // One invalid role answer uses up a real retry attempt; the stream then ends before a
    // second one is ever given. Must still abort as EOF, not count the exhaustion itself as a
    // second invalid answer.
    const prompt = scriptedPrompt([link, 'que'])
    const start = Date.now()
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/se cerró la entrada/i)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('gives the "input closed" message even when nothing was ever answered, never "no terminal" — that check is setupCommand’s own job', async () => {
    const base = await newBaseContext()
    const { run: runner } = trackingRunner()
    const prompt = scriptedPrompt([])
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/se cerró la entrada/i)
  })
})

describe('setupCommand', () => {
  it('is registered in the router and rejects a mistyped flag in spanish', async () => {
    const ctx = { home: await mkdtemp(join(tmpdir(), 'ab-setup-router-')), out: memoryOutput(), env: {}, prompt: scriptedPrompt([]) }
    expect(await run(['setup', '--bogus'], ctx)).toBe(1)
    expect(ctx.out.errors.join('\n')).toContain('Opción desconocida')
  })
})
