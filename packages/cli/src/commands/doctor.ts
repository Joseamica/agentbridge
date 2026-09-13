import type { ClientConfig } from '@agentbridge/core'
import { RelayHttpClient } from '@agentbridge/core'
import { access, constants, lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { CliError, tryReadConfig, type CliContext } from '../context'
import { isSameOrWithin, resolveComparablePath, resolveNonExisting } from '../fs-paths'
import { defaultRunner, REPLY_TOOL_NAME, RESPONDER_DENY, type CommandRunner } from './setup-responder'

export type Check = { name: string; ok: boolean; detail: string }

type WalkResult = { escaping: string[]; unreadable: string[]; skipped: string[] }

// Walks the shared folder looking for symlinks whose real target lands outside it.
// - `.git` and `node_modules` are skipped for size, but named in `skipped` — callers must
//   report them, never claim a clean sweep that quietly didn't look there.
// - A directory we cannot read (e.g. chmod 000) is recorded in `unreadable` rather than
//   thrown, so one locked-down subfolder cannot crash the whole check.
// - A dangling symlink (target does not exist) is resolved against its own literal target
//   text via readlink + the link's own directory, not realpath (which requires the target to
//   exist) — so a broken-but-internal link is not misreported as an escape.
async function walkShareDir(dir: string, rootReal: string, result: WalkResult): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    result.unreadable.push(dir)
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(path)
    } catch {
      result.unreadable.push(path)
      continue
    }
    if (info.isSymbolicLink()) {
      const target = await realpath(path).catch(() => null)
      if (target) {
        if (target !== rootReal && !target.startsWith(rootReal + sep)) result.escaping.push(path)
        continue
      }
      const raw = await readlink(path).catch(() => null)
      if (raw === null) {
        result.unreadable.push(path)
        continue
      }
      const effectiveTarget = await resolveNonExisting(resolve(dirname(path), raw))
      if (effectiveTarget !== rootReal && !effectiveTarget.startsWith(rootReal + sep)) result.escaping.push(path)
    } else if (info.isDirectory()) {
      if (entry === '.git' || entry === 'node_modules') {
        result.skipped.push(path)
      } else {
        await walkShareDir(path, rootReal, result)
      }
    }
  }
}

const PROJECT_CONFIG_CANDIDATES = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.mcp.json',
  'CLAUDE.local.md',
  'AGENTS.md',
]

// Directories rather than single files: what matters is whether they contain anything, not
// whether the directory itself exists (an empty `.claude/agents` left behind by some other
// tool is not a threat).
const PROJECT_CONFIG_DIRS = ['.claude/agents', '.claude/skills', '.claude/commands']

// The unattended session's cwd IS the shared folder, so Claude Code picks up any project
// configuration it finds there — .claude/settings*.json hooks run shell commands entirely
// outside the tool permission system, .mcp.json can point at another MCP server,
// .claude/agents/* can define subagents, CLAUDE.local.md and AGENTS.md are auto-loaded
// instructions same as CLAUDE.md, and .claude/skills/*/SKILL.md and .claude/commands/*.md have
// their frontmatter injected straight into the session's instructions on startup. That last
// pair is the most dangerous of the lot: nobody has to be talked into reading anything, and no
// deny rule can stop text — "trust the concrete check, not the prose" only holds if the check
// actually looks. None of this has to come from the responder: a sync client or a `git pull`
// landing files in the shared folder is enough. Treat any of it as a real failure, not a note.
//
// Two genuinely different things happen depending on which of these turns up, and the failing
// check's detail below must say which: settings.json/settings.local.json (hooks) and .mcp.json
// (another MCP server) and .claude/agents (subagents) all run code, or hand control to
// something else, outside the tool permission system. The other four — CLAUDE.local.md,
// AGENTS.md, .claude/skills, .claude/commands — never execute anything at all; their TEXT is
// injected straight into the session's instructions on startup, and no deny rule can stop
// text. Describing that second group as "can run code" would be simply wrong, and would
// understate exactly the risk that made checking for them worth doing in the first place.
const PROJECT_CONFIG_EXEC_RISK = new Set(['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.claude/agents'])

