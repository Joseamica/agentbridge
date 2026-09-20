import {
  CLI_ARGV,
  CLI_COMMAND,
  agentbridgeHome,
  encodeLink,
  getProfile,
  loadOrCreateIdentity,
  nowSeconds,
  openStore,
  setProfile,
  type Profile,
} from '@agentbridge/core'
import type { Dirent } from 'node:fs'
import { access, lstat, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { CliError, PromptEOF, type CliContext, type Output, type Prompt } from '../context'
import { isSameOrWithin, resolveComparablePath } from '../fs-paths'
import { describeFsError } from '../spanish-errors'
import { connect } from './connect'
import { projectConfigArtifacts, runDoctor } from './doctor'
import { defaultRunner, quote, repoDirFromBundleLocation, setupResponder, type CommandRunner } from './setup-responder'

// The guided flow needs two extra things the plain CliContext does not carry: something to
// drive prompts with (real readline in production, a scripted queue in tests — see
// context.ts's `Prompt` type) and a CommandRunner to hand to setupResponder/doctor and to the
// `claude mcp add` step, so every subprocess spawn in this whole command goes through the same
// injectable seam the rest of the CLI already tests with. `repoDir` and `profileHome` are
// optional overrides: setupCommand fills them from --repo/--profile (or the same defaults
// setup-responder and doctor use); tests always pass explicit temp directories so nothing here
// ever touches a real ~/.agentbridge-responder or a real Claude Code checkout.
export type SetupContext = CliContext & {
  prompt: Prompt
  run: CommandRunner
  repoDir?: string
  // Claude's dedicated profile (tarea 1). Never an AgentBridge home.
  profileHome?: string
  // The one seam this command needs for tests: `connect` mines 22 bits of proof of work, and the
  // plan allows exactly one test in the whole repository to pay for that (tests/asker/flow.test.ts).
  connectWith?: (link: string, ctx: CliContext) => Promise<void>
}

// The truth today: the key and the name are only ever created by answering these two questions,
// and nothing else creates them — `link` reads an existing identity and returns null when there
// isn't one, it never creates one. So the only honest instruction for a non-interactive terminal
// is "run this in a real one"; everything else in this message is what can genuinely be done by
// hand once that has happened.
export const NON_INTERACTIVE_ES = [
  'Este asistente necesita una terminal interactiva para hacerte preguntas, y esta no lo es',
  '(por ejemplo, se está corriendo dentro de un script, con la entrada redirigida, o en CI).',
  '',
  'La llave y tu nombre solo se crean aquí, contestando dos preguntas, así que corre este mismo',
  'comando en una terminal de verdad. Lo demás sí se puede hacer a mano después:',
  `  ${CLI_COMMAND} setup-responder --share <carpeta compartida> --profile ~/.agentbridge-responder`,
  `  ${CLI_COMMAND} doctor --profile ~/.agentbridge-responder --share <carpeta compartida>`,
  `  ${CLI_COMMAND} connect <enlace de la otra persona>`,
  `  claude mcp add agentbridge --scope user -- ${CLI_COMMAND} mcp`,
  '',
  'La guía completa está en docs/inicio-rapido.md',
].join('\n')

// Distinct from NON_INTERACTIVE_ES on purpose. That one means "there was never a terminal to ask
// you anything in" (ctx.prompt was never even set — see setupCommand). This one means the
// OPPOSITE: prompting was working fine, the person answered real questions, and the input
// stream then ended partway through — a real Ctrl-D in their own terminal, most plausibly.
// Telling that person their session "is not an interactive terminal (e.g. in CI)" would be
// straightforwardly false: they were just typing in one. PromptEOF surfacing from inside
// runGuidedSetup (as opposed to setupCommand's own upfront check) is exactly how this is told
// apart from the genuinely-no-terminal case — see runSetup's catch below.
const INPUT_CLOSED_ES = [
  'Se cerró la entrada antes de terminar de contestar (¿Ctrl-D, o se cerró la terminal?).',
  'No perdiste lo que ya llevabas avanzado, pero hacen falta las respuestas que faltan para dejarlo listo.',
  `Vuelve a correr "${CLI_COMMAND} setup" cuando quieras seguir.`,
].join('\n')

const SHARE_FOLDER_EXPLANATION_ES = [
  'Antes de pedirte la carpeta que vas a compartir, esto es lo importante:',
  '',
  'Todo lo que haya ahí lo puede leer cualquier persona a la que le des permiso de preguntarte —',
  'incluido un .env o un archivo de llaves, aunque le digas a tu agente que no lo lea. Eso no',
  'depende de que el modelo se porte bien: está impuesto por configuración, y esa configuración',
  'solo protege lo que está DENTRO de la carpeta que elijas. Por eso:',
  '  - Usa una carpeta nueva y vacía, dedicada solo a esto.',
  '  - No la apuntes a tu repositorio de trabajo ni a tu carpeta de usuario.',
  '  - Copia ahí solo lo que de verdad quieras compartir.',
].join('\n')

const ROLE_QUESTION_ES = [
  '¿Qué vas a hacer desde esta computadora?',
  '  1) Contestar preguntas (compartes una carpeta y dejas tu agente corriendo)',
  '  2) Hacer preguntas (le preguntas al agente de otra persona)',
  '  3) Las dos cosas',
  'Escribe 1, 2 o 3: ',
].join('\n')

const CONFIRM_WORD = 'CONFIRMAR'

type Role = 'responder' | 'preguntar' | 'ambas'

function parseRole(raw: string): Role | null {
  const v = raw.trim().toLowerCase()
  if (v === '1' || v === 'responder' || v === 'contestar') return 'responder'
  if (v === '2' || v === 'preguntar' || v === 'ask') return 'preguntar'
  if (v === '3' || v === 'ambas' || v === 'las dos') return 'ambas'
  return null
}

function parseNonEmpty(raw: string): string | null {
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

// Validated here rather than letting setProfile throw, so a name that is too long is one more
// "I didn't understand that" retry instead of ending the whole guided run.
function parseDisplayName(raw: string): string | null {
  const trimmed = raw.trim()
  return trimmed.length >= 1 && trimmed.length <= 80 ? trimmed : null
}

// Deliberately does not accept "sí", "s" or "y" as alternate spellings of the confirmation
// word: a person has to actually type CONFIRMAR (case- and whitespace-insensitive) rather than
// reflex-answering the way they would a plain yes/no. That property — that it cannot be
// answered on autopilot — is the entire point of gating a dangerous folder behind a typed word
// instead of a y/n prompt, and widening the accepted answers here would erase it.
function parseConfirmation(raw: string): true | null {
  return raw.trim().toLowerCase() === CONFIRM_WORD.toLowerCase() ? true : null
}

function parseYesNo(raw: string): boolean | null {
  const v = raw.trim().toLowerCase()
  if (v === 's' || v === 'si' || v === 'sí' || v === 'y' || v === 'yes') return true
  if (v === 'n' || v === 'no') return false
  return null
}

// Used only for "does this resolved path look right?" — unlike parseYesNo, an empty answer
// (plain Enter) counts as accepting what was just shown, which is the point of a confirm-to-
// proceed prompt.
function parseProceedOrRetry(raw: string): boolean | null {
  const v = raw.trim().toLowerCase()
  if (v === '') return true
  if (v === 's' || v === 'si' || v === 'sí' || v === 'y' || v === 'yes') return true
  if (v === 'n' || v === 'no') return false
  return null
}

const MAX_ATTEMPTS = 3

// Every question a person answers in this flow goes through here. On an answer `parse` rejects
// (returns null), it prints what a valid answer looks like and asks the exact same question
// again — up to MAX_ATTEMPTS times total — instead of ending the whole run over one typo, which
// would be worse than the written guide this command replaces (at least that doesn't lose your
// place). Exhausting every attempt still ends in the same Spanish CliError this always threw,
// just after a real chance to correct course instead of on the first miss.
//
// A stream that ends (PromptEOF — real stdin closing or running out, or a test's scripted
// answers running dry) is NEVER treated as a wasted attempt to retry: `prompt` rejects in that
// case, the `await` below throws, and this function does not catch it — it propagates straight
// out uncaught. Retrying an already-closed stream cannot ever produce an answer, so looping on
// it would either spin forever (unbounded) or, even bounded, burn the retry budget under the
// wrong diagnosis ("I didn't understand you" instead of "I have no terminal to ask you in").
// runSetup's own top-level try/catch is what turns a propagated PromptEOF into the same Spanish
// "needs an interactive terminal" message setupCommand already gives when there is no prompt at
// all — see the comment there.
async function askWithRetries<T>(
  prompt: Prompt,
  out: Output,
  question: string,
  parse: (raw: string) => T | null,
  invalidHint: string,
  giveUpMessage: string,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await prompt(question)
    const parsed = parse(raw)
    if (parsed !== null) return parsed
    if (attempt < MAX_ATTEMPTS) {
      const trimmed = raw.trim()
      out.log(trimmed ? `No entendí "${trimmed}". ${invalidHint}` : `No escribiste nada. ${invalidHint}`)
    }
  }
  throw new CliError(giveUpMessage)
}

// A leading `~` or a literal `$HOME` are never expanded by anything downstream: fs-paths.ts
// deliberately does not do this (reasoning that a shell already would have, before argv ever
// reached that code), but input typed at this prompt never passes through a shell — so that
// reasoning does not carry here, and without this, `~/AgentBridge/compartido` (the exact path
// the prompt and every doc show as the example) becomes a literal `~` subfolder of the current
// working directory instead of the person's home. Only a LEADING `~`/`$HOME` is handled — not
// `~user/...` — which covers the realistic case without pretending to be a full shell parser.
// Exported so tests can check this pure string logic directly against the REAL home directory
// without ever creating anything on disk — an earlier test instead ran a full guided setup
// against a path under the real `~/AgentBridge`, and a failing assertion partway through left a
// stray folder in the owner's actual home when the cleanup at the end of the test never ran.
export function expandUserPath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '~' || trimmed === '$HOME') return homedir()
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
  if (trimmed.startsWith('$HOME/')) return join(homedir(), trimmed.slice('$HOME/'.length))
  return trimmed
}

