import { writeConfig } from '@agentbridge/core'
import type { FastifyInstance } from 'fastify'
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildListeningApp, enrollViaApi, resetDb, testPool } from '../../../apps/relay/test/helpers'
import { runDoctor, type Check } from '../src/commands/doctor'
import { RESPONDER_DENY, setupResponder, type CommandRunner } from '../src/commands/setup-responder'
import { memoryOutput } from '../src/context'

let pool: pg.Pool
let app: FastifyInstance
let relayUrl: string
let root: string
let home: string
let shareDir: string
let repoDir: string
let deviceToken: string

// runDoctor's default `run` spawns the real `claude` binary (for `claude auth status`), so
// every call in this file must inject one of these instead — tests must never shell out.
const loggedInRun: CommandRunner = async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: '' })
const notLoggedInRun: CommandRunner = async () => ({ code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: '' })
// Mirrors exactly what defaultRunner resolves with when `spawn('claude', ...)` fails (e.g. no
// such binary on PATH): code 127, empty stdout, Node's own English error message in stderr.
const missingClaudeRun: CommandRunner = async () => ({ code: 127, stdout: '', stderr: 'spawn claude ENOENT' })

async function markPluginInstalled(homeDir: string) {
  const pluginsDir = join(homeDir, 'claude', 'plugins')
  await mkdir(pluginsDir, { recursive: true })
  await writeFile(
    join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'agentbridge@agentbridge-local': [{ scope: 'user', version: '0.1.0' }] } }),
  )
}

// A doctor failure must never echo file contents (the device token most of all — this is
// text people are told to paste into a chat when asking for help).
function assertNoTokenLeak(checks: Check[]) {
  expect(JSON.stringify(checks)).not.toContain(deviceToken)
}

beforeAll(async () => {
  pool = await testPool()
})
beforeEach(async () => {
  await resetDb(pool)
  ;({ app, relayUrl } = await buildListeningApp(pool))
  root = await mkdtemp(join(tmpdir(), 'ab-doctor-'))
  home = join(root, 'responder')
  shareDir = join(root, 'compartido')
  repoDir = join(root, 'repo')
  await mkdir(join(repoDir, 'plugins/agentbridge/dist'), { recursive: true })
  await writeFile(join(repoDir, 'plugins/agentbridge/dist/server.js'), '// bundle')
  await setupResponder({ shareDir, repoDir, home, run: async () => ({ code: 0, stdout: '', stderr: '' }), out: memoryOutput() })
  await markPluginInstalled(home)
  deviceToken = await enrollViaApi(app, 'dev', 'Dev')
  await writeConfig({ relayUrl, deviceToken, handle: 'dev', displayName: 'Dev' }, home)
})
afterEach(async () => {
  await app.close()
})
afterAll(async () => {
  await pool.end()
})

