import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLI_COMMAND } from '@agentbridge/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { memoryOutput } from '../src/context'
import { readResponderConfig, responderArgs, runResponder, RESPONDER_CONFIG_FILE } from '../src/commands/responder'

async function profileWith(config: unknown): Promise<string> {
  const profileHome = await mkdtemp(join(tmpdir(), 'ab-responder-'))
  await writeFile(join(profileHome, RESPONDER_CONFIG_FILE), JSON.stringify(config), { mode: 0o600 })
  return profileHome
}

const goodConfig = { version: 1, shareDir: '/tmp/compartido', identityHome: '/tmp/identidad', model: 'sonnet', effort: 'low' }

describe('responder configuration', () => {
  it('reads the config setup wrote', async () => {
    const profileHome = await profileWith(goodConfig)
    await expect(readResponderConfig(profileHome)).resolves.toEqual(goodConfig)
  })

  it('says to run setup when the profile was never prepared', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ab-responder-'))
    // Not a hardcoded regex: CLI_COMMAND is `npx -y <package>@latest`, so "agentbridge" and
    // "setup" are never adjacent in the printed instruction — the substring below is the exact
    // text a person actually sees, and is what every other command names itself with.
    await expect(readResponderConfig(empty)).rejects.toThrow(`${CLI_COMMAND} setup`)
  })

  it('refuses a config with a model that could smuggle arguments', async () => {
    const profileHome = await profileWith({ ...goodConfig, model: 'sonnet --settings /otra/cosa' })
    await expect(readResponderConfig(profileHome)).rejects.toThrow(/no es válido/i)
  })

  it('refuses an effort outside the allowed set', async () => {
    const profileHome = await profileWith({ ...goodConfig, effort: 'turbo' })
    await expect(readResponderConfig(profileHome)).rejects.toThrow(/turbo/)
  })

  it('refuses a config from a future version instead of guessing its shape', async () => {
    const profileHome = await profileWith({ ...goodConfig, version: 2 })
    await expect(readResponderConfig(profileHome)).rejects.toThrow(/versión/i)
  })

  // Review round 1, Important 2: `model`/`effort` were re-validated on read but the two path
  // fields were not, even though the same "this file sits on disk between runs" argument applies
  // to them too. A relative `shareDir` silently serves whatever folder the process happens to be
  // running from instead of the folder setup actually prepared.
  it('refuses a relative shareDir instead of trusting the process cwd', async () => {
    const profileHome = await profileWith({ ...goodConfig, shareDir: './compartido' })
    await expect(readResponderConfig(profileHome)).rejects.toThrow(/ruta.*absoluta/i)
  })

  it('refuses a relative identityHome the same way', async () => {
    const profileHome = await profileWith({ ...goodConfig, identityHome: 'identidad' })
    await expect(readResponderConfig(profileHome)).rejects.toThrow(/ruta.*absoluta/i)
  })

  // The concrete exploit the reviewer reproduced live: a `shareDir` equal to (or containing)
  // `identityHome` fences the answering session INTO the folder holding the secret key instead
  // of away from it, because `blockReadsOutsideWorkingDirectories` fences reads to the cwd.
  it('refuses when the stored identity home equals the stored share folder', async () => {
    const profileHome = await profileWith({ ...goodConfig, shareDir: '/tmp/mismo', identityHome: '/tmp/mismo' })
    await expect(readResponderConfig(profileHome)).rejects.toThrow(/identidad/i)
  })

  it('refuses when the stored identity home sits inside the stored share folder', async () => {
    const profileHome = await profileWith({ ...goodConfig, shareDir: '/tmp/compartido', identityHome: '/tmp/compartido/identidad' })
    await expect(readResponderConfig(profileHome)).rejects.toThrow(/identidad/i)
  })
})

describe('responderArgs', () => {
  it('carries the development channel, the locked settings and the model', () => {
    const args = responderArgs({ settingsPath: '/perfil/settings.json', model: 'sonnet', effort: 'low' })
    expect(args).toEqual([
      '--dangerously-load-development-channels',
      'plugin:agentbridge@agentbridge-local',
      '--permission-mode',
      'dontAsk',
      '--settings',
      '/perfil/settings.json',
      '--model',
      'sonnet',
      '--effort',
      'low',
    ])
  })
})

