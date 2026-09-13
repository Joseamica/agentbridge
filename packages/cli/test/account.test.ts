import type { FastifyInstance } from 'fastify'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_TOKEN, buildListeningApp, freePort, resetDb, testPool } from '../../../apps/relay/test/helpers'
import { memoryOutput, type CliContext } from '../src/context'
import { run } from '../src/router'

let pool: pg.Pool
let app: FastifyInstance
let relayUrl: string

beforeAll(async () => {
  pool = await testPool()
})
beforeEach(async () => {
  await resetDb(pool)
  ;({ app, relayUrl } = await buildListeningApp(pool))
})
afterEach(async () => {
  await app.close()
})
afterAll(async () => {
  await pool.end()
})

async function newContext(): Promise<CliContext & { out: ReturnType<typeof memoryOutput> }> {
  return { home: await mkdtemp(join(tmpdir(), 'ab-cli-')), out: memoryOutput(), env: {} }
}

const lastLine = (lines: string[]) => lines.join('\n')

async function enrolledAs(handle: string, name: string) {
  const admin = await newContext()
  expect(await run(['admin', 'enroll-link', '--handle', handle, '--name', name, '--relay', relayUrl, '--admin-token', ADMIN_TOKEN], admin)).toBe(0)
  const link = lastLine(admin.out.lines).match(/agentbridge enroll (\S+)/)![1]!
  const ctx = await newContext()
  expect(await run(['enroll', link, '--device', `${handle}-mac`], ctx)).toBe(0)
  return ctx
}

describe('CLI account commands', () => {
  it('prints usage and exits 0 for help, 1 for an unknown command', async () => {
    const ctx = await newContext()
    expect(await run(['help'], ctx)).toBe(0)
    expect(lastLine(ctx.out.lines)).toContain('agentbridge enroll')
    expect(await run(['volar'], ctx)).toBe(1)
    expect(lastLine(ctx.out.errors)).toContain('Comando desconocido')
  })

  it('enrolls a device, stores a private config and identifies it', async () => {
    const dev = await enrolledAs('dev', 'Dev Ejemplo')
    expect(lastLine(dev.out.lines)).toContain('@dev')
    expect((await stat(join(dev.home, 'config.json'))).mode & 0o777).toBe(0o600)
    expect(await run(['whoami'], dev)).toBe(0)
    expect(lastLine(dev.out.lines)).toContain(relayUrl)
  })

  it('refuses to enroll a home that already has a device', async () => {
    const dev = await enrolledAs('dev', 'Dev Ejemplo')
    expect(await run(['enroll', `${relayUrl}/e/whatever-code-123`], dev)).toBe(1)
    expect(lastLine(dev.out.errors)).toContain('ya está dado de alta')
  })

  it('invites, accepts, lists and revokes contacts', async () => {
    const dev = await enrolledAs('dev', 'Dev Ejemplo')
    const amieva = await enrolledAs('amieva', 'Amieva')

    expect(await run(['invite'], dev)).toBe(0)
    const link = lastLine(dev.out.lines).match(/agentbridge accept (\S+)/)![1]!
    expect(await run(['accept', link], amieva)).toBe(0)
    expect(lastLine(amieva.out.lines)).toContain('Ya puedes preguntarle a Dev Ejemplo (@dev)')

    expect(await run(['contacts'], amieva)).toBe(0)
    expect(lastLine(amieva.out.lines)).toMatch(/@dev .*desconectado/)

    expect(await run(['accept', link], amieva)).toBe(1)
    expect(lastLine(amieva.out.errors)).toContain('ya se usó')

    expect(await run(['revoke', 'amieva'], dev)).toBe(0)
    await run(['contacts'], amieva)
    expect(lastLine(amieva.out.lines)).toContain('Nadie te ha dado permiso')
  })

  it('tells the user to enroll first when there is no config', async () => {
    const ctx = await newContext()
    expect(await run(['whoami'], ctx)).toBe(1)
    expect(lastLine(ctx.out.errors)).toContain('agentbridge enroll')
  })

  it('translates a mistyped flag into spanish instead of the raw node:util parseArgs error', async () => {
    const ctx = await newContext()
    expect(await run(['admin', 'enroll-link', '--bogus-flag', 'foo'], ctx)).toBe(1)
    const err = lastLine(ctx.out.errors)
    expect(err).toContain('Opción desconocida')
    expect(err).not.toContain('Unknown option')
  })

  // `admin enroll-link` takes no positionals, so `parseArgs` never sets `allowPositionals:
  // true` for it — its ERR_PARSE_ARGS_UNKNOWN_OPTION message never grows the extra "To specify
  // a positional argument..." sentence Node appends only in that mode. `ask` does take
  // positionals (the handle and the question), so it is the shape that actually exercises the
  // bug: a `$`-anchored translator regex misses that longer message entirely and falls back to
  // echoing the whole raw English string.
  it('translates a mistyped flag on a command with positionals (allowPositionals: true), not just one with none', async () => {
    const ctx = await newContext()
    expect(await run(['ask', 'dev', '--nope'], ctx)).toBe(1)
    const err = lastLine(ctx.out.errors)
    expect(err).toContain("Opción desconocida: --nope")
    expect(err).not.toContain('Unknown option')
    expect(err).not.toContain('To specify a positional argument')
  })

  it('reports an unreachable relay as a spanish, expected failure (exit 1), not a crash', async () => {
    const ctx = await newContext()
    const deadPort = await freePort()
    expect(
      await run(
        ['admin', 'enroll-link', '--handle', 'x', '--name', 'X', '--relay', `http://127.0.0.1:${deadPort}`, '--admin-token', ADMIN_TOKEN],
        ctx,
      ),
    ).toBe(1)
    const err = lastLine(ctx.out.errors)
    expect(err).toContain('No se pudo conectar con el relay')
    expect(err).not.toContain('fetch failed')
  })

  it('reports a corrupted config file in spanish without echoing its contents', async () => {
    const ctx = await newContext()
    await writeFile(join(ctx.home, 'config.json'), '{ this is not valid json', 'utf8')
    expect(await run(['whoami'], ctx)).toBe(1)
    const err = lastLine(ctx.out.errors)
    expect(err).toContain('dañado')
    expect(err).not.toContain('this is not valid json')
  })

  it('rejects a relay URL with no scheme in spanish (exit 1), before any network attempt', async () => {
    const ctx = await newContext()
    expect(
      await run(['admin', 'enroll-link', '--handle', 'x', '--name', 'X', '--relay', '127.0.0.1:8099', '--admin-token', ADMIN_TOKEN], ctx),
    ).toBe(1)
    const err = lastLine(ctx.out.errors)
    expect(err).toContain('URL del relay no es válida')
    expect(err).not.toContain('Failed to parse URL')
    expect(err).not.toContain('Error inesperado')
  })
})