const MAX_FOLDER_ATTEMPTS = 3

// Expands `~`/`$HOME` and resolves a relative path against the current directory, then always
// shows the fully resolved absolute path and asks for confirmation before anything is created —
// a relative path or a surprising `~`/`$HOME` expansion is visible here, before it does
// anything, rather than after a folder was already created somewhere unintended. Saying "no"
// re-asks for a different folder (bounded, same 3-attempt shape as every other question here)
// rather than ending the whole run.
async function chooseShareDir(prompt: Prompt, out: Output, defaultShare: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_FOLDER_ATTEMPTS; attempt++) {
    const rawShare = (await prompt(`Carpeta a compartir (Enter para usar ${defaultShare}): `)).trim()
    const shareDir = resolve(expandUserPath(rawShare) || defaultShare)
    // Logged explicitly (not just folded into the question text below) so it is always visible
    // — to a person at a real terminal AND to anything inspecting this command's output — even
    // though a real readline `.question()` would also echo its own question string to the
    // terminal on its own.
    out.log(`Voy a usar esta carpeta: ${shareDir}`)
    const proceed = await askWithRetries(
      prompt,
      out,
      '¿Está bien? [S/n]: ',
      parseProceedOrRetry,
      'Escribe s (sí), n (no), o solo Enter para aceptar.',
      'No entendí tu respuesta.',
    )
    if (proceed) return shareDir
    if (attempt < MAX_FOLDER_ATTEMPTS) out.log('Bien, dime otra carpeta.')
  }
  throw new CliError(`No pude confirmar una carpeta para compartir después de 3 intentos. Vuelve a correr "${CLI_COMMAND} setup".`)
}

