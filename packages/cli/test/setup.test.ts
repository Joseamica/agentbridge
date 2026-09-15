import type { FastifyInstance } from 'fastify'
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_TOKEN, buildListeningApp, resetDb, testPool } from '../../../apps/relay/test/helpers'
import type { CommandRunner } from '../src/commands/setup-responder'
import { runSetup } from '../src/commands/setup'
import { memoryOutput, type Prompt } from '../src/context'
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

function scriptedPrompt(answers: string[]): Prompt {
  const queue = [...answers]
  return async (question: string) => {
    if (queue.length === 0) throw new Error(`setup pidió una respuesta de más para: ${question}`)
    return queue.shift()!
  }
}

const okRunner: CommandRunner = async () => ({ code: 0, stdout: '', stderr: '' })

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

  it('refuses a folder containing a git repo unless the person types the exact confirmation', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const dangerous = join(root, 'repo-de-trabajo')
    await mkdir(join(dangerous, '.git'), { recursive: true })
    const { run: runner, calls } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', dangerous, 'no gracias'])
    await expect(runSetup({ ...base, prompt, run: runner })).rejects.toThrow(/no confirmaste|CONFIRMAR/i)
    expect(calls).toEqual([])
  })

  it('proceeds with a dangerous folder once the person types the exact confirmation', async () => {
    const base = await newBaseContext()
    const link = await createEnrollLink('dev', 'Dev Ejemplo')
    const dangerous = join(root, 'repo-de-trabajo-2')
    await mkdir(join(dangerous, '.git'), { recursive: true })
    const responderHome = join(root, 'responder-2')
    const { run: runner } = trackingRunner()
    const prompt = scriptedPrompt([link, '1', dangerous, 'CONFIRMAR'])
    await runSetup({ ...base, responderHome, prompt, run: runner })
    await expect(access(join(responderHome, 'settings.json'))).resolves.toBeUndefined()
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

describe('setupCommand', () => {
  it('is registered in the router and rejects a mistyped flag in spanish', async () => {
    const ctx = { home: await mkdtemp(join(tmpdir(), 'ab-setup-router-')), out: memoryOutput(), env: {}, prompt: scriptedPrompt([]) }
    expect(await run(['setup', '--bogus'], ctx)).toBe(1)
    expect(ctx.out.errors.join('\n')).toContain('Opción desconocida')
  })
})
