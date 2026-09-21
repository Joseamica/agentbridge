import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLI_COMMAND } from '@agentbridge/core'
import { describe, expect, it } from 'vitest'
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
  it('runs claude in the shared folder with both homes set', async () => {
    const profileHome = await profileWith(goodConfig)
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
    expect(calls[0]?.cwd).toBe('/tmp/compartido')
    // The person's own identity and database — never a second one for the answering side.
    expect(calls[0]?.env.AGENTBRIDGE_HOME).toBe('/tmp/identidad')
    expect(calls[0]?.env.CLAUDE_CONFIG_DIR).toBe(join(profileHome, 'claude'))
    expect(calls[0]?.args).toContain('--dangerously-load-development-channels')
    expect(calls[0]?.args).toContain(join(profileHome, 'settings.json'))
  })

  it('explains in Spanish when claude is not installed', async () => {
    const profileHome = await profileWith(goodConfig)
    const out = memoryOutput()
    await expect(
      runResponder({
        profileHome,
        env: {},
        out,
        runInteractive: async () => ({ code: null, spawnFailed: true }),
      }),
    ).rejects.toThrow(/Claude Code/)
  })

  it('passes a non-zero exit code through without inventing an error', async () => {
    const profileHome = await profileWith(goodConfig)
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
    const profileHome = await profileWith(goodConfig)
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