// Patterns a fresh, curated share folder should never contain. Matched against bare file
// names anywhere in the tree — good enough to catch the common, careless case (a `.env` copied
// in alongside real files, at any depth) without pretending to be a full secret scanner.
const CREDENTIAL_NAME_PATTERNS = [/^\.env(\..*)?$/, /\.pem$/i, /\.key$/i, /^id_rsa/i, /^credentials/i]

const MAX_SCAN_DEPTH = 6
const MAX_SCAN_ENTRIES = 20000

type ShareDirScan = {
  gitDirs: string[]
  suspiciousFiles: string[]
  // Symlinks are never followed (no cycle risk, and no need to duplicate doctor's own escaping-
  // symlink job) — but skipping one silently is exactly how a `repo -> /elsewhere/realrepo`
  // symlink hiding a `.git` sailed through with no warning at all. Every symlink found is named
  // here instead, which is what makes the CONFIRMAR gate fire on it.
  symlinks: string[]
  // node_modules is never descended into (same reasoning doctor.ts gives), but silently skipping
  // it is exactly how `node_modules/pkg/.env` produced no warning even though Grep can still
  // read it — named here so the gate can say so, the same way doctor.ts's own "skipped" list
  // names it rather than claiming a clean sweep.
  skippedNodeModules: string[]
  // True only when at least one branch was too deeply nested to fully explore — its own
  // recursion stops, but sibling directories elsewhere in the tree are still scanned. Kept
  // separate from `truncated` below: an earlier version conflated the two, so hitting the depth
  // cap in one deeply-nested branch silently gave up on scanning every OTHER sibling directory
  // in the whole tree too, including ones holding a `.git` or `.env` that a full scan would have
  // found immediately.
  depthLimited: boolean
  // True only when the total-entries safety cap was hit — a genuine, global stop (not merely
  // "this one branch"), since by then real work has already been done and a pathologically large
  // tree must not be allowed to hang `setup`. Whatever was already found before the cap is still
  // returned, never discarded.
  truncated: boolean
}

