import { CLI_COMMAND } from '@agentbridge/core'
import { access, chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  defaultRunner,
  findPluginRoot,
  REPLY_TOOL_NAME,
  repoDirFromBundleLocation,
  RESPONDER_DENY,
  responderSettings,
  setupResponder,
  setupResponderCommand,
  startScript,
  type CommandRunner,
} from '../src/commands/setup-responder'
import { CliError, memoryOutput } from '../src/context'

let root: string
let repoDir: string
let shareDir: string
let home: string
let identityHome: string
let calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[]
const runner: CommandRunner = async (command, args, opts) => {
  calls.push({ command, args, env: opts.env })
  return { code: 0, stdout: '', stderr: '' }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ab-setup-'))
  repoDir = join(root, 'repo')
  shareDir = join(root, 'compartido')
  home = join(root, 'responder')
  identityHome = join(root, 'identidad')
  calls = []
  await mkdir(join(repoDir, 'plugins/agentbridge/dist'), { recursive: true })
  await writeFile(join(repoDir, 'plugins/agentbridge/dist/server.js'), '// bundle')
})

describe('RESPONDER_DENY', () => {
  // Pinned as literal strings, independent of the constant it also checks against elsewhere
  // (the settings-shape test below, and doctor.ts's own check) — a change to the constant
  // that silently drops one of these entries must fail a test even though every other
  // assertion in this file compares against the same, now-changed, constant.
  it('denies exactly these nine tool rules', () => {
    expect(RESPONDER_DENY).toEqual([
      'Bash',
      'Edit',
      'Write',
      'NotebookEdit',
      'WebFetch',
      'WebSearch',
      'Agent',
      'Read(**/.env)',
      'Read(**/.env.*)',
    ])
  })
})

describe('responderSettings', () => {
  // Claude Code's settings schema declares `blockReadsOutsideWorkingDirectories` INSIDE the
  // `permissions` object (next to `defaultMode` and `additionalDirectories`), not as a sibling
  // of it — an unknown top-level key is silently accepted and does nothing. Pinned as a full
  // literal object (not built from the constants under test) so a regression that moves the
  // key back out to the top level fails this test even if every other assertion in this file
  // is only comparing the written file against the same, now-wrong, function output.
  it('nests blockReadsOutsideWorkingDirectories inside permissions, where Claude Code actually reads it', () => {
    expect(responderSettings()).toEqual({
      permissions: {
        allow: ['mcp__plugin_agentbridge_agentbridge__reply'],
        deny: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Read(**/.env)', 'Read(**/.env.*)'],
        blockReadsOutsideWorkingDirectories: true,
      },
    })
  })
})

describe('defaultRunner', () => {
  it(
    'kills a real hung child when its signal aborts, rather than leaving it orphaned',
    async () => {
      // A real OS process, not a mock: a mock CommandRunner has no process for anything to kill,
      // so it cannot prove this — see doctor.ts's own bounded login check, which relies on this
      // exact behavior to avoid leaving `claude auth status` running forever.
      const scriptPath = join(root, 'hang.js')
      const pidPath = join(root, 'hang.pid')
      await writeFile(
        scriptPath,
        ["require('node:fs').writeFileSync(process.argv[2], String(process.pid))", 'setInterval(() => {}, 1_000)', ''].join('\n'),
      )
      const result = await defaultRunner(process.execPath, [scriptPath, pidPath], { env: process.env, signal: AbortSignal.timeout(1_000) })
      expect(result.code).toBe(124)
      const pid = Number(await readFile(pidPath, 'utf8'))
      // Signal 0 sends nothing; it only checks whether the process still exists. ESRCH means it
      // is gone — defaultRunner's own kill must already have reaped it by the time the call
      // resolves, not merely raced a promise while the real child (and its open stdio, which
      // keeps the event loop alive) lived on.
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/)
    },
    10_000,
  )
})