const failing = (checks: { name: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.name)

describe('runDoctor', () => {
  it('passes every check on a correct responder setup', async () => {
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    expect(failing(checks)).toEqual([])
    expect(checks.length).toBeGreaterThanOrEqual(11)
    assertNoTokenLeak(checks)
  })

  it('detects a symlink that escapes the shared folder', async () => {
    await symlink('/etc', join(shareDir, 'escape'))
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    expect(failing(checks)).toEqual(['Sin enlaces que salgan de la carpeta'])
    assertNoTokenLeak(checks)
  })

  it('does not flag a dangling symlink that points inside the shared folder', async () => {
    await symlink(join(shareDir, 'not-created-yet.txt'), join(shareDir, 'pending'))
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    expect(failing(checks)).toEqual([])
    assertNoTokenLeak(checks)
  })

  // Round 3 review: walkShareDir feeds every dangling symlink it finds into resolveNonExisting
  // (doctor.ts's escaping-symlink check above this one), and a symlink CYCLE inside the shared
  // folder — a self-reference, or a -> b -> a — used to make that call recurse forever: measured
  // at 180s with zero checks printed against the pre-cap code. The shared folder receives
  // content from sync clients and `git pull` (docs/runbooks/m1-acceptance.md §0.1), so one
  // broken or malicious symlink landing there must not silently disable doctor entirely — the
  // operator's only tool for confirming the token is actually outside the fence. A real
  // wall-clock bound, not a reliance on vitest's own test timeout, so a regression here fails
  // this assertion outright instead of an ambiguous suite-level timeout.
  const CYCLE_TIME_BOUND_MS = 5000

  it('finishes in bounded time instead of hanging when a self-referential symlink sits in the shared folder', async () => {
    const cyclePath = join(shareDir, 'cycle')
    await symlink(cyclePath, cyclePath)
    const start = Date.now()
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    expect(Date.now() - start).toBeLessThan(CYCLE_TIME_BOUND_MS)
    expect(checks.length).toBeGreaterThan(0)
    assertNoTokenLeak(checks)
  })

  it('reports, without crashing, a subdirectory it has no permission to read', async () => {
    const locked = join(shareDir, 'locked')
    await mkdir(locked)
    await writeFile(join(locked, 'secret.txt'), 'x')
    await chmod(locked, 0o000)
    try {
      const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
      expect(failing(checks)).toEqual(['Sin enlaces que salgan de la carpeta'])
      const check = checks.find((c) => c.name === 'Sin enlaces que salgan de la carpeta')!
      expect(check.detail).toContain(locked)
      assertNoTokenLeak(checks)
    } finally {
      await chmod(locked, 0o755)
    }
  })

  it('fails the symlink check instead of silently passing when the shared folder cannot be walked at all', async () => {
    const missingShare = join(root, 'no-such-share')
    const checks = await runDoctor({ home, shareDir: missingShare, repoDir, run: loggedInRun })
    const names = failing(checks)
    expect(names).toContain('Carpeta compartida')
    expect(names).toContain('Sin enlaces que salgan de la carpeta')
    assertNoTokenLeak(checks)
  })

  it('names .git and node_modules instead of claiming a clean sweep when they were skipped', async () => {
    await mkdir(join(shareDir, '.git'), { recursive: true })
    await writeFile(join(shareDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    const check = checks.find((c) => c.name === 'Sin enlaces que salgan de la carpeta')!
    expect(check.ok).toBe(true)
    expect(check.detail).toContain('.git')
    assertNoTokenLeak(checks)
  })

  it('detects a weakened settings file', async () => {
    await writeFile(join(home, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'], deny: [] } }))
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    expect(failing(checks)).toEqual(['Permisos del respondedor'])
    assertNoTokenLeak(checks)
  })

  it('reports a corrupted settings.json distinctly from a missing one', async () => {
    await writeFile(join(home, 'settings.json'), '{ esto no es json')
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    const check = checks.find((c) => c.name === 'Permisos del respondedor')!
    expect(check.ok).toBe(false)
    expect(check.detail).toContain('no es JSON válido')
    expect(check.detail).not.toContain('no existe')
    assertNoTokenLeak(checks)
  })

  it('derives the permissions detail text from what settings.json actually contains, not a fixed sentence', async () => {
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    const check = checks.find((c) => c.name === 'Permisos del respondedor')!
    expect(check.ok).toBe(true)
    for (const rule of RESPONDER_DENY) expect(check.detail).toContain(rule)
  })

  it('fails the permissions and start-script checks even when --share is not given, because they live under home', async () => {
    const bareHome = join(root, 'bare-home')
    await mkdir(bareHome, { recursive: true })
    // Reuses the same enrolled `deviceToken` as the primary `home` (rather than enrolling a
    // second device under its own token) so assertNoTokenLeak below is checking the actual
    // token this test's config.json holds, not a different one nobody looked for.
    await writeConfig({ relayUrl, deviceToken, handle: 'dev', displayName: 'Dev' }, bareHome)
    const checks = await runDoctor({ home: bareHome, run: loggedInRun })
    const names = failing(checks)
    expect(names).toContain('Permisos del respondedor')
    expect(names).toContain('Script de arranque')
    expect(checks.some((c) => c.name === 'Alta del dispositivo' && c.ok)).toBe(true)
    const permCheck = checks.find((c) => c.name === 'Permisos del respondedor')!
    expect(permCheck.detail).toContain('no existe')
    assertNoTokenLeak(checks)
  })

  it('detects a revoked device credential', async () => {
    await pool.query('update devices set revoked_at = now()')
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    expect(failing(checks)).toEqual(['Credencial válida'])
    assertNoTokenLeak(checks)
  })

  it('reports a corrupted config.json in Spanish without leaking its bytes, instead of crashing', async () => {
    await writeFile(join(home, 'config.json'), `{"deviceToken":"${deviceToken}", esto no es json`)
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    const check = checks.find((c) => c.name === 'Alta del dispositivo')!
    expect(check.ok).toBe(false)
    expect(check.detail).toContain('agentbridge enroll')
    assertNoTokenLeak(checks)
  })

  it('detects that the plugin is not installed in the dedicated profile', async () => {
    await rm(join(home, 'claude', 'plugins', 'installed_plugins.json'))
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    expect(failing(checks)).toEqual(['Plugin instalado en el perfil dedicado'])
    assertNoTokenLeak(checks)
  })

  it('detects that the dedicated profile has not logged in', async () => {
    const checks = await runDoctor({ home, shareDir, repoDir, run: notLoggedInRun })
    expect(failing(checks)).toEqual(['Sesión iniciada en el perfil dedicado'])
    assertNoTokenLeak(checks)
  })

  it('never spawns claude, and reports not logged in, when the dedicated profile does not exist yet', async () => {
    const bareHome = join(root, 'no-claude-dir-yet')
    await mkdir(bareHome, { recursive: true })
    await writeConfig({ relayUrl, deviceToken, handle: 'dev', displayName: 'Dev' }, bareHome)
    // <bareHome>/claude is never created — if runDoctor spawned `claude auth status` against
    // it anyway, the real `claude` binary would create that directory at the default umask,
    // leaving the dedicated profile (and whatever login credential later lands in it) world-
    // readable. This double throws if it is ever called, proving the spawn was skipped.
    const mustNotRun: CommandRunner = async () => {
      throw new Error('should not have spawned claude: the dedicated profile does not exist yet')
    }
    const checks = await runDoctor({ home: bareHome, run: mustNotRun })
    const check = checks.find((c) => c.name === 'Sesión iniciada en el perfil dedicado')!
    expect(check.ok).toBe(false)
    await expect(access(join(bareHome, 'claude'))).rejects.toThrow()
  })

  it('degrades to a Spanish failing check, not a crash, when claude is not on PATH', async () => {
    const checks = await runDoctor({ home, shareDir, repoDir, run: missingClaudeRun })
    expect(failing(checks)).toEqual(['Sesión iniciada en el perfil dedicado'])
    const check = checks.find((c) => c.name === 'Sesión iniciada en el perfil dedicado')!
    // Must say the CLI itself was not found — not the generic "you haven't logged in yet"
    // message, which would be misleading (the profile might well be logged in already; we
    // simply could not ask).
    expect(check.detail).toMatch(/no se encontr.*claude|claude.*no se encontr/i)
    expect(check.detail).not.toMatch(/inicia sesión/i)
    expect(check.detail).not.toContain('ENOENT')
    expect(check.detail).not.toContain('spawn')
    assertNoTokenLeak(checks)
  })

  it('flags a .claude/settings.json dropped into the shared folder', async () => {
    await mkdir(join(shareDir, '.claude'), { recursive: true })
    await writeFile(join(shareDir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }))
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    expect(failing(checks)).toEqual(['Sin configuración de proyecto en la carpeta compartida'])
    assertNoTokenLeak(checks)
  })

  it('flags a .mcp.json dropped into the shared folder', async () => {
    await writeFile(join(shareDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }))
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    expect(failing(checks)).toEqual(['Sin configuración de proyecto en la carpeta compartida'])
    assertNoTokenLeak(checks)
  })

  it('flags .claude/agents dropped into the shared folder', async () => {
    await mkdir(join(shareDir, '.claude', 'agents'), { recursive: true })
    await writeFile(join(shareDir, '.claude', 'agents', 'evil.md'), '---\nname: evil\n---\n')
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    expect(failing(checks)).toEqual(['Sin configuración de proyecto en la carpeta compartida'])
    assertNoTokenLeak(checks)
  })

  // Skill and command frontmatter is injected straight into the session's instructions on
  // startup — nobody has to be tricked into reading it, and no deny rule can stop text. A
  // `.claude/agents` check that ignores its sibling `.claude/skills` and `.claude/commands`
  // directories misses the two most dangerous auto-load surfaces of the three.
  it('flags .claude/skills dropped into the shared folder', async () => {
    await mkdir(join(shareDir, '.claude', 'skills', 'evil'), { recursive: true })
    await writeFile(join(shareDir, '.claude', 'skills', 'evil', 'SKILL.md'), '---\nname: evil\n---\n')
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    expect(failing(checks)).toEqual(['Sin configuración de proyecto en la carpeta compartida'])
    assertNoTokenLeak(checks)
  })

  it('flags .claude/commands dropped into the shared folder', async () => {
    await mkdir(join(shareDir, '.claude', 'commands'), { recursive: true })
    await writeFile(join(shareDir, '.claude', 'commands', 'evil.md'), '---\nname: evil\n---\n')
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    expect(failing(checks)).toEqual(['Sin configuración de proyecto en la carpeta compartida'])
    assertNoTokenLeak(checks)
  })

  it('flags a CLAUDE.local.md dropped into the shared folder', async () => {
    await writeFile(join(shareDir, 'CLAUDE.local.md'), '# reglas locales')
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    expect(failing(checks)).toEqual(['Sin configuración de proyecto en la carpeta compartida'])
    assertNoTokenLeak(checks)
  })

  it('flags an AGENTS.md dropped into the shared folder', async () => {
    await writeFile(join(shareDir, 'AGENTS.md'), '# instrucciones')
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    expect(failing(checks)).toEqual(['Sin configuración de proyecto en la carpeta compartida'])
    assertNoTokenLeak(checks)
  })

  // Round 2 review (wording nit): the failing detail must say what is actually true of each
  // kind of artifact it found, not one blanket sentence for all of them. .mcp.json can point
  // Claude Code at another MCP server (code runs outside the tool permission system); a
  // .claude/skills entry never executes anything — its SKILL.md content is injected straight
  // into the session's instructions on startup. Conflating the two understates exactly the
  // risk that made checking for skills/commands worth doing.
  it('describes an exec/delegation artifact (.mcp.json) as such, not as injected text', async () => {
    await writeFile(join(shareDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }))
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    const check = checks.find((c) => c.name === 'Sin configuración de proyecto en la carpeta compartida')!
    expect(check.ok).toBe(false)
    expect(check.detail).toMatch(/ejecutar código|delegar/i)
    expect(check.detail).not.toMatch(/instrucciones|inyecta/i)
  })

  it('describes a text-injection artifact (.claude/skills) as such, not as able to run code', async () => {
    await mkdir(join(shareDir, '.claude', 'skills', 'evil'), { recursive: true })
    await writeFile(join(shareDir, '.claude', 'skills', 'evil', 'SKILL.md'), '---\nname: evil\n---\n')
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    const check = checks.find((c) => c.name === 'Sin configuración de proyecto en la carpeta compartida')!
    expect(check.ok).toBe(false)
    expect(check.detail).toMatch(/instrucciones|inyecta/i)
    expect(check.detail).not.toMatch(/ejecutar código/i)
  })

  it('describes both kinds when both are present, not just one of them', async () => {
    await writeFile(join(shareDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }))
    await writeFile(join(shareDir, 'AGENTS.md'), '# instrucciones')
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    const check = checks.find((c) => c.name === 'Sin configuración de proyecto en la carpeta compartida')!
    expect(check.ok).toBe(false)
    expect(check.detail).toMatch(/ejecutar código|delegar/i)
    expect(check.detail).toMatch(/instrucciones|inyecta/i)
    expect(check.detail).toContain('.mcp.json')
    expect(check.detail).toContain('AGENTS.md')
  })

  // Outside blockReadsOutsideWorkingDirectories' fence (the session's cwd, --share) and the
  // Read(**/.env*) denies, a --home that is --share or inside it leaves config.json's device
  // token, settings.json and start.sh readable by a crafted question. doctor must report an
  // existing bad setup like this, not silently trust it.
  it('flags a responder home that is the same folder as the shared folder', async () => {
    const badHome = join(root, 'same-as-share')
    await writeConfig({ relayUrl, deviceToken, handle: 'dev', displayName: 'Dev' }, badHome)
    const checks = await runDoctor({ home: badHome, shareDir: badHome, repoDir, run: loggedInRun })
    expect(failing(checks)).toContain('Home del respondedor fuera de la carpeta compartida')
    assertNoTokenLeak(checks)
  })

  it('flags a responder home nested inside the shared folder', async () => {
    const nestedHome = join(shareDir, '.ab')
    await writeConfig({ relayUrl, deviceToken, handle: 'dev', displayName: 'Dev' }, nestedHome)
    const checks = await runDoctor({ home: nestedHome, shareDir, repoDir, run: loggedInRun })
    expect(failing(checks)).toContain('Home del respondedor fuera de la carpeta compartida')
    assertNoTokenLeak(checks)
  })

  it('passes the home-vs-share check on the correct setup, where home lives outside share', async () => {
    const checks = await runDoctor({ home, shareDir, repoDir, run: loggedInRun })
    const check = checks.find((c) => c.name === 'Home del respondedor fuera de la carpeta compartida')!
    expect(check.ok).toBe(true)
    assertNoTokenLeak(checks)
  })

  // Round 2 review: doctor's other checks (settings.json, start.sh, ...) all read `o.home`
  // raw, with plain path joins — never expanding a leading `~`. The home-vs-share guard must
  // resolve `--home` the exact same inert way, or a ~-spelled home that setup-responder
  // actually created inside the share (see the matching test in setup-responder.test.ts) could
  // have this check report it as fine anyway.
  it('does not silently pass a ~-spelled home that resolves inside share the same way the rest of doctor resolves it', async () => {
    const cwdBefore = process.cwd()
    process.chdir(shareDir)
    try {
      const checks = await runDoctor({ home: '~/ab-responder', shareDir, repoDir, run: loggedInRun })
      const check = checks.find((c) => c.name === 'Home del respondedor fuera de la carpeta compartida')!
      expect(check.ok).toBe(false)
    } finally {
      process.chdir(cwdBefore)
    }
  })
})