// Walks the whole tree, not just the top level: a single `readdir()` on the share folder's own
// root let `share/project/.git` and `share/sub/.env` both through with zero warning — the
// single most likely real mistake ("I'll share the folder where my projects live"). Mirrors the
// traversal shape of doctor.ts's walkShareDir (skip node_modules; name a `.git` directory
// instead of descending into it) without needing to also chase escaping symlinks — that is
// doctor's own, separate job.
async function scanShareDirForDanger(root: string): Promise<ShareDirScan> {
  const gitDirs: string[] = []
  const suspiciousFiles: string[] = []
  const symlinks: string[] = []
  const skippedNodeModules: string[] = []
  let visited = 0
  let truncated = false
  let depthLimited = false

  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (truncated) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      visited++
      if (visited > MAX_SCAN_ENTRIES) {
        truncated = true
        return
      }
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        symlinks.push(entryRel)
        continue
      }
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') {
          skippedNodeModules.push(entryRel)
          continue
        }
        if (entry.name === '.git') {
          gitDirs.push(entryRel)
          continue
        }
        if (depth >= MAX_SCAN_DEPTH) {
          // Only this branch stops here — NOT the whole walk. Elsewhere in the tree (siblings,
          // shallower directories not yet visited) keeps being scanned normally.
          depthLimited = true
          continue
        }
        await walk(join(dir, entry.name), entryRel, depth + 1)
      } else if (entry.isFile()) {
        // A `.git` FILE (not a directory) is what a git worktree or a submodule checkout has
        // instead of a full `.git` directory — still a working repo, and previously undetected.
        if (entry.name === '.git') gitDirs.push(entryRel)
        else if (CREDENTIAL_NAME_PATTERNS.some((re) => re.test(entry.name))) suspiciousFiles.push(entryRel)
      }
    }
  }

  await walk(root, '', 0)
  return { gitDirs, suspiciousFiles, symlinks, skippedNodeModules, depthLimited, truncated }
}

type PathKind = 'missing' | 'directory' | 'not-a-directory' | 'broken-symlink' | 'error'

// `stat` follows symlinks, so it throws ENOENT for BOTH a genuinely missing path and a dangling
// symlink at that exact path — `lstat` (which does not follow) is what tells the two apart.
// Anything else (EACCES on a parent, say) is reported through the shared `describeFsError`
// translator rather than left to bubble up as a raw Node error.
async function inspectPath(path: string): Promise<{ kind: PathKind; detail?: string }> {
  try {
    const info = await stat(path)
    return { kind: info.isDirectory() ? 'directory' : 'not-a-directory' }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') {
      const link = await lstat(path).catch(() => null)
      if (link?.isSymbolicLink()) return { kind: 'broken-symlink' }
      return { kind: 'missing' }
    }
    return { kind: 'error', detail: describeFsError(err) }
  }
}

export type ShareDirAssessment = {
  exists: boolean
  isHome: boolean
  // Non-null when the chosen folder IS, or would expose, the identity's or the responder's own
  // credential directory — a hard refusal, never something a typed confirmation can override:
  // the token inside is full impersonation on the relay, and confirming a choice doesn't make
  // that any less true.
  credentialConflict: string | null
  // What is actually at stake in `credentialConflict`, since it is not the same thing for the two
  // branches: the identity folder holds the secret key itself, but the dedicated profile (Q1 of
  // this plan) holds no key or database at all — only settings.json and start.sh, which control
  // what the answering session is allowed to do. A caller that prints one message for both would
  // overclaim for the profile branch.
  credentialConflictKind: 'identity' | 'profile' | null
  // Non-null when the path itself cannot be used as a shared folder at all — a plain file
  // sitting where a folder is expected, a dangling symlink, or an unreadable path — as opposed
  // to a folder that exists and is merely risky (`reasons`, confirmable).
  problem: string | null
  reasons: string[]
}

