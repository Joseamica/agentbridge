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
import { access, lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { CliError, type CliContext } from '../context'
import { isSameOrWithin, resolveComparablePath, resolveNonExisting } from '../fs-paths'
import { readResponderConfig, RESPONDER_CONFIG_FILE } from './responder'
import { defaultRunner, inspectResponderSettings, type CommandRunner } from './setup-responder'

export type Check = {
  name: string
  ok: boolean
  detail: string
  // True when this stops the person from answering questions at all. False for something worth
  // knowing that does not stop anything — one board down out of five, a key sitting in a synced
  // folder. `doctor` prints every one either way.
  blocking: boolean
  // True when a FAILURE here is about the safety of the secret key or of the shared folder —
  // whoever could read what, and with what consequences. Independent of `blocking` on purpose:
  // the two most dangerous things this program can report are not blocking at all. A key sitting
  // inside OneDrive is already uploaded, and a key in mode 0666 still works perfectly; neither
  // stops a single question from being answered, and both are exactly what the person installing
  // needs to hear, at the one moment they are still choosing folders. `setup` must never hide
  // these behind `blocking` — it shows `blocking || security` — which is why this is a flag on
  // the check itself rather than a list of names kept somewhere else, where it would drift the
  // first time a check is renamed.
  security: boolean
}

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

// A folder that a sync client uploads on its own. A secret key created inside one is already in
// somebody else's datacenter before anyone thinks to ask. Matched on whole path SEGMENTS, never
// as a substring: a folder called "mi-onedrive-notas" is not OneDrive, and a false alarm about a
// secret key teaches people to ignore the true ones.
const CLOUD_FOLDERS: { label: string; segments: string[] }[] = [
  { label: 'OneDrive', segments: ['onedrive'] },
  { label: 'Dropbox', segments: ['dropbox'] },
  { label: 'Google Drive', segments: ['google drive', 'googledrive', 'my drive'] },
  { label: 'iCloud', segments: ['com~apple~clouddocs'] },
]

export function cloudSyncedPath(path: string): string | null {
  // Both separators, always: this function has to give the same answer about a Windows path when
  // a macOS test asks it, or the Windows behaviour would only ever be exercised on Windows.
  const parts = path.split(/[\\/]+/).map((p) => p.trim().toLowerCase())
  for (const folder of CLOUD_FOLDERS) {
    // Three separators after the name, not just " -": the classic Windows/personal mount is
    // "OneDrive - Contoso" (space-hyphen-space), but since macOS 12.3 the same three clients
    // mount under ~/Library/CloudStorage as "OneDrive-Contoso" (no spaces at all — space would
    // break the macOS filesystem's own folder-picker autocomplete), and Dropbox Business has
    // always used "Dropbox (Company)". All three are real, current folder names for the same
    // syncing clients this check exists to catch — never `${s} -` alone, or the macOS spelling
    // (which is the one macOS users actually have) silently passes with no warning.
    if (parts.some((p) => folder.segments.some((s) => p === s || p.startsWith(`${s} -`) || p.startsWith(`${s}-`) || p.startsWith(`${s} (`))))
      return folder.label
  }
  return null
}

// The key is the whole identity: whoever reads identity.json can be this person on every board,
// forever, and nothing can be revoked afterwards. Hence three questions, not one: is it there, is
// it 0600, and is the file itself — following any symlink — outside the shared folder. Checking
// only the folder would pass a home whose identity.json is a symlink into the shared folder, which
// is the arrangement someone would most plausibly believe is safe.
async function identityCheck(o: {
  identityHome: string
  shareDir?: string
  platform: NodeJS.Platform
}): Promise<{ check: Check; identity: Identity | null }> {
  const file = join(o.identityHome, 'identity.json')
  let identity: Identity | null = null
  try {
    identity = await loadIdentity(o.identityHome)
  } catch (err) {
    return {
      check: { name: 'Llave de AgentBridge', ok: false, blocking: true, security: true, detail: `No se pudo leer la identidad: ${describeError(err)}` },
      identity: null,
    }
  }
  if (!identity) {
    const looksLikeProfile =
      (await access(join(o.identityHome, 'settings.json')).then(() => true, () => false)) &&
      (await access(join(o.identityHome, RESPONDER_CONFIG_FILE)).then(() => true, () => false))
    const detail = looksLikeProfile
      ? `Esa carpeta parece el perfil dedicado de Claude, no tu carpeta de identidad: pásala con --profile y deja --home para la que tiene identity.json.`
      : `Todavía no tienes una llave en esta computadora. Créala con: ${CLI_COMMAND} setup`
    // Every remediation line names a command a person can paste, with CLI_COMMAND — never a bare
    // "vuelve a correr setup".
    return { check: { name: 'Llave de AgentBridge', ok: false, blocking: true, security: true, detail }, identity: null }
  }

  const problems: string[] = []
  // Tracked separately from `problems` because it alone decides `blocking` below: a permission
  // bit is hygiene (loadOrCreateIdentity now self-repairs it — see tightenIfTooOpen in
  // @agentbridge/core — so re-running setup truly fixes it), but a key inside the shared folder
  // is already readable by anyone who can ask a question, which is what `blocking` means.
  let insideShare = false
  // Windows has no POSIX permission bits: `stat().mode` reports 666 on every single file, so
  // this check can only ever produce a demand nobody can satisfy. What protects the key there is
  // the user profile's own ACL, which we do not weaken. The real risk on Windows is the folder
  // being synced to the cloud, and that is a separate check.
  if (o.platform !== 'win32') {
    const info = await stat(file).catch(() => null)
    const mode = info ? info.mode & 0o777 : null
    if (mode !== null && mode !== 0o600) problems.push(`la llave está en ${mode.toString(8)} y debe estar en 0600`)
    const homeInfo = await stat(o.identityHome).catch(() => null)
    const homeMode = homeInfo ? homeInfo.mode & 0o777 : null
    if (homeMode !== null && homeMode !== 0o700) problems.push(`su carpeta está en ${homeMode.toString(8)} y debe estar en 0700`)
  }
  if (o.shareDir) {
    const [keyReal, shareReal] = await Promise.all([
      // The FILE, not the folder: `realpath` follows the symlink `loadIdentity` itself follows.
      realpath(file).catch(() => file),
      resolveComparablePath(o.shareDir),
    ])
    if (isSameOrWithin(keyReal, shareReal)) {
      insideShare = true
      // Every remediation line names a command a person can paste, with CLI_COMMAND — never a
      // bare "vuelve a correr setup".
      problems.push(`tu llave está dentro de la carpeta compartida, donde cualquier pregunta puede leerla: muévela fuera y vuelve a correr ${CLI_COMMAND} setup`)
    }
  }
  // A permission-bit problem alone is not named as its own remedy above (unlike the share-escape
  // line), so it needs one here — and it can honestly point at `setup`, because loadOrCreateIdentity
  // now tightens an over-open home or key on its very next load rather than leaving doctor's
  // complaint permanent.
  if (problems.length > 0 && !insideShare) problems.push(`lo arregla: ${CLI_COMMAND} setup`)
  return {
    // Only claims what was actually checked: an ordinary `doctor` run has no --share, so saying
    // "outside the shared folder" there would be a verdict nobody reached. On Windows, 0600 is
    // never claimed either — see the platform guard above.
    check: {
      name: 'Llave de AgentBridge',
      ok: problems.length === 0,
      // A wrong permission bit does not stop anyone from answering a question — the key still
      // works — so only the key actually sitting inside the shared folder blocks. Success is
      // still `true`: nothing here failed, so there is nothing "worth knowing but not fatal" to
      // distinguish it from.
      blocking: problems.length === 0 ? true : insideShare,
      // Both failures this check can report are about who can read the secret key: a mode that
      // lets anyone on the machine read it, or the key sitting inside the folder every authorized
      // question can read. Only the second one blocks (the first still answers questions fine) —
      // which is exactly why `blocking` alone must not decide whether `setup` says it out loud.
      security: true,
      detail: problems.length
        ? problems.join(' · ')
        : o.platform === 'win32'
          ? o.shareDir
            ? 'presente y fuera de la carpeta compartida'
            : 'presente'
          : o.shareDir
            ? 'presente, en 0600, y fuera de la carpeta compartida'
            : `presente y en 0600 (para revisar que esté fuera de la carpeta compartida, corre ${CLI_COMMAND} doctor --share <carpeta>)`,
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
      check: {
        name: 'Base de datos',
        ok: false,
        blocking: true,
        security: false,
        detail: `Todavía no existe. Se crea la primera vez que corres: ${CLI_COMMAND} setup`,
      },
      store: null,
    }
  }
  try {
    const store = await openStore(o.identityHome, o.relayPolicy ? { relayPolicy: o.relayPolicy } : {})
    return { check: { name: 'Base de datos', ok: true, blocking: true, security: false, detail: 'abre y responde' }, store }
  } catch (err) {
    return { check: { name: 'Base de datos', ok: false, blocking: true, security: false, detail: `No se pudo abrir: ${describeError(err)}` }, store: null }
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

  const suggestion = `Puedes cambiar tus tableros con: ${CLI_COMMAND} setup --relays "wss://uno,wss://otro"`
  // Establish the connection as its own explicit step, before publishing anything — never
  // classify "could not connect" vs. "refused" by matching text in the rejection reason. NIP-01
  // defines `error:` as a RELAY's own catch-all prefix for a genuine `OK false`, which is exactly
  // the same prefix this pool's own synthesized failures use (connect() errors, guards, timeouts —
  // see BoardPool.publish/BoardConnection) — so a spec-compliant board that refuses with
  // "error: some reason" would misread as "never reached it", the identical misdiagnosis that made
  // relay.nostr.net's real outage look like an active refusal in the first place. Whether the
  // socket itself opened is the one thing only this pool controls, never the relay, so it is the
  // one thing safe to branch on. `BoardPool.connect` reuses this same connection for the publish
  // right below — not a second, throwaway handshake.
  try {
    await o.pool.connect(o.relay)
  } catch {
    return { ok: false, detail: `no pude conectarme con ese tablero. ${suggestion}` }
  }

  const published = await o.pool.publish([o.relay], wrap)
  if (published.accepted.length === 0) {
    // The connection above already succeeded, so everything that can land here — the relay's own
    // explicit OK false, or the connection dropping/timing out after we sent the event — happened
    // only once the board was reachable. The relay's own words are third-party text and are not
    // printed either way. Every gift wrap is signed by a fresh throwaway key (never this person's
    // own), so a real rejection is never about a key the board recognises — it is a policy that
    // refuses publishers it does not already know, which is a property of the board, not of this
    // person.
    return { ok: false, detail: `no aceptó publicar (puede que pida registro o tenga una política que no acepta remitentes desconocidos). ${suggestion}` }
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

// Everything the shared folder itself is responsible for: whether `--share` was given, never
// whether `--profile` was. A person who runs `doctor --share <carpeta>` alone must get these —
// they are the whole reason `--share` exists as its own flag, and folding them into
// `addProfileChecks` (gated on `--profile`) is what let an `AGENTS.md` sitting in the shared
// folder go unreported when nobody happened to also pass `--profile`.
async function addShareChecks(
  add: (name: string, ok: boolean, detail: string, blocking: boolean, security?: boolean) => void,
  o: { shareDir: string; profileHome?: string },
): Promise<void> {
  const shareDir = resolve(o.shareDir)
  const persona = await access(join(shareDir, 'CLAUDE.md'))
    .then(() => true)
    .catch(() => false)
  // Neither branch names the shared folder or a path inside it — CLAUDE.md is a fixed name
  // this check always looks for, not information about this person's own folder layout. Every
  // check in this function is about the shared folder's own safety, so all of them block AND all
  // of them carry `security`: a hole here is readable by whoever sends the next question, not
  // just something worth knowing. (`blocking` alone would be enough to get them printed today;
  // `security` is what keeps them printed if any of them is ever judged non-fatal.)
  add('Carpeta compartida', persona, persona ? 'CLAUDE.md presente' : 'Falta CLAUDE.md en la carpeta compartida', true, true)

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
  add('Sin enlaces que salgan de la carpeta', linksOk, linkBits.length ? linkBits.join(' · ') : 'Ninguno', true, true)

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
    true,
    true,
  )

  // This one needs both flags at once — it says nothing about the shared folder alone — so it
  // only runs when `--profile` was also given, same as before the split.
  if (o.profileHome) {
    // `blockReadsOutsideWorkingDirectories` fences reads to the session's cwd — which IS
    // shareDir — and the two Read(**/.env*) denies only cover shareDir too. If `--profile`
    // (where settings.json and responder.json live) is the same folder as --share, or anywhere
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
        : `--profile es la misma carpeta que --share o está dentro de ella: la sesión puede leer ahí settings.json y responder.json — permissions.blockReadsOutsideWorkingDirectories y las reglas Read(**/.env*) no protegen nada dentro de la carpeta compartida. Vuelve a correr: ${CLI_COMMAND} setup-responder --share <tu carpeta compartida> --profile <otra carpeta, fuera de ella>`,
      true,
      true,
    )
  }
}

// Everything the dedicated Claude Code profile is responsible for: whether `--profile` was
// given, never whether `--share` was. Settings, the saved responder configuration, the installed
// plugin and the login check all live under `profileHome` regardless of whether a shared folder
// is in the picture at all.
async function addProfileChecks(
  add: (name: string, ok: boolean, detail: string, blocking: boolean, security?: boolean) => void,
  o: { profileHome: string; identityHome: string; repoDir?: string; run: CommandRunner },
): Promise<void> {
  // Everything below lives under `profileHome`, independent of whether a shared folder was given —
  // a profile with no settings.json (or a weakened one) must fail loudly even when doctor is run
  // with only --profile.
  // The reading itself lives beside the writer, in setup-responder.ts: `responder` refuses to
  // start on exactly this verdict (whole-branch review, Important 1), and a second copy here
  // would be free to drift from the one that decides whether a session is safe to spawn.
  // Checked against the scope responder.json records, so doctor and `responder` judge the same
  // file by the same standard. With no readable responder.json there is no scope to hold it to,
  // and one folder is the strictest reading — that failure is reported on its own line below.
  const saved = await readResponderConfig(o.profileHome).catch(() => null)
  const fence = await inspectResponderSettings(o.profileHome, saved?.scope ?? { kind: 'folder' }, {
    identityHome: saved?.identityHome ?? o.identityHome,
    home: homedir(),
  })
  add('Permisos del respondedor', fence.problems.length === 0, fence.problems.length ? fence.problems.join(' · ') : fence.detail, true, true)

  // What `start.sh`'s own executable-bit check used to stand in for: proof that this profile
  // was actually prepared by setup-responder, not just a folder someone pointed --profile at.
  // readResponderConfig does more than check existence — it re-validates the same shape setup
  // wrote (see the comment on SAFE_MODEL_PATTERN in setup-responder.ts) — so a hand-edited or
  // half-written responder.json is reported here rather than only failing later, mid-`responder`.
  const configPath = join(o.profileHome, RESPONDER_CONFIG_FILE)
  let configProblem: string | null = null
  let configDetail = configPath
  try {
    const config = await readResponderConfig(o.profileHome)
    configDetail = `${configPath} (modelo ${config.model}, esfuerzo ${config.effort})`
  } catch (err) {
    // readResponderConfig's own messages never carry a path or raw output — safe to show as-is.
    configProblem = err instanceof Error ? err.message : String(err)
  }
  // Without a valid responder.json, `responder` has nothing to run: what model, what effort —
  // the same reason `start.sh`'s executable-bit check used to block.
  add('Configuración del respondedor', configProblem === null, configProblem ?? configDetail, true)

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
    true,
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
    // A diagnostic that can hang forever is worse than one that says "I could not tell": the
    // person is left staring at a command that never returns, with no way to know which check
    // stalled. The bound lives in the signal, not in a `Promise.race` here: `defaultRunner`
    // passes `signal` straight to `spawn`, which is Node's own kill-on-abort — the only thing
    // that actually reaps a hung child, rather than merely racing a promise while the real
    // process (and its open stdio pipes, which keep the event loop alive) lives on. defaultRunner
    // resolves (never rejects) with code 124 when the signal fires, and with code 127 when
    // `spawn('claude', ...)` itself fails for an unrelated reason (binary missing, not
    // executable, etc.) — its stderr is Node's own English message (e.g. "spawn claude ENOENT").
    // The `.catch` below only exists for a custom CommandRunner that rejects instead; it is
    // coerced into the same 127 shape so both paths are handled identically, in Spanish, as a
    // failing check rather than a crash or a silent pass.
    const authResult = await o.run('claude', ['auth', 'status', '--json'], { env: authEnv, signal: AbortSignal.timeout(15_000) }).catch(
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
      // Never a hand-typed shell line: CLAUDE_CONFIG_DIR='…' claude is the exact defect this plan
      // fixes in `setup` (I5) — it survived here too, so it goes the same way, naming the
      // program rather than a command a person has to type themselves.
      authDetail = loggedIn ? 'Sesión activa' : `Todavía no has iniciado sesión. Lo hace por ti: ${CLI_COMMAND} setup`
    }
  }
  add('Sesión iniciada en el perfil dedicado', loggedIn, authDetail, true)

  if (o.repoDir) {
    const bundle = join(resolve(o.repoDir), 'plugins/agentbridge/dist/server.js')
    const built = await access(bundle)
      .then(() => true)
      .catch(() => false)
    add('Plugin compilado', built, built ? bundle : `Falta ${bundle}; ejecuta npm run build`, true)
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
  platform?: NodeJS.Platform
}): Promise<Check[]> {
  const checks: Check[] = []
  // `security` defaults to false so the only calls that carry it are the ones whose failure is
  // about who can read the key or the shared folder — a default of true would make the flag mean
  // nothing.
  const add = (name: string, ok: boolean, detail: string, blocking: boolean, security = false) =>
    checks.push({ name, ok, detail, blocking, security })
  const run = o.run ?? defaultRunner
  const now = o.now ?? (() => Math.floor(Date.now() / 1000))
  const boardTimeoutMs = o.boardTimeoutMs ?? 10_000
  const miningMs = o.miningMs ?? 30_000
  const platform = o.platform ?? process.platform

  const identityResult = await identityCheck({ identityHome: o.identityHome, shareDir: o.shareDir, platform })
  checks.push(identityResult.check)

  // A folder a sync client uploads on its own is worth knowing about on every platform (iCloud
  // Drive syncs macOS home folders too), so this is not gated on `platform` — only on whether the
  // path actually looks like one. An ordinary install must not carry a line that always says
  // everything is fine.
  const synced = cloudSyncedPath(o.identityHome)
  if (synced) {
    checks.push({
      name: 'Carpeta sincronizada con la nube',
      ok: false,
      blocking: false,
      // Not blocking — stopping the install does not un-upload a key that is already in somebody
      // else's datacenter — and the single most serious thing this program can tell anyone. It is
      // the check that made `security` exist.
      security: true,
      detail: `Tu llave está dentro de ${synced}, así que se sube sola a la nube. Muévela a una carpeta que no se sincronice y vuelve a correr ${CLI_COMMAND} setup con esa carpeta.`,
    })
  }

  const storeResult = await storeCheck({ identityHome: o.identityHome, relayPolicy: o.relayPolicy })
  checks.push(storeResult.check)
  const store = storeResult.store
  try {
    if (store) {
      const holder = getChannelLock(store)
      add(
        'Candado del canal',
        true,
        holder ? `lo tiene el proceso ${holder.pid} (época ${holder.epoch})` : 'libre: ningún canal está despachando ahora mismo',
        true,
      )

      // The same expiry boundary `requests` applies, so doctor never announces a request that
      // vanishes the moment the person runs the command it just told them to run. Counting only:
      // it must not clear the notification state, which belongs to whoever actually shows them.
      // Information, not a failure: it never blocks.
      const fresh = listPendingRequests(store).filter((request) => (request.requestedAt ?? 0) > now() - NOSTR.requestMaxAgeSeconds)
      add('Solicitudes pendientes', true, fresh.length === 0 ? 'ninguna' : `${fresh.length}; míralas con: ${CLI_COMMAND} requests`, false)

      if (identityResult.identity) {
        const relays = getProfile(store).relays
        const pool = new BoardPool({ identity: identityResult.identity, createSocket: o.createSocket, timeoutMs: boardTimeoutMs })
        try {
          for (const relay of relays) {
            const probe = await probeBoard({ relay, identity: identityResult.identity, pool, now: now(), timeoutMs: boardTimeoutMs, miningMs })
            // One board down out of several is weather, not a reason to alarm someone halfway
            // through installing — the aggregate check below is what blocks.
            add(`Tablero ${relay}`, probe.ok, probe.detail, false)
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

  // One board down out of five is weather. Zero boards working is the difference between
  // reaching someone and not reaching them at all — that one blocks.
  const boardChecks = checks.filter((c) => c.name.startsWith('Tablero '))
  if (boardChecks.length > 0 && boardChecks.every((c) => !c.ok)) {
    checks.push({
      name: 'Tableros públicos',
      ok: false,
      blocking: true,
      security: false,
      detail: 'Ningún tablero te dejó publicar y leer. Revisa tu conexión a internet; si estás en una red del trabajo o de una escuela, puede estar bloqueando las conexiones que AgentBridge usa.',
    })
  }

  // Each flag brings its own checks: `--share` alone must still examine the shared folder (that
  // is the whole point of I1's fix), and `--profile` alone must still examine the profile. The
  // one check that needs both (the cross-containment check) lives inside addShareChecks and
  // only fires when profileHome is also present — see the comment there.
  if (o.shareDir) await addShareChecks(add, { shareDir: o.shareDir, profileHome: o.profileHome })
  if (o.profileHome) await addProfileChecks(add, { profileHome: o.profileHome, identityHome: o.identityHome, repoDir: o.repoDir, run })
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
