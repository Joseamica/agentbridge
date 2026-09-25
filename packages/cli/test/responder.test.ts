import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLI_COMMAND } from '@agentbridge/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { memoryOutput } from '../src/context'
import { readResponderConfig, responderArgs, runResponder, RESPONDER_CONFIG_FILE } from '../src/commands/responder'
import { responderSettings } from '../src/commands/setup-responder'

// Mode 1 ignores the paths entirely; they are here only because the signature takes them.
const modeOne = () => responderSettings({ kind: 'folder' }, { identityHome: '/tmp/identidad', profileHome: '/tmp/perfil', home: '/tmp/casa' })

// `settingsText` is what lands in the profile's settings.json — the file `--settings` points
// `claude` at, and the only thing that actually fences the answering session. It defaults to
// exactly what setupResponder writes, because every test that reaches the spawn needs a profile
// that is genuinely safe to start; the fence tests below pass their own broken shapes, and
// `null` leaves the file out altogether.
async function profileWith(config: unknown, settingsText: string | null = JSON.stringify(modeOne())): Promise<string> {
  const profileHome = await mkdtemp(join(tmpdir(), 'ab-responder-'))
  await writeFile(join(profileHome, RESPONDER_CONFIG_FILE), JSON.stringify(config), { mode: 0o600 })
  if (settingsText !== null) await writeFile(join(profileHome, 'settings.json'), settingsText, { mode: 0o600 })
  return profileHome
}

const goodConfig = { version: 1, shareDir: '/tmp/compartido', identityHome: '/tmp/identidad', model: 'sonnet', effort: 'low' }