// Reuses doctor's own project-config detection (projectConfigArtifacts) rather than keeping a
// second list of the same artifact names — see the comment on that export in doctor.ts.
export async function assessShareDir(
  shareDirRaw: string,
  guard: { identityHome: string; profileHome: string },
): Promise<ShareDirAssessment> {
  const shareDir = resolve(shareDirRaw)
  const [shareReal, homeReal, identityReal, profileReal] = await Promise.all([
    resolveComparablePath(shareDir),
    resolveComparablePath(homedir()),
    resolveComparablePath(guard.identityHome),
    resolveComparablePath(guard.profileHome),
  ])
  const isHome = shareReal === homeReal

  let credentialConflict: string | null = null
  let credentialConflictKind: 'identity' | 'profile' | null = null
  if (isSameOrWithin(identityReal, shareReal)) {
    credentialConflict = `tu identidad de AgentBridge (${guard.identityHome})`
    credentialConflictKind = 'identity'
  } else if (isSameOrWithin(profileReal, shareReal)) {
    credentialConflict = `el perfil dedicado del respondedor (${guard.profileHome})`
    credentialConflictKind = 'profile'
  }

  const inspected = await inspectPath(shareDir)
  let problem: string | null = null
  if (inspected.kind === 'not-a-directory') problem = 'ya existe y no es una carpeta (es un archivo)'
  else if (inspected.kind === 'broken-symlink') problem = 'es un enlace roto: apunta a algo que no existe'
  else if (inspected.kind === 'error') problem = inspected.detail ?? 'no se pudo revisar'
  const exists = inspected.kind === 'directory'

  const reasons: string[] = []
  if (exists && !isHome && !credentialConflict && !problem) {
    const scan = await scanShareDirForDanger(shareDir)
    if (scan.gitDirs.length > 0) {
      const label = scan.gitDirs.length === 1 ? 'un repositorio de git' : `${scan.gitDirs.length} repositorios de git`
      const shown = scan.gitDirs.slice(0, 5).join(', ') + (scan.gitDirs.length > 5 ? ', …' : '')
      reasons.push(`contiene ${label} (.git): ${shown} — parece código de trabajo`)
    }
    if (scan.suspiciousFiles.length > 0) {
      const shown = scan.suspiciousFiles.slice(0, 5).join(', ') + (scan.suspiciousFiles.length > 5 ? ', …' : '')
      reasons.push(`tiene archivos que parecen credenciales: ${shown}`)
    }
    if (scan.symlinks.length > 0) {
      const shown = scan.symlinks.slice(0, 5).join(', ') + (scan.symlinks.length > 5 ? ', …' : '')
      reasons.push(
        `tiene enlaces simbólicos que no revisé por dentro: ${shown} — podrían apuntar a cualquier cosa, incluido otro repositorio de trabajo`,
      )
    }
    if (scan.skippedNodeModules.length > 0) {
      const shown = scan.skippedNodeModules.slice(0, 5).join(', ') + (scan.skippedNodeModules.length > 5 ? ', …' : '')
      reasons.push(`no revisé dentro de node_modules (${shown}) — Grep no está bloqueado, así que un .env ahí adentro seguiría siendo legible`)
    }
    const projectConfig = await projectConfigArtifacts(shareDir)
    if (projectConfig.length > 0) reasons.push(`ya tiene configuración de proyecto que doctor vigila: ${projectConfig.join(', ')}`)
    // Both of these lead with the actual danger (a repo or credentials might be hiding in what
    // wasn't fully checked), not with a performance-sounding note about size — a real reviewer
    // read the size-first wording as "just slow," when their folder genuinely held a git repo
    // and a .env.
    if (scan.depthLimited) {
      reasons.push(
        'tiene carpetas anidadas demasiado profundo para revisarlas por completo — podría haber un repositorio de trabajo o un archivo de credenciales más adentro que no alcancé a ver; revísala tú antes de confirmar',
      )
    }
    if (scan.truncated) {
      reasons.push(
        'es tan grande que no terminé de revisarla — podría haber un repositorio de trabajo o un archivo de credenciales que no alcancé a ver; revísala tú antes de confirmar',
      )
    }
  }
  return { exists, isHome, credentialConflict, credentialConflictKind, problem, reasons }
}

// The public entry point tests and setupCommand call. It's a thin wrapper around
// `runGuidedSetup`: its only job is to turn a `PromptEOF` that escapes the whole flow into
// INPUT_CLOSED_ES — reached whenever stdin closes or a test's scripted answers run out partway
// through a run that had already asked at least one real question, as opposed to
// setupCommand's own upfront check, which uses NON_INTERACTIVE_ES for a session that never had
// a prompt to begin with. Every other error (a normal CliError from a validation or a give-up
// message, a relay error, …) passes through unchanged.
export async function runSetup(ctx: SetupContext): Promise<void> {
  try {
    await runGuidedSetup(ctx)
  } catch (err) {
    if (err instanceof PromptEOF) {
      throw new CliError(INPUT_CLOSED_ES)
    }
    throw err
  }
}

