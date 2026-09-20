import {
  BoardPool,
  CLI_COMMAND,
  createRumor,
  describeError,
  ephemeralIdentity,
  getChannelLock,
  getProfile,
  listPendingRequests,
  loadIdentity,
  NOSTR,
  openStore,
  wrapRumor,
  type Identity,
  type RelayPolicy,
  type SocketFactory,
  type Store,
} from '@agentbridge/core'
import { randomUUID } from 'node:crypto'
import { access, constants, lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { CliError, type CliContext } from '../context'
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

// Exported so `setup` can reuse this exact detection when deciding whether a chosen shared
// folder already looks like a project directory, instead of hand-rolling a second list of
// artifact names that could drift from the one doctor actually checks.
export async function projectConfigArtifacts(shareDir: string): Promise<string[]> {
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

// The key is the whole identity: whoever reads identity.json can be this person on every board,
// forever, and nothing can be revoked afterwards. Hence three questions, not one: is it there, is
// it 0600, and is the file itself — following any symlink — outside the shared folder. Checking
// only the folder would pass a home whose identity.json is a symlink into the shared folder, which
// is the arrangement someone would most plausibly believe is safe.
async function identityCheck(o: { identityHome: string; shareDir?: string }): Promise<{ check: Check; identity: Identity | null }> {
  const file = join(o.identityHome, 'identity.json')
  let identity: Identity | null = null
  try {
    identity = await loadIdentity(o.identityHome)
  } catch (err) {
    return { check: { name: 'Llave de AgentBridge', ok: false, detail: `No se pudo leer la identidad: ${describeError(err)}` }, identity: null }
  }
  if (!identity) {
    const looksLikeProfile =
      (await access(join(o.identityHome, 'settings.json')).then(() => true, () => false)) &&
      (await access(join(o.identityHome, 'start.sh')).then(() => true, () => false))
    const detail = looksLikeProfile
      ? `Esa carpeta parece el perfil dedicado de Claude, no tu carpeta de identidad: pásala con --profile y deja --home para la que tiene identity.json.`
      : `Todavía no tienes una llave en esta computadora. Créala con: ${CLI_COMMAND} setup`
    // Every remediation line names a command a person can paste, with CLI_COMMAND — never a bare
    // "vuelve a correr setup".
    return { check: { name: 'Llave de AgentBridge', ok: false, detail }, identity: null }
  }

  const problems: string[] = []
  const info = await stat(file).catch(() => null)
  const mode = info ? info.mode & 0o777 : null
  if (mode !== null && mode !== 0o600) problems.push(`la llave está en ${mode.toString(8)} y debe estar en 0600`)
  const homeInfo = await stat(o.identityHome).catch(() => null)
  const homeMode = homeInfo ? homeInfo.mode & 0o777 : null
  if (homeMode !== null && homeMode !== 0o700) problems.push(`su carpeta está en ${homeMode.toString(8)} y debe estar en 0700`)
  if (o.shareDir) {
    const [keyReal, shareReal] = await Promise.all([
      // The FILE, not the folder: `realpath` follows the symlink `loadIdentity` itself follows.
      realpath(file).catch(() => file),
      resolveComparablePath(o.shareDir),
    ])
    if (isSameOrWithin(keyReal, shareReal)) {
      problems.push('tu llave está dentro de la carpeta compartida, donde cualquier pregunta puede leerla: muévela fuera y vuelve a correr setup')
    }
  }
  return {
    // Only claims what was actually checked: an ordinary `doctor` run has no --share, so saying
    // "outside the shared folder" there would be a verdict nobody reached.
    check: {
      name: 'Llave de AgentBridge',
      ok: problems.length === 0,
      detail: problems.length
        ? problems.join(' · ')
        : o.shareDir
          ? 'presente, en 0600, y fuera de la carpeta compartida'
          : 'presente y en 0600 (para revisar que esté fuera de la carpeta compartida, corre doctor con --share)',
    },
    identity,
  }
}

// Never creates anything: a mistyped --home must not leave a folder and an empty database behind,
// and openStore() would create both.
async function storeCheck(o: { identityHome: string; relayPolicy?: RelayPolicy }): Promise<{ check: Check; store: Store | null }> {
  const file = join(o.identityHome, 'agentbridge.db')
  if (!(await access(file).then(() => true, () => false))) {
    return {
      check: { name: 'Base de datos', ok: false, detail: `Todavía no existe. Se crea la primera vez que corres: ${CLI_COMMAND} setup` },
      store: null,
    }
  }
  try {
    const store = await openStore(o.identityHome, o.relayPolicy ? { relayPolicy: o.relayPolicy } : {})
    return { check: { name: 'Base de datos', ok: true, detail: 'abre y responde' }, store }
  } catch (err) {
    return { check: { name: 'Base de datos', ok: false, detail: `No se pudo abrir: ${describeError(err)}` }, store: null }
  }
}

// Publishing and reading are two different permissions on a public board, and a board that accepts
// the connection can still refuse either — or accept an event and never serve it again. The probe
// is a sealed envelope addressed to a throwaway key, so it is not addressed to this person, none of
// their subscriptions fetch it, and nobody can ever decrypt it.
export async function probeBoard(o: {
  relay: string
  identity: Identity
  pool: BoardPool
  now: number
  timeoutMs: number
  miningMs: number
}): Promise<{ ok: boolean; detail: string }> {
  const recipient = ephemeralIdentity()
  let wrap
  try {
    const rumor = createRumor({ v: 1, type: 'receipt', questionId: randomUUID() }, o.identity, o.now)
    // Mining is CPU, not network, so it gets its own budget — without one, a machine under load
    // could leave `doctor` searching for a nonce long after its network deadline passed.
    wrap = await wrapRumor(rumor, o.identity, recipient.publicKey, { now: o.now, signal: AbortSignal.timeout(o.miningMs) })
  } catch (err) {
    return { ok: false, detail: `no pude preparar la prueba: ${describeError(err)}` }
  }

  const published = await o.pool.publish([o.relay], wrap)
  if (published.accepted.length === 0) {
    // The relay's own words are third-party text and are not printed: as a category, the person's
    // next step is the same either way.
    return { ok: false, detail: `no aceptó publicar (puede que pida registro o esté bloqueando esta llave). Puedes cambiar tus tableros con: ${CLI_COMMAND} setup --relays "wss://uno,wss://otro"` }
  }

  // Read it back by the recipient tag rather than by id: the production filter type has no `ids`
  // field, and adding one to the protocol for a diagnostic would be the tail wagging the dog.
  const read = await o.pool.query(o.relay, { kinds: [wrap.kind], '#p': [recipient.publicKey], limit: 5 }, o.timeoutMs)
  if (!read.complete && read.events.length === 0) return { ok: false, detail: 'aceptó publicar pero no me dejó leer' }
  // Compare the signed fields, not the claimed id: a board can answer with an event that carries
  // the right id and different contents.
  // Every signed field, not a sample of four: an id is a claim, and a board that alters the tags,
  // the kind or the date has not returned what was published.
  const signedFields = (e: Record<string, unknown>) =>
    JSON.stringify([e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig])
  const expected = signedFields(wrap as unknown as Record<string, unknown>)
  const found = read.events.some((e) => e !== null && typeof e === 'object' && signedFields(e as Record<string, unknown>) === expected)
  if (!found) return { ok: false, detail: 'aceptó publicar pero no me devolvió lo que publiqué' }
  return { ok: true, detail: 'publicar y leer, los dos' }
}

// A diagnostic that can hang forever is worse than one that says "I could not tell": the person is
// left staring at a command that never returns, with no way to know which check stalled.
async function runBounded(run: CommandRunner, command: string, args: string[], opts: { env: NodeJS.ProcessEnv }, ms: number) {
  return Promise.race([
    run(command, args, opts),
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
      setTimeout(() => resolve({ code: 124, stdout: '', stderr: 'timeout' }), ms).unref(),
    ),
  ])
}

async function addProfileChecks(
  add: (name: string, ok: boolean, detail: string) => void,
  o: { profileHome: string; shareDir?: string; repoDir?: string; run: CommandRunner },
): Promise<void> {
  // Everything below lives under `profileHome`, independent of whether a shared folder was given —
  // a profile with no settings.json (or a weakened one) must fail loudly even when doctor is run
  // with only --profile.
  type SettingsFile = {
    permissions?: { allow?: string[]; deny?: string[]; blockReadsOutsideWorkingDirectories?: boolean }
  }
  const settingsPath = join(o.profileHome, 'settings.json')
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

  const startPath = join(o.profileHome, 'start.sh')
  const executable = await access(startPath, constants.X_OK)
    .then(() => true)
    .catch(() => false)
  add('Script de arranque', executable, executable ? startPath : `No existe o no es ejecutable: ${startPath}`)

  const claudeConfigDir = join(o.profileHome, 'claude')
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
    const authResult = await runBounded(o.run, 'claude', ['auth', 'status', '--json'], { env: authEnv }, 15_000).catch(
      (err): { code: number; stdout: string; stderr: string } => ({
        code: 127,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      }),
    )
    if (authResult.code === 124) {
      authDetail = 'no pude comprobarlo: el comando claude no respondió en 15 segundos'
    } else if (authResult.code === 127) {
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
    // Neither branch names the shared folder or a path inside it — CLAUDE.md is a fixed name
    // this check always looks for, not information about this person's own folder layout.
    add('Carpeta compartida', persona, persona ? 'CLAUDE.md presente' : 'Falta CLAUDE.md en la carpeta compartida')

    // Walk regardless of whether the persona file is there — a shared folder missing
    // CLAUDE.md can still contain files (and escaping symlinks); "no persona" is not the
    // same question as "any links escape", and skipping this while still reporting 'Ninguno'
    // would claim a clean sweep that never happened. walkShareDir itself turns a missing or
    // unreadable shareDir into an `unreadable` entry rather than throwing.
    const rootReal = await realpath(shareDir).catch(() => shareDir)
    const walk: WalkResult = { escaping: [], unreadable: [], skipped: [] }
    await walkShareDir(shareDir, rootReal, walk)
    const linksOk = walk.escaping.length === 0 && walk.unreadable.length === 0
    // The shared folder's own paths never appear in this detail: they name the shared folder's
    // internal layout, which no doctor line may print. Say how many and of what kind, not which.
    const linkBits: string[] = []
    if (walk.escaping.length) linkBits.push(`${walk.escaping.length} enlace(s) apuntan fuera de la carpeta`)
    if (walk.unreadable.length) linkBits.push(`${walk.unreadable.length} ruta(s) no se pudieron revisar (sin permiso de lectura)`)
    if (walk.skipped.length) linkBits.push(`${walk.skipped.length} carpeta(s) no se revisaron por dentro (.git o node_modules)`)
    add('Sin enlaces que salgan de la carpeta', linksOk, linkBits.length ? linkBits.join(' · ') : 'Ninguno')

    const projectConfig = await projectConfigArtifacts(shareDir)
    const execRisk = projectConfig.filter((rel) => PROJECT_CONFIG_EXEC_RISK.has(rel))
    const textInjection = projectConfig.filter((rel) => !PROJECT_CONFIG_EXEC_RISK.has(rel))
    const projectConfigBits: string[] = []
    if (execRisk.length) projectConfigBits.push(`${execRisk.length} archivo(s)/carpeta(s) que pueden ejecutar código o delegar a otro servidor fuera del control de permisos`)
    if (textInjection.length) {
      projectConfigBits.push(`${textInjection.length} archivo(s)/carpeta(s) que se inyectan como instrucciones del agente al arrancar, sin que nadie tenga que leerlos ni pedirlos`)
    }
    add(
      'Sin configuración de proyecto en la carpeta compartida',
      projectConfig.length === 0,
      projectConfigBits.length ? `Encontrado — ${projectConfigBits.join(' · ')}` : 'Ninguna',
    )

    // `blockReadsOutsideWorkingDirectories` fences reads to the session's cwd — which IS
    // shareDir — and the two Read(**/.env*) denies only cover shareDir too. If `--profile`
    // (where settings.json and start.sh live) is the same folder as --share, or anywhere
    // underneath it, none of that protects those files: they simply sit inside the fence
    // instead of outside it, readable by any crafted question. Compare resolved paths (not the
    // raw strings) so a relative path, `~`, a trailing slash, a symlink, or macOS's
    // /tmp -> /private/tmp cannot hide an unsafe --profile behind a differently-spelled but
    // identical location.
    const profileReal = await resolveComparablePath(o.profileHome)
    const shareReal = await resolveComparablePath(o.shareDir)
    const profileOutsideShare = !isSameOrWithin(profileReal, shareReal)
    add(
      'El perfil dedicado está fuera de la carpeta compartida',
      profileOutsideShare,
      profileOutsideShare
        ? 'sí'
        : `--profile es la misma carpeta que --share o está dentro de ella: la sesión puede leer ahí settings.json y start.sh — permissions.blockReadsOutsideWorkingDirectories y las reglas Read(**/.env*) no protegen nada dentro de la carpeta compartida. Vuelve a correr: ${CLI_COMMAND} setup-responder --share <tu carpeta compartida> --profile <otra carpeta, fuera de ella>`,
    )
  }

  if (o.repoDir) {
    const bundle = join(resolve(o.repoDir), 'plugins/agentbridge/dist/server.js')
    const built = await access(bundle)
      .then(() => true)
      .catch(() => false)
    add('Plugin compilado', built, built ? bundle : `Falta ${bundle}; ejecuta npm run build`)
  }
}

export async function runDoctor(o: {
  identityHome: string
  profileHome?: string
  shareDir?: string
  repoDir?: string
  run?: CommandRunner
  createSocket?: SocketFactory
  relayPolicy?: RelayPolicy
  now?: () => number
  boardTimeoutMs?: number
  miningMs?: number
}): Promise<Check[]> {
  const checks: Check[] = []
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })
  const run = o.run ?? defaultRunner
  const now = o.now ?? (() => Math.floor(Date.now() / 1000))
  const boardTimeoutMs = o.boardTimeoutMs ?? 10_000
  const miningMs = o.miningMs ?? 30_000

  const identityResult = await identityCheck({ identityHome: o.identityHome, shareDir: o.shareDir })
  checks.push(identityResult.check)

  const storeResult = await storeCheck({ identityHome: o.identityHome, relayPolicy: o.relayPolicy })
  checks.push(storeResult.check)
  const store = storeResult.store
  try {
    if (store) {
      const holder = getChannelLock(store)
      add('Candado del canal', true, holder ? `lo tiene el proceso ${holder.pid} (época ${holder.epoch})` : 'libre: ningún canal está despachando ahora mismo')

      // The same expiry boundary `requests` applies, so doctor never announces a request that
      // vanishes the moment the person runs the command it just told them to run. Counting only:
      // it must not clear the notification state, which belongs to whoever actually shows them.
      const fresh = listPendingRequests(store).filter((request) => (request.requestedAt ?? 0) > now() - NOSTR.requestMaxAgeSeconds)
      add('Solicitudes pendientes', true, fresh.length === 0 ? 'ninguna' : `${fresh.length}; míralas con: ${CLI_COMMAND} requests`)

      if (identityResult.identity) {
        const relays = getProfile(store).relays
        const pool = new BoardPool({ identity: identityResult.identity, createSocket: o.createSocket, timeoutMs: boardTimeoutMs })
        try {
          for (const relay of relays) {
            const probe = await probeBoard({ relay, identity: identityResult.identity, pool, now: now(), timeoutMs: boardTimeoutMs, miningMs })
            add(`Tablero ${relay}`, probe.ok, probe.detail)
          }
        } finally {
          // Nothing here may leave a socket open: doctor is a short-lived command and a leaked
          // connection would keep the process alive after the report was printed.
          await pool.close()
        }
      }
    }
  } finally {
    store?.close()
  }

  if (o.profileHome) await addProfileChecks(add, { profileHome: o.profileHome, shareDir: o.shareDir, repoDir: o.repoDir, run })
  return checks
}

export async function doctorCommand(argv: string[], ctx: CliContext): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { home: { type: 'string' }, profile: { type: 'string' }, share: { type: 'string' }, repo: { type: 'string' } },
  })
  const checks = await runDoctor({
    identityHome: values.home ?? ctx.home,
    profileHome: values.profile,
    shareDir: values.share,
    repoDir: values.repo,
    createSocket: ctx.createSocket,
    relayPolicy: ctx.relayPolicy,
  })
  for (const c of checks) ctx.out.log(`${c.ok ? '[ok]   ' : '[falla]'} ${c.name}: ${c.detail}`)
  if (checks.some((c) => !c.ok)) throw new CliError('Hay cosas por arreglar: cada línea que dice [falla] explica qué.')
}