describe('responder configuration', () => {
  // Every 0.3 install has a version-1 file and no `scope`. It must keep working without re-running
  // setup, and it means exactly what it meant then: one folder.
  it('reads a version-1 config as mode 1', async () => {
    const profileHome = await profileWith(goodConfig)
    await expect(readResponderConfig(profileHome)).resolves.toEqual({ ...goodConfig, version: 2, scope: { kind: 'folder' } })
  })

  it('reads a version-2 config with each of the three scopes', async () => {
    for (const scope of [{ kind: 'folder' }, { kind: 'home' }, { kind: 'folders', extra: ['/tmp/otra', '/srv/notas'] }]) {
      const profileHome = await profileWith({ ...goodConfig, version: 2, scope })
      await expect(readResponderConfig(profileHome)).resolves.toEqual({ ...goodConfig, version: 2, scope })
    }
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
    const profileHome = await profileWith({ ...goodConfig, version: 3, scope: { kind: 'folder' } })
    await expect(readResponderConfig(profileHome)).rejects.toThrow(/versión/i)
  })

  // The scope decides which folders the answering session can read, so a hand-edited or
  // half-written value is refused, never guessed at — the same discipline as the two paths above.
  describe('a version-2 scope', () => {
    const v2 = (scope: unknown) => ({ ...goodConfig, version: 2, scope })
    const refuses = async (scope: unknown, pattern: RegExp) => {
      const profileHome = await profileWith(v2(scope))
      await expect(readResponderConfig(profileHome)).rejects.toThrow(pattern)
    }

    it('is required', () => refuses(undefined, /alcance/i))
    it('must have a known kind', () => refuses({ kind: 'todo' }, /alcance/i))
    it('needs at least one extra folder in mode 2', () => refuses({ kind: 'folders', extra: [] }, /alcance/i))
    it('needs every extra folder to be an absolute path', () => refuses({ kind: 'folders', extra: ['otra'] }, /absoluta/i))
    it('refuses an extra folder that is not a string', () => refuses({ kind: 'folders', extra: [7] }, /alcance/i))
    it('refuses the same folder twice', () => refuses({ kind: 'folders', extra: ['/tmp/otra', '/tmp/otra'] }, /repetid|dentro de otra/i))
    it('refuses an extra folder inside another extra folder', () =>
      refuses({ kind: 'folders', extra: ['/tmp/otra', '/tmp/otra/sub'] }, /repetid|dentro de otra/i))
    it('refuses an extra folder equal to the shared folder', () => refuses({ kind: 'folders', extra: ['/tmp/compartido'] }, /compartida/i))
    it('refuses an extra folder inside the shared folder', () =>
      refuses({ kind: 'folders', extra: ['/tmp/compartido/sub'] }, /compartida/i))
    // The fence is what keeps the key and the database away from a question. An extra folder
    // that contains them puts them back inside the readable set.
    it('refuses an extra folder that contains the identity home', () => refuses({ kind: 'folders', extra: ['/tmp'] }, /identidad/i))
    it('refuses an extra folder that contains the dedicated profile', async () => {
      const profileHome = await profileWith(v2({ kind: 'folders', extra: [tmpdir()] }))
      await expect(readResponderConfig(profileHome)).rejects.toThrow(/perfil/i)
    })
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

  // Found by running the packaged CLI in a real terminal (task 8): on a freshly created dedicated
  // profile, the first thing printed was "Estás contestando preguntas" — and then Claude Code ran
  // its OWN onboarding, a seven-option theme picker and, with no session, a login menu and the
  // whole browser flow. The claim was false at the moment the person read it.
  it('announces what is about to happen instead of claiming what has not happened yet', async () => {
    const profileHome = await profileWith(workingConfig)
    const out = memoryOutput()
    let saidBeforeClaudeStarted = ''
    await runResponder({
      profileHome,
      env: {},
      out,
      runInteractive: async () => {
        saidBeforeClaudeStarted = out.lines.join('\n')
        return { code: 0, spawnFailed: false }
      },
    })
    // Nothing may assert that they are already answering: Claude has not even been handed the
    // terminal yet at this point.
    expect(saidBeforeClaudeStarted).not.toMatch(/Estás contestando preguntas/)
    // What it says instead: what is about to happen, how to stop it…
    expect(saidBeforeClaudeStarted).toMatch(/Ctrl\+C/)
    // …and the heads-up that Claude asks a couple of questions of its own the first time, so a
    // theme picker or a login menu is not a sign that something went wrong.
    expect(saidBeforeClaudeStarted).toMatch(/primera vez/i)
    expect(saidBeforeClaudeStarted).toMatch(/tema de colores/i)
  })

  // Whole-branch review, Important 1. `claude` refuses a MISSING --settings file but accepts one
  // that exists and is not valid JSON, in silence (verified against the real 2.1.278 binary) — so
  // the one shape that leaves the answering session unfenced is the one Claude does not catch.
  // Every case below must be refused BEFORE the spawn: a session started with
  // --permission-mode dontAsk and no deny list and no read fence is answering another person's
  // questions with Bash, Write and WebFetch reachable and the whole machine readable.
  describe('the fence around the answering session', () => {
    async function startWith(settingsText: string | null): Promise<{ error: unknown; spawned: boolean }> {
      const profileHome = await profileWith(workingConfig, settingsText)
      let spawned = false
      const error: unknown = await runResponder({
        profileHome,
        env: {},
        out: memoryOutput(),
        runInteractive: async () => {
          spawned = true
          return { code: 0, spawnFailed: false }
        },
      }).catch((e: unknown) => e)
      return { error, spawned }
    }

    it('refuses to start when settings.json is missing, and never spawns', async () => {
      const { error, spawned } = await startWith(null)
      expect((error as Error).message).toMatch(/permisos/i)
      expect((error as Error).message).toContain(`${CLI_COMMAND} setup`)
      expect(spawned).toBe(false)
    })

    it('refuses to start when settings.json exists but is not valid JSON, and never spawns', async () => {
      const { error, spawned } = await startWith('no-json')
      expect((error as Error).message).toMatch(/JSON/i)
      expect(spawned).toBe(false)
    })

    it('refuses to start when a deny rule is gone, naming it, and never spawns', async () => {
      const weakened = modeOne()
      weakened.permissions.deny = weakened.permissions.deny.filter((rule) => rule !== 'Bash')
      const { error, spawned } = await startWith(JSON.stringify(weakened))
      expect((error as Error).message).toContain('Bash')
      expect(spawned).toBe(false)
    })

    it('refuses to start when the read fence is not true, and never spawns', async () => {
      const unfenced = modeOne() as { permissions: { blockReadsOutsideWorkingDirectories: boolean } }
      unfenced.permissions.blockReadsOutsideWorkingDirectories = false
      const { error, spawned } = await startWith(JSON.stringify(unfenced))
      expect((error as Error).message).toContain('blockReadsOutsideWorkingDirectories')
      expect(spawned).toBe(false)
    })

    // The subtlety the fence's own comment records: Claude Code reads this key nested INSIDE
    // `permissions`. A copy beside it is valid JSON, is accepted in silence, and never engages —
    // so a checker that reads it from the top level would wave through a genuinely unfenced
    // profile. This is the shape that proves the check reads the nested place.
    it('refuses a fence written beside `permissions` instead of inside it', async () => {
      const misplaced = modeOne() as Record<string, unknown> & { permissions: Record<string, unknown> }
      delete misplaced.permissions.blockReadsOutsideWorkingDirectories
      misplaced.blockReadsOutsideWorkingDirectories = true
      const { error, spawned } = await startWith(JSON.stringify(misplaced))
      expect((error as Error).message).toContain('blockReadsOutsideWorkingDirectories')
      expect(spawned).toBe(false)
    })

    it('starts normally with the settings setupResponder writes', async () => {
      const profileHome = await profileWith(workingConfig)
      let spawned = false
      const code = await runResponder({
        profileHome,
        env: {},
        out: memoryOutput(),
        runInteractive: async () => {
          spawned = true
          return { code: 0, spawnFailed: false }
        },
      })
      expect(spawned).toBe(true)
      expect(code).toBe(0)
    })
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

  // Whole-branch review, Important 3: the branch above only fires when the child dies BY A SIGNAL
  // while this process survives. Once Claude Code has the terminal it handles Ctrl+C itself and
  // exits cleanly, which is the shape a person actually gets a second in — and it used to print
  // nothing at all, so pressing the key the docs tell them to press answered with silence.
  it('says the same thing when Claude handled the Ctrl+C itself and exited cleanly', async () => {
    const profileHome = await profileWith(workingConfig)
    const out = memoryOutput()
    const code = await runResponder({
      profileHome,
      env: {},
      out,
      runInteractive: async () => ({ code: 0, spawnFailed: false }),
    })
    expect(code).toBe(0)
    expect(out.lines.join('\n')).toMatch(/dejaste de contestar/i)
    expect(out.lines.join('\n')).toMatch(/siete días/)
  })
})