async function runGuidedSetup(ctx: SetupContext): Promise<void> {
  const { out, prompt } = ctx

  out.log('AgentBridge — configuración guiada')
  out.log('Te voy a hacer las preguntas necesarias para dejarlo listo. Puedes cancelar con Ctrl+C.')
  out.log('')

  // 1. Identity and profile — one folder holds the key and the database, and every command this
  // person types uses it, whichever side they are on.
  const { identity, created } = await loadOrCreateIdentity(ctx.home)
  out.log(created ? 'Creé tu llave en esta computadora.' : 'Ya tenías una llave en esta computadora.')

  const store = await openStore(ctx.home, ctx.relayPolicy ? { relayPolicy: ctx.relayPolicy } : {})
  let profile
  try {
    profile = getProfile(store)
    if (!profile.name) {
      const name = await askWithRetries(
        prompt,
        out,
        '¿Cómo quieres que te vean las personas a las que te conectes? (tu nombre o apodo): ',
        parseDisplayName,
        'Escribe un nombre de 1 a 80 caracteres.',
        `No me diste un nombre. Vuelve a correr "${CLI_COMMAND} setup" cuando quieras.`,
      )
      profile = setProfile(store, { name, now: nowSeconds() })
    }
  } finally {
    // Closed before anything else runs: `connect` and `doctor` open this same database, and holding
    // it open across a whole guided run would make their writes wait on a handle nothing needs.
    store.close()
  }

  const myLink = encodeLink(identity.publicKey, profile.relays)
  out.log(`Te llamas ${profile.name} y usas ${profile.relays.length} tableros públicos.`)
  out.log('(Son tableros de Nostr. No hay ningún servidor nuestro en medio.)')
  // Printed here, for every role, because it is this person's identity and not a feature of one
  // side: whoever wants to reach them needs exactly this string, and a test that checks it must not
  // depend on which branch runs later.
  out.log('Tu enlace es:')
  out.log(`  ${myLink}`)
  out.log('')

  // 2. Which side
  const role = await askWithRetries(
    prompt,
    out,
    ROLE_QUESTION_ES,
    parseRole,
    'Escribe 1, 2 o 3.',
    `No pude entender qué ibas a hacer. Vuelve a correr "${CLI_COMMAND} setup" y responde 1, 2 o 3.`,
  )
  const willAnswer = role === 'responder' || role === 'ambas'
  const willAsk = role === 'preguntar' || role === 'ambas'
  out.log('')

  const done: string[] = [`Identidad lista como ${profile.name}.`]
  const pending: string[] = []

  // 3. Answering side
  if (willAnswer) {
    out.log(SHARE_FOLDER_EXPLANATION_ES)
    out.log('')
    const defaultShare = join(homedir(), 'AgentBridge', 'compartido')
    const repoDir = ctx.repoDir ? resolve(ctx.repoDir) : await repoDirFromBundleLocation(import.meta.url)
    const profileHome = ctx.profileHome ? resolve(ctx.profileHome) : join(homedir(), '.agentbridge-responder')

    const shareDir = await chooseShareDir(prompt, out, defaultShare)

    const assessment = await assessShareDir(shareDir, { identityHome: ctx.home, profileHome })
    if (assessment.problem) {
      throw new CliError(`No puedo usar esa carpeta: ${assessment.problem}. Elige otra ruta y vuelve a correr "${CLI_COMMAND} setup".`)
    }
    if (assessment.isHome) {
      throw new CliError(
        `Esa es tu carpeta de usuario, y compartirla dejaría visible todo lo que tienes en la computadora. Vuelve a correr "${CLI_COMMAND} setup" con otra carpeta.`,
      )
    }
    if (assessment.credentialConflict) {
      // What is actually at stake differs by branch (Q1: the dedicated profile holds no key or
      // database) — naming the wrong one would either overclaim (a leaked settings.json is not
      // "tu identidad entera") or underclaim (a leaked identity.json is worse than a permission
      // file), so each says only what is true of it.
      const stake =
        assessment.credentialConflictKind === 'identity'
          ? 'Tu llave secreta es tu identidad entera: quien la lea puede hacerse pasar por ti en cualquier tablero, para siempre, y no hay forma de revocarla.'
          : 'Ahí viven settings.json y start.sh, que controlan qué puede hacer la sesión que contesta preguntas: quien los lea o los reescriba podría aflojar sus permisos o cambiar qué corre.'
      throw new CliError(`Ahí dentro está ${assessment.credentialConflict}. ${stake} Vuelve a correr "${CLI_COMMAND} setup" con otra carpeta.`)
    }
    if (assessment.reasons.length > 0) {
      out.log('Ojo: esa carpeta se ve peligrosa para compartir —')
      for (const reason of assessment.reasons) out.log(`  - ${reason}`)
      out.log(
        `Si de verdad quieres usarla de todos modos, escribe exactamente ${CONFIRM_WORD} (mayúsculas o minúsculas da igual). Cualquier otra respuesta cancela.`,
      )
      await askWithRetries(
        prompt,
        out,
        `Escribe ${CONFIRM_WORD} para continuar: `,
        parseConfirmation,
        `Para seguir con esta carpeta, escribe exactamente la palabra ${CONFIRM_WORD} (sin comillas; mayúsculas o minúsculas da igual).`,
        `No escribiste "${CONFIRM_WORD}", así que no toqué nada. Vuelve a correr "${CLI_COMMAND} setup" con otra carpeta si quieres.`,
      )
    }
    out.log(assessment.exists ? 'Voy a usar la carpeta que ya existe.' : 'Esa carpeta no existe todavía; la voy a crear vacía.')
    out.log('')

    let setupResult: Awaited<ReturnType<typeof setupResponder>>
    try {
      setupResult = await setupResponder({ shareDir, repoDir, profileHome, identityHome: ctx.home, run: ctx.run, out, printNextSteps: false })
    } catch (err) {
      if (err instanceof CliError) throw err
      // describeFsError names the kind of filesystem problem (permissions, missing path) without
      // echoing an arbitrary error message, which can carry paths this text must not carry.
      throw new CliError(
        `No pude preparar la carpeta compartida o el perfil dedicado: ${describeFsError(err)}. No se completó la instalación; revisa la ruta y vuelve a correr "${CLI_COMMAND} setup".`,
      )
    }
    out.log('')

    out.log('Verificando con doctor…')
    const checks = await runDoctor({
      identityHome: ctx.home,
      profileHome,
      shareDir,
      repoDir,
      run: ctx.run,
      createSocket: ctx.createSocket,
      relayPolicy: ctx.relayPolicy,
    })
    for (const c of checks) out.log(`${c.ok ? '[ok]    ' : '[falta] '}${c.name}: ${c.detail}`)
    out.log('')

    // Whoever is going to ask needs this string, and nothing else: there is no invitation to create
    // and no relay to register with.
    out.log('Este es tu enlace. Dáselo a quien quieras que pueda preguntarte:')
    out.log(`  ${myLink}`)
    out.log(`Cuando te manden una solicitud, la ves con: ${CLI_COMMAND} requests`)
    out.log('')

    const alreadyLoggedIn = checks.some((c) => c.name === 'Sesión iniciada en el perfil dedicado' && c.ok)
    const remainingSteps = [
      ...(alreadyLoggedIn ? [] : [`Inicia sesión una vez en el perfil dedicado:  CLAUDE_CONFIG_DIR=${quote(setupResult.claudeConfigDir)} claude   (usa /login y sal)`]),
      `Arráncalo:  ${quote(setupResult.startScriptPath)}`,
      'Dale tu enlace a quien vaya a preguntarte.',
    ]
    out.log('Para terminar de dejarlo contestando, en este orden:')
    remainingSteps.forEach((step, i) => out.log(`  ${i + 1}. ${step}`))
    out.log('')

    done.push('Perfil dedicado del respondedor preparado.')
    for (const c of checks) {
      if (!c.ok) pending.push(`${c.name}: ${c.detail}`)
    }
    // Quoted like every other printed path in this command (Minor 1): a profile at
    // `/tmp/mi respondedor`, or a home with an apostrophe in it, must still be a line that runs
    // when pasted, not just when the default path happens to have neither.
    pending.push(`Arranca el respondedor: ${quote(setupResult.startScriptPath)}`)
    pending.push('Dale tu enlace a quien vaya a preguntarte.')
  }

  // 4. Asking side
  if (willAsk) {
    out.log('Para preguntarle a alguien necesitas su enlace: una cadena que empieza con agentbridge:nprofile1.')
    out.log(`Se lo pides por donde ya hablen. Esa persona lo saca con: ${CLI_COMMAND} link`)
    const hasLink = await askWithRetries(
      prompt,
      out,
      '¿Ya tienes su enlace? [s/n]: ',
      parseYesNo,
      'Escribe s (sí) o n (no).',
      'No entendí tu respuesta; seguimos sin conectar a nadie por ahora.',
    ).catch(() => false)

    if (hasLink) {
      const link = await askWithRetries(
        prompt,
        out,
        'Pega su enlace: ',
        parseNonEmpty,
        'Pega la cadena completa, empieza con agentbridge:nprofile1.',
        `No pegaste un enlace. Cuando lo tengas: ${CLI_COMMAND} connect <enlace>`,
      )
      // connect mines 22 bits of proof of work and says so before it starts (P5c). It also runs its
      // own short-lived cycle, which is why the store above was closed first.
      const connectWith = ctx.connectWith ?? ((value: string, inner: CliContext) => connect([value], inner))
      await connectWith(link, ctx)
      // Deliberately not "I sent your request": `connect` also returns normally when the contact was
      // already approved and when every board refused the publication, and claiming a send that did
      // not happen is how a person ends up waiting for an answer that was never coming. What it
      // printed is what actually happened; this line only says where to look next.
      pending.push(`Revisa cómo va: ${CLI_COMMAND} contacts`)
    } else {
      out.log(`Cuando lo tengas: ${CLI_COMMAND} connect <enlace>`)
      pending.push(`Conéctate con quien vayas a preguntar: ${CLI_COMMAND} connect <enlace>`)
    }
    out.log('')

    out.log('Para preguntar desde tu propio Claude Code hace falta además registrar el servidor MCP de AgentBridge una vez.')
    // A registration that stores only CLI_ARGV starts its server against the DEFAULT home. Someone
    // who set AGENTBRIDGE_HOME for this run would end up with a Claude Code tool talking to a
    // different identity than the one this setup just prepared — with no error, just an empty
    // contact list. When the home is not the default, it travels with the registration. Computed
    // before the yes/no question below so the give-up message offers this same command, not a
    // second, hand-written one that forgets --env for a custom home.
    const customHome = ctx.home !== agentbridgeHome({}) ? ctx.home : null
    const envArgs = customHome ? ['--env', `AGENTBRIDGE_HOME=${customHome}`] : []
    const manual = `claude mcp add agentbridge --scope user ${envArgs.join(' ')} -- ${CLI_COMMAND} mcp`.replace(/\s+/g, ' ')
    const mcpYesNoGiveUpEs = `No entendí tu respuesta. Puedes registrarlo tú cuando quieras con: ${manual}`
    let wantsMcp: boolean
    try {
      wantsMcp = await askWithRetries(prompt, out, '¿Lo registro ahora? [s/n]: ', parseYesNo, 'Escribe s (sí) o n (no).', mcpYesNoGiveUpEs)
    } catch (err) {
      // Exhausting this one question must not throw away a verdict for work that may already
      // have succeeded on the responder side (the "ambas" role) — treat it as "no" and keep
      // going, the same graceful landing as if they had typed "n" the first time.
      if (err instanceof CliError && err.message === mcpYesNoGiveUpEs) {
        out.log('No pude entender tu respuesta después de varios intentos; sigo sin registrar el servidor MCP automáticamente.')
        wantsMcp = false
      } else {
        throw err
      }
    }
    let mcpRegistered = false
    if (wantsMcp) {
      const result = await ctx.run('claude', ['mcp', 'add', 'agentbridge', '--scope', 'user', ...envArgs, '--', ...CLI_ARGV, 'mcp'], { env: ctx.env })
      if (result.code === 0) {
        mcpRegistered = true
        out.log('Listo: el servidor MCP quedó registrado.')
      } else {
        out.log(`No pude registrar el servidor MCP automáticamente (el comando terminó con código ${result.code}). Hazlo a mano:`)
        out.log(`  ${manual}`)
      }
    } else {
      out.log('Está bien. Cuando quieras, corre:')
      out.log(`  ${manual}`)
    }
    out.log('')
    out.log('Importante: si ya tenías una sesión de Claude Code abierta, ciérrala y ábrela de nuevo — la herramienta nueva')
    out.log('no aparece hasta que reinicias la sesión.')
    out.log(`Para preguntar desde la terminal en cualquier momento: ${CLI_COMMAND} ask <nombre> "<pregunta>"`)
    out.log('')

    if (mcpRegistered) {
      done.push('Servidor MCP registrado en Claude Code.')
      pending.push('Reinicia (o abre) tu sesión de Claude Code para que aparezca la herramienta nueva.')
    } else {
      pending.push(`Registra el servidor MCP: ${manual}`)
    }
  }

  // 5. Verdict
  out.log('== Resumen ==')
  out.log('Listo:')
  for (const d of done) out.log(`  - ${d}`)
  if (pending.length === 0) {
    out.log('Pendiente: nada. Ya puedes usar AgentBridge.')
  } else {
    out.log('Pendiente:')
    for (const p of pending) out.log(`  - ${p}`)
    out.log('')
    out.log(`Siguiente paso: ${pending[0]}`)
  }
}

