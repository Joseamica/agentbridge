import type { FastifyInstance } from 'fastify'
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_TOKEN, buildListeningApp, resetDb, testPool } from '../../../apps/relay/test/helpers'
import type { CommandRunner } from '../src/commands/setup-responder'
import { runSetup } from '../src/commands/setup'
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
    const prompt = scriptedPrompt([link, '1', homedir()])
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/carpeta de usuario|home/i)
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
    const prompt = scriptedPrompt([link, '1', dangerous, 'no gracias', 'tampoco', 'de plano no'])
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
    const prompt = scriptedPrompt([link, '1', dangerous, '  confirmar  '])
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
    const prompt = scriptedPrompt([link, '1', dangerous, 'no gracias', 'Confirmar'])
    await runSetup({ ...base, responderHome, prompt, run: runner })
    await expect(access(join(responderHome, 'settings.json'))).resolves.toBeUndefined()
  })

  it('never accepts "sí", "s" or "y" as the confirmation word — only the word itself', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const dangerous = join(root, 'repo-de-trabajo-4')
    await mkdir(join(dangerous, '.git'), { recursive: true })
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', dangerous, 'sí', 's', 'y'])
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/CONFIRMAR/)
    expect(calls).toEqual([])
  })
})

describe('agentbridge setup — happy path, answering', () => {
  it('enrolls, sets up a responder end to end, runs doctor and lists what is left to do', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const shareDir = join(root, 'compartido')
    const responderHome = join(root, 'responder-happy')
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', shareDir])

    await runSetup({ ...base, responderHome, prompt, run: runner })

    const text = base.out.lines.join('\n')
    // Identity ran through the real enroll path.
    expect(text).toContain('Dev Ejemplo')
    // Never silently creates the folder.
    expect(text).toContain(shareDir)
    expect(text).toMatch(/no existe|la voy a crear/)
    // setup-responder's own log lines came through unmodified (orchestration, not reimplementation).
    expect(text).toContain('Respondedor preparado en')
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
    // read); this must instead abort right away with the same message a non-interactive run
    // gets, and never touch the retry budget.
    const prompt = scriptedPrompt([link])
    const start = Date.now()
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/terminal interactiva/i)
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
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/terminal interactiva/i)
    expect(Date.now() - start).toBeLessThan(2000)
  })
})

describe('setupCommand', () => {
  it('is registered in the router and rejects a mistyped flag in spanish', async () => {
    const ctx = { home: await mkdtemp(join(tmpdir(), 'ab-setup-router-')), out: memoryOutput(), env: {}, prompt: scriptedPrompt([]) }
    expect(await run(['setup', '--bogus'], ctx)).toBe(1)
    expect(ctx.out.errors.join('\n')).toContain('Opción desconocida')
  })
})