describe('runResponder', () => {
  // `config.shareDir` becomes the spawned child's `cwd`, and a `cwd` that does not exist raises
  // the exact same ENOENT a missing `claude` binary does — so every test below that expects to
  // reach the spawn step needs a shareDir that is a real directory, not the placeholder string
  // `goodConfig` uses for the tests above that never spawn anything.
  let shareDir: string
  let workingConfig: typeof goodConfig

  beforeEach(async () => {
    shareDir = await mkdtemp(join(tmpdir(), 'ab-responder-share-'))
    workingConfig = { ...goodConfig, shareDir }
  })

  it('runs claude in the shared folder with both homes set', async () => {
    const profileHome = await profileWith(workingConfig)
    const out = memoryOutput()
    const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string }[] = []
    const code = await runResponder({
      profileHome,
      env: { PATH: '/usr/bin' },
      out,
      runInteractive: async (command, args, opts) => {
        calls.push({ command, args, env: opts.env, cwd: opts.cwd })
        return { code: 0, spawnFailed: false }
      },
    })
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('claude')
    expect(calls[0]?.cwd).toBe(shareDir)
    // The person's own identity and database — never a second one for the answering side.
    expect(calls[0]?.env.AGENTBRIDGE_HOME).toBe('/tmp/identidad')
    expect(calls[0]?.env.CLAUDE_CONFIG_DIR).toBe(join(profileHome, 'claude'))
    expect(calls[0]?.args).toContain('--dangerously-load-development-channels')
    expect(calls[0]?.args).toContain(join(profileHome, 'settings.json'))
  })

  // Review round 1, Important 1: `spawn` cannot tell a missing `cwd` apart from a missing
  // binary — both surface as `spawnFailed: true`. Reproduced against the built CLI with a
  // working `claude` stub on PATH and a shareDir that does not exist: without this check, the
  // person is told to reinstall a program that already works. This test proves the check runs
  // BEFORE the spawn (`spawned` stays false), not that it merely produces a nicer message after.
  it('names the missing shared folder instead of blaming Claude Code, and never spawns', async () => {
    const goneShareDir = join(shareDir, 'ya-no-existe')
    const profileHome = await profileWith({ ...goodConfig, shareDir: goneShareDir })
    const out = memoryOutput()
    let spawned = false
    await expect(
      runResponder({
        profileHome,
        env: {},
        out,
        runInteractive: async () => {
          spawned = true
          return { code: 0, spawnFailed: false }
        },
      }),
    ).rejects.toThrow(/no encuentro la carpeta/i)
    expect(spawned).toBe(false)
  })

  it('explains honestly, without claiming a cause it cannot know, when it could not run Claude Code', async () => {
    const profileHome = await profileWith(workingConfig)
    const out = memoryOutput()
    const err: unknown = await runResponder({
      profileHome,
      env: {},
      out,
      runInteractive: async () => ({ code: null, spawnFailed: true }),
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/Claude Code/)
    // Review round 1, ruled-out item: a spawn failure looks identical whether the binary is
    // missing or merely not on this terminal's PATH (an npm-shim on Windows, or a fresh install
    // before the terminal was reopened) — the message must not assert either as a certainty.
    expect((err as Error).message).not.toMatch(/no está instalado\./i)
    expect((err as Error).message).toMatch(/PATH/)
  })

  it('passes a non-zero exit code through without inventing an error', async () => {
    const profileHome = await profileWith(workingConfig)
    const out = memoryOutput()
    const code = await runResponder({
      profileHome,
      env: {},
      out,
      runInteractive: async () => ({ code: 3, spawnFailed: false }),
    })
    expect(code).toBe(3)
  })

  it('treats Ctrl+C as a normal stop, not a failure', async () => {
    const profileHome = await profileWith(workingConfig)
    const out = memoryOutput()
    const code = await runResponder({
      profileHome,
      env: {},
      out,
      runInteractive: async () => ({ code: null, spawnFailed: false }),
    })
    expect(code).toBe(0)
    expect(out.lines.join('\n')).toMatch(/dejaste de contestar|detuviste/i)
  })
})