describe('setupResponder', () => {
  it('prints next steps as login, start and doctor, never an enroll instruction', async () => {
    const out = memoryOutput()
    await setupResponder({ shareDir, repoDir, profileHome: home, identityHome, run: runner, out })
    const text = out.lines.join('\n')
    expect(text).toContain(`CLAUDE_CONFIG_DIR='${join(home, 'claude')}' claude`)
    expect(text).toContain(`'${join(home, 'start.sh')}'`)
    expect(text).toContain(`${CLI_COMMAND} doctor --home '${identityHome}' --profile '${home}'`)
    expect(text).not.toContain('enroll')
    expect(text).not.toMatch(/(^|\s)agentbridge (enroll|doctor)\b/m)
  })

  it('writes locked-down settings, the persona and an executable start script', async () => {
    const result = await setupResponder({ shareDir, repoDir, profileHome: home, identityHome, run: runner, out: memoryOutput() })

    const settings = JSON.parse(await readFile(result.settingsPath, 'utf8'))
    expect(settings).toEqual({
      permissions: {
        allow: [REPLY_TOOL_NAME],
        deny: [...RESPONDER_DENY],
        blockReadsOutsideWorkingDirectories: true,
      },
    })
    expect((await stat(result.settingsPath)).mode & 0o777).toBe(0o600)

    const persona = await readFile(join(shareDir, 'CLAUDE.md'), 'utf8')
    expect(persona).toContain('reply')
    expect(persona).toContain('.env')

    const script = await readFile(result.startScriptPath, 'utf8')
    expect((await stat(result.startScriptPath)).mode & 0o111).not.toBe(0)
    expect(script).toContain(`cd '${shareDir}'`)
    expect(script).toContain(`export AGENTBRIDGE_HOME='${identityHome}'`)
    expect(script).toContain(`export CLAUDE_CONFIG_DIR='${join(home, 'claude')}'`)
    expect(script).toContain('--dangerously-load-development-channels plugin:agentbridge@agentbridge-local')
    expect(script).toContain('--permission-mode dontAsk')
    expect(script).toContain(`--settings '${result.settingsPath}'`)
    expect(script).toContain("--model 'sonnet' --effort 'low'")

    // The shared folder must not be left world-readable by the default umask on a
    // multi-user machine.
    expect((await stat(shareDir)).mode & 0o777).toBe(0o700)
  })

  it('installs the marketplace and plugin into the dedicated Claude profile only', async () => {
    await setupResponder({ shareDir, repoDir, profileHome: home, identityHome, run: runner, out: memoryOutput() })
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([
      ['claude', 'plugin', 'marketplace', 'add', repoDir],
      ['claude', 'plugin', 'install', 'agentbridge@agentbridge-local', '--scope', 'user'],
    ])
    for (const c of calls) expect(c.env.CLAUDE_CONFIG_DIR).toBe(join(home, 'claude'))
  })

  it('keeps an existing CLAUDE.md in the shared folder', async () => {
    await mkdir(shareDir, { recursive: true })
    await writeFile(join(shareDir, 'CLAUDE.md'), 'mis reglas')
    const out = memoryOutput()
    await setupResponder({ shareDir, repoDir, profileHome: home, identityHome, run: runner, out })
    expect(await readFile(join(shareDir, 'CLAUDE.md'), 'utf8')).toBe('mis reglas')
    expect(out.lines.join('\n')).toContain('Ya existe')
  })

  it('keeps an existing settings.json in the responder home untouched', async () => {
    await mkdir(home, { recursive: true })
    const hardened = JSON.stringify({ permissions: { allow: [], deny: ['Bash', 'Read'] }, hooks: { custom: true } })
    await writeFile(join(home, 'settings.json'), hardened)
    const out = memoryOutput()
    const result = await setupResponder({ shareDir, repoDir, profileHome: home, identityHome, run: runner, out })
    expect(await readFile(result.settingsPath, 'utf8')).toBe(hardened)
    expect(out.lines.join('\n')).toContain('Ya existe')
  })

  it('does not re-permission a pre-existing home directory (a misaimed --profile is not silently narrowed)', async () => {
    await mkdir(home, { recursive: true, mode: 0o755 })
    await chmod(home, 0o755)
    await setupResponder({ shareDir, repoDir, profileHome: home, identityHome, run: runner, out: memoryOutput() })
    expect((await stat(home)).mode & 0o777).toBe(0o755)
  })

  it('chmods a freshly-created home directory to 0700', async () => {
    await setupResponder({ shareDir, repoDir, profileHome: home, identityHome, run: runner, out: memoryOutput() })
    expect((await stat(home)).mode & 0o777).toBe(0o700)
  })

  it('chmods intermediate directories it creates along the way, not just the leaf', async () => {
    const deepHome = join(root, 'nested', 'path', 'responder')
    await setupResponder({ shareDir, repoDir, profileHome: deepHome, identityHome, run: runner, out: memoryOutput() })
    expect((await stat(join(root, 'nested'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, 'nested', 'path'))).mode & 0o777).toBe(0o700)
    expect((await stat(deepHome)).mode & 0o777).toBe(0o700)
  })

  it('refuses to continue when the plugin bundle was not built', async () => {
    await expect(
      setupResponder({ shareDir, repoDir: join(root, 'vacio'), profileHome: home, identityHome, run: runner, out: memoryOutput() }),
    ).rejects.toThrow('npm run build')
  })

  it('rejects a --model value containing a shell metacharacter', async () => {
    await expect(
      setupResponder({ shareDir, repoDir, profileHome: home, identityHome, model: 'sonnet; curl http://evil', run: runner, out: memoryOutput() }),
    ).rejects.toThrow(/modelo/i)
  })

  it('accepts a full model id (not just the short aliases)', async () => {
    await expect(
      setupResponder({
        shareDir,
        repoDir,
        profileHome: home,
        identityHome,
        model: 'claude-haiku-4-5-20251001',
        run: runner,
        out: memoryOutput(),
      }),
    ).resolves.toBeDefined()
  })

  it('rejects a bogus --effort value', async () => {
    await expect(
      setupResponder({ shareDir, repoDir, profileHome: home, identityHome, effort: 'extreme', run: runner, out: memoryOutput() }),
    ).rejects.toThrow(/esfuerzo/i)
  })

  it('rejects a --effort value containing a shell metacharacter', async () => {
    await expect(
      setupResponder({
        shareDir,
        repoDir,
        profileHome: home,
        identityHome,
        effort: '$(cat ~/.ssh/id_rsa)',
        run: runner,
        out: memoryOutput(),
      }),
    ).rejects.toThrow(/esfuerzo/i)
  })

  it('accepts the xhigh effort level', async () => {
    await expect(
      setupResponder({ shareDir, repoDir, profileHome: home, identityHome, effort: 'xhigh', run: runner, out: memoryOutput() }),
    ).resolves.toBeDefined()
  })

  // The message never echoes the subprocess's own output (it can carry arbitrary text) — only
  // which command failed and its exit code, plus how to see the real output by hand.
  it('fails without leaking the raw command output when claude plugin install fails', async () => {
    const failing: CommandRunner = async (command, args) =>
      args.includes('install') ? { code: 1, stdout: '', stderr: 'plugin not found' } : { code: 0, stdout: '', stderr: '' }
    const err: unknown = await setupResponder({ shareDir, repoDir, profileHome: home, identityHome, run: failing, out: memoryOutput() }).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).message).toMatch(/código 1/)
    expect((err as CliError).message).not.toContain('plugin not found')
  })

  it('does not treat an unrelated "already" failure as a successful idempotent install', async () => {
    const failing: CommandRunner = async (command, args) =>
      args.includes('install')
        ? { code: 1, stdout: '', stderr: 'the plugin registry was already unavailable when this request was attempted' }
        : { code: 0, stdout: '', stderr: '' }
    const err: unknown = await setupResponder({ shareDir, repoDir, profileHome: home, identityHome, run: failing, out: memoryOutput() }).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).message).toMatch(/código 1/)
    expect((err as CliError).message).not.toContain('already unavailable')
  })

  it('treats a genuine "already installed" failure naming the target as success', async () => {
    const idempotent: CommandRunner = async (command, args) =>
      args.includes('install')
        ? { code: 1, stdout: '', stderr: 'Plugin agentbridge@agentbridge-local is already installed' }
        : { code: 0, stdout: '', stderr: '' }
    await expect(
      setupResponder({ shareDir, repoDir, profileHome: home, identityHome, run: idempotent, out: memoryOutput() }),
    ).resolves.toBeDefined()
  })

  // The device token (config.json), settings.json and start.sh all land under --home.
  // blockReadsOutsideWorkingDirectories only fences reads to the session's cwd (--share), and
  // the two Read(**/.env*) denies only cover --share too — so a --home that is --share, or
  // inside it, leaves the token readable by a crafted question. Refused before anything is
  // created: none of these should leave a trace on disk.
  describe('refuses a --profile that is the same as, or inside, --share', () => {
    it('rejects --profile === --share', async () => {
      await expect(
        setupResponder({ shareDir, repoDir, profileHome: shareDir, identityHome, run: runner, out: memoryOutput() }),
      ).rejects.toThrow(/--profile/)
      await expect(access(join(shareDir, 'CLAUDE.md'))).rejects.toThrow()
    })

    it('rejects --profile nested inside --share', async () => {
      const nestedHome = join(shareDir, '.ab')
      await expect(
        setupResponder({ shareDir, repoDir, profileHome: nestedHome, identityHome, run: runner, out: memoryOutput() }),
      ).rejects.toThrow(/--profile/)
      await expect(access(nestedHome)).rejects.toThrow()
    })

    it('catches the same problem through a relative path and a trailing slash, not just two already-absolute spellings', async () => {
      const cwdBefore = process.cwd()
      process.chdir(root)
      try {
        const relativeShare = 'compartido'
        const nestedHomeWithSlash = `${relativeShare}/.ab/`
        await expect(
          setupResponder({ shareDir: relativeShare, repoDir, profileHome: nestedHomeWithSlash, identityHome, run: runner, out: memoryOutput() }),
        ).rejects.toThrow(/--profile/)
      } finally {
        process.chdir(cwdBefore)
      }
    })

    it('catches the same problem through a symlinked --share (resolves to the real path first)', async () => {
      const realShare = join(root, 'real-compartido')
      const linkedShare = join(root, 'link-compartido')
      await mkdir(realShare, { recursive: true })
      await symlink(realShare, linkedShare)
      const nestedHome = join(realShare, '.ab')
      await expect(
        setupResponder({ shareDir: linkedShare, repoDir, profileHome: nestedHome, identityHome, run: runner, out: memoryOutput() }),
      ).rejects.toThrow(/--profile/)
    })

    it('still allows a --profile that merely sits next to --share, not inside it', async () => {
      const siblingHome = join(root, 'responder-sibling')
      await expect(
        setupResponder({ shareDir, repoDir, profileHome: siblingHome, identityHome, run: runner, out: memoryOutput() }),
      ).resolves.toBeDefined()
    })

    // Round 2 review: the guard must judge --profile the exact same way the rest of this function
    // actually resolves it (plain resolve(), no `~` expansion — a shell normally expands `~`
    // itself before argv reaches this process, and nothing here has ever tried to do that
    // expansion again). An earlier version of the guard's helper DID expand `~` to the real
    // home directory, while the actual directory creation below still used plain resolve() —
    // so from a cwd inside the share, a quoted `--profile '~/ab-responder'` had the guard compare
    // an outside path (the real $HOME) while the code went on to actually create
    // settings.json/start.sh/claude/ under a literal "~" folder INSIDE the share, and doctor
    // would then report the setup as fine. If the two sides ever diverge like that again, this
    // either resolves (should have refused) or leaves the literal "~" folder on disk.
    it('refuses a ~-spelled --profile from a cwd inside the share, matching how it is actually resolved on disk', async () => {
      const cwdBefore = process.cwd()
      await mkdir(shareDir, { recursive: true })
      process.chdir(shareDir)
      try {
        await expect(
          setupResponder({ shareDir, repoDir, profileHome: '~/ab-responder', identityHome, run: runner, out: memoryOutput() }),
        ).rejects.toThrow(/--profile/)
        await expect(access(join(shareDir, '~'))).rejects.toThrow()
      } finally {
        process.chdir(cwdBefore)
      }
    })
  })

  it('quotes a profile path with a space so the printed commands still run', async () => {
    const out = memoryOutput()
    const spaced = join(root, 'mi respondedor')
    await setupResponder({ shareDir, repoDir, profileHome: spaced, identityHome, run: runner, out })
    const printed = out.lines.join('\n')
    expect(printed).toContain(`'${join(spaced, 'start.sh')}'`)
  })

  it("quotes a profile path with an apostrophe so the printed commands still run", async () => {
    const out = memoryOutput()
    const withApostrophe = join(root, "o'brien")
    await setupResponder({ shareDir, repoDir, profileHome: withApostrophe, identityHome, run: runner, out })
    const printed = out.lines.join('\n')
    const escapedStartScript = join(withApostrophe, 'start.sh').replaceAll("'", `'\\''`)
    expect(printed).toContain(`'${escapedStartScript}'`)
  })
})