async function projectConfigArtifacts(shareDir: string): Promise<string[]> {
  const found: string[] = []
  for (const rel of PROJECT_CONFIG_CANDIDATES) {
    const present = await access(join(shareDir, rel))
      .then(() => true)
      .catch(() => false)
    if (present) found.push(rel)
  }
  for (const rel of PROJECT_CONFIG_DIRS) {
    const entries = await readdir(join(shareDir, rel)).catch(() => [] as string[])
    if (entries.length > 0) found.push(rel)
  }
  return found
}

export async function runDoctor(o: {
  home: string
  shareDir?: string
  repoDir?: string
  fetchImpl?: typeof fetch
  run?: CommandRunner
}): Promise<Check[]> {
  const checks: Check[] = []
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })
  const run = o.run ?? defaultRunner

  // tryReadConfig turns a missing file into null but a *corrupt* one into a Spanish CliError
  // that never echoes the file's bytes — a raw readConfig() here would otherwise let a
  // damaged config.json's own SyntaxError (which can include the first bytes of the file,
  // i.e. part of the device token) reach the exact text people are told to paste into a chat.
  let config: ClientConfig | null = null
  try {
    config = await tryReadConfig({ home: o.home })
    add('Alta del dispositivo', !!config, config ? `@${config.handle} en ${config.relayUrl}` : `No hay credencial en ${o.home}`)
  } catch (err) {
    add('Alta del dispositivo', false, err instanceof CliError ? err.message : `No se pudo leer la configuración en ${o.home}`)
  }
  if (config) {
    const client = new RelayHttpClient({ relayUrl: config.relayUrl, token: config.deviceToken, fetchImpl: o.fetchImpl })
    const healthy = await client.health()
    add('Relay accesible', healthy, healthy ? config.relayUrl : `No responde ${config.relayUrl}/health`)
    const me = await client.me().catch(() => null)
    add('Credencial válida', !!me, me ? `@${me.handle}` : 'El relay rechazó la credencial (revocada o inválida)')
  }

  // Everything below lives under `home`, independent of whether a shared folder was given —
  // a home with no settings.json (or a weakened one) must fail loudly even when doctor is run
  // with only --home.
  type SettingsFile = {
    permissions?: { allow?: string[]; deny?: string[]; blockReadsOutsideWorkingDirectories?: boolean }
  }
  const settingsPath = join(o.home, 'settings.json')
  let settings: SettingsFile | null = null
  // Missing and corrupt are different problems — "you never ran setup-responder" vs. "someone
  // hand-edited this and broke the JSON" — and deserve different Spanish messages, not the
  // same "no existe" for both.
  let settingsProblem: string | null = null
  try {
    const text = await readFile(settingsPath, 'utf8')
    try {
      settings = JSON.parse(text) as SettingsFile
    } catch {
      settingsProblem = `${settingsPath} existe pero no es JSON válido`
    }
  } catch (err) {
    settingsProblem =
      (err as NodeJS.ErrnoException).code === 'ENOENT' ? `no existe ${settingsPath}` : `no se pudo leer ${settingsPath}`
  }
  const allow = settings?.permissions?.allow ?? []
  const deny = settings?.permissions?.deny ?? []
  const missingDeny = RESPONDER_DENY.filter((rule) => !deny.includes(rule))
  const extraAllow = allow.filter((rule) => rule !== REPLY_TOOL_NAME)
  // Claude Code reads this key nested inside `permissions`, not as a sibling of it — see the
  // comment on responderSettings() in setup-responder.ts. Reading it from the wrong place here
  // would report a genuinely unfenced responder as fine.
  const fenced = settings?.permissions?.blockReadsOutsideWorkingDirectories === true
  const permissionProblems: string[] = []
  if (settingsProblem) {
    permissionProblems.push(settingsProblem)
  } else {
    if (missingDeny.length) permissionProblems.push(`faltan denegaciones: ${missingDeny.join(', ')}`)
    if (extraAllow.length) permissionProblems.push(`permisos de más: ${extraAllow.join(', ')}`)
    if (!fenced) permissionProblems.push('permissions.blockReadsOutsideWorkingDirectories no está en true')
  }
  add(
    'Permisos del respondedor',
    permissionProblems.length === 0,
    permissionProblems.length
      ? permissionProblems.join(' · ')
      : `Deniega ${deny.join(', ')}; permite solo ${allow.join(', ') || 'nada'}; lecturas limitadas a la carpeta de trabajo`,
  )

  const startPath = join(o.home, 'start.sh')
  const executable = await access(startPath, constants.X_OK)
    .then(() => true)
    .catch(() => false)
  add('Script de arranque', executable, executable ? startPath : `No existe o no es ejecutable: ${startPath}`)

  const claudeConfigDir = join(o.home, 'claude')
  const installedPath = join(claudeConfigDir, 'plugins', 'installed_plugins.json')
  const installed = await readFile(installedPath, 'utf8')
    .then((t) => JSON.parse(t) as { plugins?: Record<string, unknown[]> })
    .catch(() => null)
  const pluginEntries = installed?.plugins?.['agentbridge@agentbridge-local']
  const pluginInstalled = Array.isArray(pluginEntries) && pluginEntries.length > 0
  add(
    'Plugin instalado en el perfil dedicado',
    pluginInstalled,
    pluginInstalled ? installedPath : `agentbridge@agentbridge-local no aparece instalado en ${installedPath}`,
  )

  let loggedIn = false
  let authDetail: string
  const claudeConfigDirExists = await access(claudeConfigDir)
    .then(() => true)
    .catch(() => false)
  if (!claudeConfigDirExists) {
    // Never spawn `claude` against a CLAUDE_CONFIG_DIR that does not exist yet: the real CLI
    // creates it on the way in, at the process's default umask rather than the 0700 setup-
    // responder uses — and ensureOwnedDir in setup-responder.ts deliberately refuses to
    // re-chmod a directory it did not create, so that would leave the dedicated profile (and
    // whatever login credential later lands in it) world-readable with no way to repair it
    // short of deleting and re-running setup. A missing profile is itself the answer here.
    authDetail = `Aún no existe el perfil dedicado (${claudeConfigDir}); no se ha iniciado sesión.`
  } else {
    const authEnv = { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir }
    // defaultRunner resolves (never rejects) with code 127 when `spawn('claude', ...)` itself
    // fails (binary missing, not executable, etc.) — its stderr is Node's own English message
    // (e.g. "spawn claude ENOENT"). The `.catch` below only exists for a custom CommandRunner
    // that rejects instead; it is coerced into the same 127 shape so both paths are handled
    // identically, in Spanish, as a failing check rather than a crash or a silent pass.
    const authResult = await run('claude', ['auth', 'status', '--json'], { env: authEnv }).catch(
      (err): { code: number; stdout: string; stderr: string } => ({
        code: 127,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      }),
    )
    if (authResult.code === 127) {
      authDetail = 'No se encontró (o no se pudo ejecutar) el comando "claude". Instala Claude Code o revisa que esté en tu PATH.'
    } else {
      try {
        loggedIn = (JSON.parse(authResult.stdout) as { loggedIn?: boolean }).loggedIn === true
      } catch {
        loggedIn = false
      }
      authDetail = loggedIn ? 'Sesión activa' : `Inicia sesión una vez: CLAUDE_CONFIG_DIR='${claudeConfigDir}' claude   (usa /login y sal)`
    }
  }
  add('Sesión iniciada en el perfil dedicado', loggedIn, authDetail)

  if (o.shareDir) {
    const shareDir = resolve(o.shareDir)
    const persona = await access(join(shareDir, 'CLAUDE.md'))
      .then(() => true)
      .catch(() => false)
    add('Carpeta compartida', persona, persona ? shareDir : `Falta ${join(shareDir, 'CLAUDE.md')}`)

    // Walk regardless of whether the persona file is there — a shared folder missing
    // CLAUDE.md can still contain files (and escaping symlinks); "no persona" is not the
    // same question as "any links escape", and skipping this while still reporting 'Ninguno'
    // would claim a clean sweep that never happened. walkShareDir itself turns a missing or
    // unreadable shareDir into an `unreadable` entry rather than throwing.
    const rootReal = await realpath(shareDir).catch(() => shareDir)
    const walk: WalkResult = { escaping: [], unreadable: [], skipped: [] }
    await walkShareDir(shareDir, rootReal, walk)
    const linksOk = walk.escaping.length === 0 && walk.unreadable.length === 0
    const linkBits: string[] = []
    if (walk.escaping.length) linkBits.push(`enlaces hacia fuera: ${walk.escaping.join(', ')}`)
    if (walk.unreadable.length) linkBits.push(`no se pudo revisar (sin permiso de lectura): ${walk.unreadable.join(', ')}`)
    if (walk.skipped.length) linkBits.push(`no se revisó dentro de: ${walk.skipped.join(', ')}`)
    add('Sin enlaces que salgan de la carpeta', linksOk, linkBits.length ? linkBits.join(' · ') : 'Ninguno')

    const projectConfig = await projectConfigArtifacts(shareDir)
    const execRisk = projectConfig.filter((rel) => PROJECT_CONFIG_EXEC_RISK.has(rel))
    const textInjection = projectConfig.filter((rel) => !PROJECT_CONFIG_EXEC_RISK.has(rel))
    const projectConfigBits: string[] = []
    if (execRisk.length) projectConfigBits.push(`puede ejecutar código o delegar a otro servidor fuera del control de permisos: ${execRisk.join(', ')}`)
    if (textInjection.length) {
      projectConfigBits.push(`se inyecta como instrucciones del agente al arrancar, sin que nadie tenga que leerlo ni pedirlo: ${textInjection.join(', ')}`)
    }
    add(
      'Sin configuración de proyecto en la carpeta compartida',
      projectConfig.length === 0,
      projectConfigBits.length ? `Encontrado — ${projectConfigBits.join(' · ')}` : 'Ninguna',
    )

    // `blockReadsOutsideWorkingDirectories` fences reads to the session's cwd — which IS
    // shareDir — and the two Read(**/.env*) denies only cover shareDir too. If `--home` (where
    // config.json's device token, settings.json and start.sh live) is the same folder as
    // --share, or anywhere underneath it, none of that protects those files: they simply sit
    // inside the fence instead of outside it, readable by any crafted question. Compare
    // resolved paths (not the raw strings) so a relative path, `~`, a trailing slash, a
    // symlink, or macOS's /tmp -> /private/tmp cannot hide an unsafe --home behind a
    // differently-spelled but identical location.
    const homeReal = await resolveComparablePath(o.home)
    const shareReal = await resolveComparablePath(o.shareDir)
    const homeOutsideShare = !isSameOrWithin(homeReal, shareReal)
    add(
      'Home del respondedor fuera de la carpeta compartida',
      homeOutsideShare,
      homeOutsideShare
        ? `${o.home} está fuera de ${shareDir}`
        : `--home (${o.home}) es la misma carpeta que --share o está dentro de ella (${shareDir}): la sesión puede leer ahí el token del dispositivo, settings.json y start.sh — permissions.blockReadsOutsideWorkingDirectories y las reglas Read(**/.env*) no protegen nada dentro de la carpeta compartida. Usa una carpeta --home distinta, fuera de --share.`,
    )
  }

  if (o.repoDir) {
    const bundle = join(resolve(o.repoDir), 'plugins/agentbridge/dist/server.js')
    const built = await access(bundle)
      .then(() => true)
      .catch(() => false)
    add('Plugin compilado', built, built ? bundle : `Falta ${bundle}; ejecuta npm run build`)
  }

  return checks
}

export async function doctorCommand(argv: string[], ctx: CliContext): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { home: { type: 'string' }, share: { type: 'string' }, repo: { type: 'string' } } })
  const checks = await runDoctor({ home: values.home ?? ctx.home, shareDir: values.share, repoDir: values.repo, fetchImpl: ctx.fetchImpl })
  for (const c of checks) ctx.out.log(`${c.ok ? '[ok]   ' : '[falla]'} ${c.name}: ${c.detail}`)
  const failed = checks.filter((c) => !c.ok).length
  if (failed > 0) throw new CliError(`${failed} verificación(es) fallaron.`)
  ctx.out.log('Todo en orden.')
}