// I5: `doctor`'s own remediation line on a failing board, and the runbook's own worked example,
// both hand a person exactly `setup --relays "wss://uno,wss://otro"` — mid-incident, on an
// otherwise-working install. Before this, that command applied the list and then fell straight
// through into the entire guided interview: for someone who answers "1" (contesta), that meant
// `chooseShareDir` again, whose default is hard-coded and never read back from the existing
// `start.sh` — so pressing Enter at the folder prompt (the exact answer the quick start's own
// worked example models as normal) silently repointed a working responder at a brand-new, empty
// `~/AgentBridge/compartido`, with no error anywhere. `--relays` now does only what it says:
// write the list, print it, and exit. It never opens a prompt, so it works with no interactive
// terminal at all — the guard below only ever applies to the guided flow that follows it.
export async function applyRelays(ctx: CliContext, relays: readonly string[]): Promise<Profile> {
  const store = await openStore(ctx.home, ctx.relayPolicy ? { relayPolicy: ctx.relayPolicy } : {})
  let profile: Profile
  try {
    profile = setProfile(store, { relays, now: nowSeconds() })
  } finally {
    store.close()
  }
  ctx.out.log(`Cambié tus tableros: ahora usas ${profile.relays.length}.`)
  for (const relay of profile.relays) ctx.out.log(`  ${relay}`)
  return profile
}

export async function setupCommand(argv: string[], ctx: CliContext): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { repo: { type: 'string' }, profile: { type: 'string' }, relays: { type: 'string' } },
  })
  const relays = values.relays
    ?.split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  if (relays && relays.length > 0) {
    await applyRelays(ctx, relays)
    return
  }
  if (!ctx.prompt) {
    throw new CliError(NON_INTERACTIVE_ES)
  }
  await runSetup({ ...ctx, prompt: ctx.prompt, run: defaultRunner, repoDir: values.repo, profileHome: values.profile })
}