describe('start.sh points at the single identity, not at the dedicated profile', () => {
  it("exports AGENTBRIDGE_HOME pointing at the identity home", () => {
    const script = startScript({ shareDir: '/tmp/compartido', profileHome: '/tmp/perfil', identityHome: '/tmp/identidad', model: 'sonnet', effort: 'low' })
    expect(script).toContain("export AGENTBRIDGE_HOME='/tmp/identidad'")
    // The dedicated profile is Claude's, never AgentBridge's: a session pointed at it would get
    // its own key, its own contacts and its own database, so the inbox commands (requests,
    // approve, reject, revoke) would read a different store than the channel writes.
    expect(script).not.toContain("export AGENTBRIDGE_HOME='/tmp/perfil'")
  })

  it("keeps Claude's own profile in the dedicated folder", () => {
    const script = startScript({ shareDir: '/tmp/compartido', profileHome: '/tmp/perfil', identityHome: '/tmp/identidad', model: 'sonnet', effort: 'low' })
    expect(script).toContain("export CLAUDE_CONFIG_DIR='/tmp/perfil/claude'")
    expect(script).toContain("--settings '/tmp/perfil/settings.json'")
  })
})

describe('setupResponder guards both folders against the shared one', () => {
  it('refuses a profile folder inside the shared folder', async () => {
    const out = memoryOutput()
    const err = await setupResponder({
      shareDir,
      repoDir,
      profileHome: join(shareDir, 'perfil'),
      identityHome,
      run: runner,
      out,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).message).toContain('--profile')
  })

  it('refuses an identity folder inside the shared folder, where the secret key would be readable', async () => {
    const out = memoryOutput()
    // The worse of the two: identity.json holds the secret key itself, and
    // blockReadsOutsideWorkingDirectories only fences reads to the shared folder — anything
    // inside it is fair game for a crafted question.
    const err = await setupResponder({
      shareDir,
      repoDir,
      profileHome: home,
      identityHome: join(shareDir, 'identidad'),
      run: runner,
      out,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).message).toMatch(/tu llave/i)
  })

  it('prepares the profile when both folders are outside the shared one', async () => {
    const out = memoryOutput()
    const result = await setupResponder({ shareDir, repoDir, profileHome: home, identityHome, run: runner, out })
    expect(result.startScriptPath).toBe(join(home, 'start.sh'))
    const script = await readFile(result.startScriptPath, 'utf8')
    expect(script).toContain(`export AGENTBRIDGE_HOME='${identityHome}'`)
    // Nothing of AgentBridge's own state is created in the profile: no key, no database.
    await expect(access(join(home, 'identity.json'))).rejects.toThrow()
    await expect(access(join(home, 'agentbridge.db'))).rejects.toThrow()
  })
})

describe('setupResponderCommand', () => {
  // Deliberately not calling the command with a valid --share: it hardcodes defaultRunner, so it
  // would spawn the real `claude` binary against a fixture that only holds a stub bundle. The
  // usage message is reachable without any of that, and it is the part this task changes.
  it('names --profile in its usage message, not --home', async () => {
    const out = memoryOutput()
    const err = await setupResponderCommand([], { home: identityHome, out, env: process.env } as never).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).message).toContain('--profile')
    expect((err as CliError).message).not.toContain('--home')
  })
})

// --repo resolution: setupResponderCommand's default must find plugins/agentbridge/dist/server.js
// from wherever the running bundle actually is, in both real layouts — a from-source checkout
// (packages/cli/dist/main.js, three levels below the repo root) and an installed npm package
// (bin/agentbridge.js, scripts/pack.mjs's own layout, two levels below the package root) —
// rather than assuming either fixed depth, which is exactly what a reviewer flagged in the
// previous fixed `'../../..'` version.
describe('findPluginRoot', () => {
  it('resolves the from-source layout: packages/cli/dist/main.js is three levels below the repo root', async () => {
    const devDist = join(repoDir, 'packages/cli/dist')
    await mkdir(devDist, { recursive: true })
    await expect(findPluginRoot(devDist)).resolves.toBe(repoDir)
  })

  it('resolves the installed-package layout: bin/agentbridge.js is two levels below the package root', async () => {
    const pkgRoot = join(root, 'installed', 'node_modules', 'agentbridge')
    await mkdir(join(pkgRoot, 'plugins/agentbridge/dist'), { recursive: true })
    await writeFile(join(pkgRoot, 'plugins/agentbridge/dist/server.js'), '// bundle')
    const bin = join(pkgRoot, 'bin')
    await mkdir(bin, { recursive: true })
    await expect(findPluginRoot(bin)).resolves.toBe(pkgRoot)
  })

  it('returns null when no ancestor contains the plugin bundle, instead of walking forever', async () => {
    const nowhere = join(root, 'sin-plugin', 'bin')
    await mkdir(nowhere, { recursive: true })
    await expect(findPluginRoot(nowhere)).resolves.toBeNull()
  })

  it('picks the nearest ancestor when more than one contains a bundle', async () => {
    // An outer directory that also happens to look like a plugin root must not shadow the
    // closer, more specific one — the walk stops at the first match going up.
    const outer = join(root, 'outer')
    await mkdir(join(outer, 'plugins/agentbridge/dist'), { recursive: true })
    await writeFile(join(outer, 'plugins/agentbridge/dist/server.js'), '// outer bundle')
    const innerRepo = join(outer, 'nested', 'repo')
    await mkdir(join(innerRepo, 'plugins/agentbridge/dist'), { recursive: true })
    await writeFile(join(innerRepo, 'plugins/agentbridge/dist/server.js'), '// inner bundle')
    const start = join(innerRepo, 'packages/cli/dist')
    await mkdir(start, { recursive: true })
    await expect(findPluginRoot(start)).resolves.toBe(innerRepo)
  })
})

describe('repoDirFromBundleLocation', () => {
  it('resolves through a file:// URL for the from-source layout', async () => {
    const mainJs = join(repoDir, 'packages/cli/dist/main.js')
    await mkdir(dirname(mainJs), { recursive: true })
    await expect(repoDirFromBundleLocation(pathToFileURL(mainJs).href)).resolves.toBe(repoDir)
  })

  it('resolves through a file:// URL for the installed-package layout', async () => {
    const pkgRoot = join(root, 'installed2')
    await mkdir(join(pkgRoot, 'plugins/agentbridge/dist'), { recursive: true })
    await writeFile(join(pkgRoot, 'plugins/agentbridge/dist/server.js'), '// bundle')
    const binJs = join(pkgRoot, 'bin/agentbridge.js')
    await mkdir(dirname(binJs), { recursive: true })
    await expect(repoDirFromBundleLocation(pathToFileURL(binJs).href)).resolves.toBe(pkgRoot)
  })

  it('throws a Spanish CliError naming the missing bundle, not a crash, when no --repo can be found', async () => {
    const binJs = join(root, 'huerfano', 'bin', 'agentbridge.js')
    await mkdir(dirname(binJs), { recursive: true })
    const err = await repoDirFromBundleLocation(pathToFileURL(binJs).href).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as Error).message).toContain('plugins/agentbridge/dist/server.js')
    expect((err as Error).message).toMatch(/--repo/)
  })
})
