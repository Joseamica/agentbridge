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
  UserFacingError,
  type Profile,
} from '@agentbridge/core'
import type { Dirent } from 'node:fs'
import { access, lstat, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { copyToClipboard } from '../clipboard'
import { CliError, PromptEOF, type CliContext, type Output, type Prompt } from '../context'
import { isSameOrWithin, resolveComparablePath } from '../fs-paths'
import { defaultInteractiveRunner, type InteractiveRunner } from '../interactive'
import { describeFsError } from '../spanish-errors'
import { connect } from './connect'
import { MAX_SCAN_DEPTH, MAX_SCAN_ENTRIES, projectConfigArtifacts, runDoctor, type Check } from './doctor'
import { readResponderConfig, runResponder } from './responder'
import { scopeProblem, scopeSummary, type ResponderScope } from './responder-config'
import {
  CAJA_FUERTE_HOME,
  defaultRunner,
  repoDirFromBundleLocation,
  responderSettings,
  setupResponder,
  type CommandRunner,
  type ScopePaths,
} from './setup-responder'

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
  // How this command hands the terminal over to Claude — for the login, and for the responder
  // itself. Injected like `run` so tests never spawn anything.
  runInteractive: InteractiveRunner
  // Returns false when no clipboard tool exists. Injected so a test does not depend on whether
  // the machine running it happens to have one.
  copyLink?: (text: string) => Promise<boolean>
  // Which platform the scope question judges and setupResponder writes for. Injected so the
  // Windows refusals (mode 2 entirely, mode 3 with a folder outside the personal folder) can be
  // walked through on any machine; defaults to this one.
  platform?: NodeJS.Platform
  // The personal folder the scope question reasons about and setupResponder anchors to. Injected
  // so a test decides which caja fuerte folders exist, instead of whatever this machine has: the
  // case-blind caja test proved nothing on a Mac with a real `~/.kube` (task 2 review, M8).
  personalHome?: string
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
  // "carpeta personal", the name option 3 of the scope question uses for the same folder, a few
  // lines later (task 2 review, M1): two names for one thing read as two things.
  '  - No la apuntes a tu repositorio de trabajo ni a tu carpeta personal.',
  '    (Si quieres que tu agente vea toda tu carpeta personal, eso te lo pregunto después.)',
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
//
// A folder dragged into the macOS Terminal arrives shell-escaped (`Mis\ Documentos`), and some
// terminals wrap it in quotes instead. Both are undone here, the way a shell would have, before
// any other check: left in, the backslash reached the glob-character refusal and a person who
// did exactly what a non-programmer does was told to rename a folder whose name was fine (task 2
// review, M5). Not on Windows, where the backslash is the path separator.
export function expandUserPath(raw: string, platform: NodeJS.Platform = process.platform): string {
  let trimmed = raw.trim()
  const quoted = /^(['"])(.*)\1$/s.exec(trimmed)
  if (quoted) trimmed = quoted[2] ?? ''
  if (platform !== 'win32') trimmed = trimmed.replace(/\\(.)/gs, '$1')
  if (trimmed === '~' || trimmed === '$HOME') return homedir()
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
  if (trimmed.startsWith('$HOME/')) return join(homedir(), trimmed.slice('$HOME/'.length))
  return trimmed
}

const MAX_FOLDER_ATTEMPTS = 3

// The three verdicts no typed confirmation can override, as a sentence instead of a thrown
// error. They used to end the whole interview: a typo in a long path cost a full re-run, for the
// role whose interview is the longest, with the loop to feed it back into sitting right there
// (whole-branch review, Minor 3). The sentence carries no "vuelve a correr setup" — inside the
// loop that would be wrong advice, and the one place that does give up says it itself.
function hardRefusal(assessment: ShareDirAssessment): string | null {
  if (assessment.problem) return `No puedo usar esa carpeta: ${assessment.problem}.`
  if (assessment.isHome) {
    return 'Esa es tu carpeta personal, y compartirla así dejaría visible todo lo que tienes en la computadora.'
  }
  if (assessment.credentialConflict) {
    // What is actually at stake differs by branch (Q1: the dedicated profile holds no key or
    // database) — naming the wrong one would either overclaim (a leaked settings.json is not
    // "tu identidad entera") or underclaim (a leaked identity.json is worse than a permission
    // file), so each says only what is true of it.
    const stake =
      assessment.credentialConflictKind === 'identity'
        ? 'Tu llave secreta es tu identidad entera: quien la lea puede hacerse pasar por ti en cualquier tablero, para siempre, y no hay forma de revocarla.'
        : 'Ahí viven settings.json y responder.json, que controlan qué puede hacer la sesión que contesta preguntas: quien los lea o los reescriba podría aflojar sus permisos o cambiar qué corre.'
    return `Ahí dentro está ${assessment.credentialConflict}. ${stake}`
  }
  return null
}

// Expands `~`/`$HOME` and resolves a relative path against the current directory, then always
// shows the fully resolved absolute path and asks for confirmation before anything is created —
// a relative path or a surprising `~`/`$HOME` expansion is visible here, before it does
// anything, rather than after a folder was already created somewhere unintended. Saying "no",
// and now also naming a folder that cannot be used at all, re-asks for a different one
// (bounded, same 3-attempt shape as every other question here) rather than ending the whole run.
// The assessment travels back out with the folder so the caller does not have to run it twice.
async function chooseShareDir(o: {
  prompt: Prompt
  out: Output
  defaultShare: string
  assess: (shareDir: string) => Promise<ShareDirAssessment>
  platform: NodeJS.Platform
}): Promise<{ shareDir: string; assessment: ShareDirAssessment }> {
  for (let attempt = 1; attempt <= MAX_FOLDER_ATTEMPTS; attempt++) {
    const rawShare = (await o.prompt(`Carpeta a compartir (Enter para usar ${o.defaultShare}): `)).trim()
    const shareDir = resolve(expandUserPath(rawShare, o.platform) || o.defaultShare)
    // Logged explicitly (not just folded into the question text below) so it is always visible
    // — to a person at a real terminal AND to anything inspecting this command's output — even
    // though a real readline `.question()` would also echo its own question string to the
    // terminal on its own.
    o.out.log(`Voy a usar esta carpeta: ${shareDir}`)
    const proceed = await askWithRetries(
      o.prompt,
      o.out,
      '¿Está bien? [S/n]: ',
      parseProceedOrRetry,
      'Escribe s (sí), n (no), o solo Enter para aceptar.',
      'No entendí tu respuesta.',
    )
    if (proceed) {
      const assessment = await o.assess(shareDir)
      const refusal = hardRefusal(assessment)
      if (!refusal) return { shareDir, assessment }
      o.out.log(refusal)
      if (attempt === MAX_FOLDER_ATTEMPTS) {
        throw new CliError(`${refusal} No toqué nada. Vuelve a correr "${CLI_COMMAND} setup" cuando tengas otra carpeta en mente.`)
      }
      o.out.log('Elige otra ruta.')
      continue
    }
    if (attempt < MAX_FOLDER_ATTEMPTS) o.out.log('Bien, dime otra carpeta.')
  }
  throw new CliError(`No pude confirmar una carpeta para compartir después de 3 intentos. Vuelve a correr "${CLI_COMMAND} setup".`)
}

// Patterns a fresh, curated share folder should never contain. Matched against bare file
// names anywhere in the tree — good enough to catch the common, careless case (a `.env` copied
// in alongside real files, at any depth) without pretending to be a full secret scanner.
const CREDENTIAL_NAME_PATTERNS = [/^\.env(\..*)?$/, /\.pem$/i, /\.key$/i, /^id_rsa/i, /^credentials/i]

// Shared with doctor's bounded walk of mode 2's extra folders, so both stop at the same place.

type ShareDirScan = {
  gitDirs: string[]
  suspiciousFiles: string[]
  // Symlinks are never followed (no cycle risk, and no need to duplicate doctor's own escaping-
  // symlink job) — but skipping one silently is exactly how a `repo -> /elsewhere/realrepo`
  // symlink hiding a `.git` sailed through with no warning at all. Every symlink found is named
  // here instead, which is what makes the CONFIRMAR gate fire on it.
  symlinks: string[]
  // node_modules is never descended into (same reasoning doctor.ts gives), but silently skipping
  // it is exactly how a key file inside `node_modules/pkg/` produced no warning. (The reason
  // once said Grep could read a `.env` there; on Claude Code 2.1.282 Grep skips denied `.env`
  // files (verificaciones.md, V6 and V13), but an `id_rsa`, a `credentials.json` or — in mode 1 —
  // a `.pem` is still readable.) Named here so the gate can say so, the same way doctor.ts's own
  // "skipped" list names it rather than claiming a clean sweep.
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
  // this plan) holds no key or database at all — only settings.json and responder.json, which control
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
      reasons.push(`no revisé dentro de node_modules (${shown}) — si ahí adentro hay un archivo de llaves o de credenciales, tu agente lo puede leer y yo no lo vi`)
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

// The question 0.4 adds: how far the answering agent can see. Asked once, after the shared folder
// is settled, for every contact at once (D1). Enter keeps what this computer already has — the
// same reason the folder question proposes the saved folder: a re-run pressing Enter must never
// silently change what a working responder can read, in either direction.
const SCOPE_QUESTION_LINES = [
  '¿Qué puede ver tu agente cuando alguien te pregunta?',
  '  1) Solo esta carpeta (recomendado)',
  '  2) Esta carpeta y otras que elijas',
  '  3) Toda tu carpeta personal, menos la caja fuerte',
]

type ScopeChoice = 1 | 2 | 3

function scopeNumber(scope: ResponderScope): ScopeChoice {
  return scope.kind === 'folder' ? 1 : scope.kind === 'folders' ? 2 : 3
}

function parseScopeChoice(raw: string, onEnter: ScopeChoice): ScopeChoice | null {
  const v = raw.trim()
  if (v === '') return onEnter
  if (v === '1') return 1
  if (v === '2') return 2
  if (v === '3') return 3
  return null
}

// The summary line lives in responder-config.ts, so `responder` and `doctor` name the mode in the
// very words `setup` used — re-exported here for the callers that already import it from setup.
export { scopeSummary }

// Says exactly what is shut and, in the same breath, what is not (task 2 review, I2). An earlier
// wording said "tus archivos de llaves siguen cerrados", while only six file kinds are denied: an
// `id_rsa` or a `credentials.json` in a chosen folder stays readable once CONFIRMAR is typed. A
// reassurance that is not true is worse than none, because the person relies on it.
const EXTRA_FOLDERS_EXPLANATION_ES = [
  'Dime las otras carpetas que tu agente puede leer, una por una.',
  'Cuando termines, deja la respuesta vacía y presiona Enter.',
  'Dentro de esas carpetas siguen cerrados los archivos .env y los archivos de llaves que terminan en .pem, .key, .p12 o .pfx.',
  'Cualquier otro archivo sí se puede leer, aunque guarde una clave: por ejemplo un id_rsa, un credentials.json o una contraseña escrita en un documento.',
].join('\n')

// Mode 3 says, before the confirmation, the one thing a person must understand to answer it: that
// it is not "what I mean to share" but every file in the personal folder, for anyone they let ask.
// The caja fuerte is named in everyday words — nobody who does not program knows what `~/.ssh` is,
// and they do not need to. It is also named as what it is, the best-known places, followed by
// what it does not reach: the first wording promised "tus contraseñas y llaves" were shut, and a
// `contraseñas.docx`, saved mail and chats, or a cloud tool's token file are all readable (task 2
// review, I2). This is the consent screen for the widest mode; its reassurance has to be as exact
// as its warning.
function homeExplanation(home: string): string {
  return [
    `Con esta opción, tu agente puede leer cualquier archivo de tu carpeta personal (${home}):`,
    'tus documentos, tus fotos, tus proyectos, todo lo que tengas ahí.',
    '',
    'Lo que sigue cerrado siempre — la "caja fuerte", que nadie puede abrir, ni tú desde aquí:',
    '  - tu llave de AgentBridge',
    '  - tu Claude de todos los días: tu sesión y todas tus conversaciones',
    '  - los lugares más conocidos donde se guardan contraseñas y llaves: las del navegador, las de tu llavero y las que dan acceso a servidores y a la nube',
    '  - tus archivos .env, donde los programas guardan sus contraseñas',
    'Los archivos del sistema, fuera de tu carpeta personal, también siguen cerrados.',
    '',
    'La caja fuerte no lo cubre todo. Si tienes una contraseña escrita en un documento, correos o chats',
    'guardados en tu computadora, o un archivo de llaves con un nombre poco común, tu agente sí puede leerlos.',
    '',
    'Importante: cualquier persona a la que le des permiso de preguntarte puede preguntar por',
    'cualquier otro archivo de tu carpeta personal, y tu agente se lo va a leer. No solo lo que tú',
    'pensabas compartir: cualquier archivo que no esté en la caja fuerte.',
    '',
    `Si estás de acuerdo, escribe ${CONFIRM_WORD}. Cualquier otra respuesta deja solo esta carpeta (opción 1).`,
  ].join('\n')
}

// The directory entries of the caja fuerte (`Read(~/<dir>/**)`), as real paths. Read from the list
// itself rather than kept as a second copy here: task 1 grew that list in review, and a copy would
// have silently missed every entry added after it was made.
function cajaFuerteDirs(homeReal: string): string[] {
  const dirs: string[] = []
  for (const rule of CAJA_FUERTE_HOME) {
    const m = /^Read\(~\/([^*]+)\/\*\*\)$/.exec(rule)
    if (m?.[1]) dirs.push(join(homeReal, m[1]))
  }
  return dirs
}

type ScopeInterview = {
  prompt: Prompt
  out: Output
  shareDir: string
  identityHome: string
  profileHome: string
  // The personal folder: what mode 3 opens and what the `~/…` rules are anchored to.
  home: string
  platform: NodeJS.Platform
  saved: ResponderScope | null
}

// Whether this machine can enforce a scope, in task 1's own words. The writer itself decides —
// the same function setupResponder calls — so the question can never accept a scope the write
// would then refuse, which would end the interview with the folder already chosen and nothing
// saved. It refuses mode 2 on Windows, mode 3 on Windows when a protected folder lies outside
// the personal folder, and any path with a glob character.
function unenforceable(scope: ResponderScope, paths: ScopePaths): string | null {
  try {
    responderSettings(scope, paths)
    return null
  } catch (err) {
    if (err instanceof CliError) return err.message
    throw err
  }
}

async function chooseScope(o: ScopeInterview): Promise<ResponderScope> {
  const paths: ScopePaths = {
    shareDir: resolve(o.shareDir),
    identityHome: resolve(o.identityHome),
    profileHome: resolve(o.profileHome),
    home: o.home,
    platform: o.platform,
  }
  const onEnter = o.saved ? scopeNumber(o.saved) : 1
  const enterHint = onEnter === 1 ? 'Enter para la 1' : `Enter para dejar la ${onEnter}, la que tienes ahora`
  const question = [...SCOPE_QUESTION_LINES, `Escribe 1, 2 o 3 (${enterHint}): `].join('\n')
  let lastWasBlocked = false
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await o.prompt(question)
    const choice = parseScopeChoice(raw, onEnter)
    if (choice === null) {
      lastWasBlocked = false
      o.out.log(`No entendí "${raw.trim()}". Escribe 1, 2 o 3.`)
      continue
    }
    if (choice === 1) return { kind: 'folder' }
    // Checked before anything else is asked: on Windows there is no point collecting folders the
    // write would refuse, and a refusal here must lead back to the question, not out of setup.
    const blocked = unenforceable(choice === 2 ? { kind: 'folders', extra: [] } : { kind: 'home' }, paths)
    if (blocked) {
      lastWasBlocked = true
      o.out.log(blocked)
      o.out.log('Elige otra opción.')
      continue
    }
    if (choice === 3) return confirmHome(o)
    const previous = o.saved?.kind === 'folders' ? o.saved.extra : []
    const extra = await chooseExtraFolders(o, paths, previous)
    if (extra.length > 0) return { kind: 'folders', extra }
    o.out.log('No añadiste ninguna carpeta, así que tu agente solo va a ver esta carpeta (opción 1).')
    return { kind: 'folder' }
  }
  // Falls back instead of ending the interview, and always to one folder — never to the saved
  // scope: "keep what they had" would restore a saved mode 3 without the typed confirmation.
  // A choice that was understood but is unavailable here is not "no entendí" (review, M2).
  o.out.log(
    lastWasBlocked
      ? `Esa opción no se puede usar en esta computadora, así que dejo solo esta carpeta (opción 1). Para cambiarlo, vuelve a correr: ${CLI_COMMAND} setup`
      : `No entendí qué opción querías, así que dejo solo esta carpeta (opción 1). Para cambiarlo, vuelve a correr: ${CLI_COMMAND} setup`,
  )
  return { kind: 'folder' }
}

// One attempt, not three: the brief says anything but the word falls back, and here the fallback
// is the safe answer — unlike the shared-folder gate, where a miss ends the interview.
async function confirmHome(o: ScopeInterview): Promise<ResponderScope> {
  o.out.log('')
  o.out.log(homeExplanation(o.home))
  const raw = await o.prompt(`Escribe ${CONFIRM_WORD} para continuar: `)
  if (parseConfirmation(raw)) {
    // A way back, said at the moment of choosing, so CONFIRMAR does not read as final (review, M10).
    o.out.log(`Si cambias de opinión, vuelve a correr "${CLI_COMMAND} setup" y elige la opción 1.`)
    return { kind: 'home' }
  }
  o.out.log(`No escribiste ${CONFIRM_WORD}, así que dejo solo esta carpeta (opción 1).`)
  return { kind: 'folder' }
}

async function chooseExtraFolders(o: ScopeInterview, paths: ScopePaths, previous: readonly string[]): Promise<string[]> {
  let chosen: string[] = []
  const accept = (dir: string, replaces: readonly string[]): void => {
    chosen = [...chosen.filter((c) => !replaces.includes(c)), dir]
    for (const c of replaces) o.out.log(`Quité de la lista ${c}: está dentro de esta, así que tu agente la sigue viendo.`)
  }
  o.out.log('')
  o.out.log(EXTRA_FOLDERS_EXPLANATION_ES)
  if (previous.length > 0) {
    o.out.log('La vez pasada elegiste además estas carpetas:')
    for (const dir of previous) o.out.log(`  - ${dir}`)
    const keep = await askWithRetries(
      o.prompt,
      o.out,
      '¿Las dejo? [S/n]: ',
      parseProceedOrRetry,
      'Escribe s (sí), n (no), o solo Enter para dejarlas.',
      'No entendí tu respuesta.',
    ).catch((err: unknown) => {
      // Only the give-up: a closed input must still reach runSetup as a closed input.
      if (err instanceof CliError) return false
      throw err
    })
    // Kept folders go through every check again: since the last run one may have gained a `.git`
    // or a key file, or moved inside something the caja fuerte closes. Each is named before its
    // checks run: a re-run once printed "no existe" and "Escribe CONFIRMAR para añadirla" under a
    // list of three folders, and the person could not tell which one either sentence was about
    // (task 2 review, I1).
    if (keep) {
      for (const dir of previous) {
        o.out.log(`Carpeta: ${dir}`)
        const verdict = await considerExtraFolder(o, paths, dir, chosen)
        if (verdict.ok) {
          accept(dir, verdict.replaces)
          o.out.log('Sigue en la lista.')
        }
      }
    }
  }
  let refusedInARow = 0
  for (;;) {
    const raw = (await o.prompt('Otra carpeta que tu agente pueda leer (Enter para terminar): ')).trim()
    if (!raw) break
    const dir = resolve(expandUserPath(raw, o.platform))
    o.out.log(`Carpeta: ${dir}`)
    const verdict = await considerExtraFolder(o, paths, dir, chosen)
    if (verdict.ok) {
      accept(dir, verdict.replaces)
      refusedInARow = 0
      o.out.log('Añadida.')
      continue
    }
    refusedInARow++
    // Bounded like the folder question, but ending in what was already chosen rather than in an
    // error: every folder in `chosen` passed every check.
    if (refusedInARow >= MAX_FOLDER_ATTEMPTS) {
      o.out.log('Sigo con las carpetas que ya elegiste.')
      break
    }
    o.out.log('Dime otra, o presiona Enter para terminar.')
  }
  return chosen
}

// `replaces`: folders already on the list that sit inside this one. Adding the parent takes them
// off, since it covers them — the alternative, refusing the parent with a sentence that named the
// child, left the person with no way to widen the list but a re-run (task 2 review, M4).
type ExtraVerdict = { ok: true; replaces: string[] } | { ok: false }

// Every check one extra folder has to pass, each refusal with its own reason and none of them
// ending the interview. The order matters only for which reason is said: the cheap string checks
// run before anything touches the disk.
async function considerExtraFolder(o: ScopeInterview, paths: ScopePaths, dir: string, chosen: readonly string[]): Promise<ExtraVerdict> {
  const refuse = (reason: string): ExtraVerdict => {
    o.out.log(reason)
    return { ok: false }
  }
  const [dirReal, homeReal, shareReal, identityReal, profileReal] = await Promise.all([
    resolveComparablePath(dir),
    resolveComparablePath(paths.home),
    resolveComparablePath(paths.shareDir),
    resolveComparablePath(paths.identityHome),
    resolveComparablePath(paths.profileHome),
  ])
  // Ruling 1 of task 1: the caja fuerte holds in mode 2 as well, so a folder inside it would be
  // added and then be entirely unreadable — `~/.ssh` chosen as an extra folder is exactly the
  // hole that ruling closed. Refused here, with the reason, rather than accepted as a folder that
  // silently shows nothing. Compared without regard to case: on a Mac `~/.SSH` IS `~/.ssh`, and
  // Claude denies it either way (verificaciones.md, V10–V13).
  const lower = dirReal.toLowerCase()
  const closed = [...cajaFuerteDirs(homeReal), identityReal, profileReal]
  if (closed.some((c) => isSameOrWithin(lower, c.toLowerCase()))) {
    return refuse(
      'No puedo añadir esa carpeta: está dentro de la caja fuerte (tu llave de AgentBridge, tu Claude de todos los días o uno de los lugares más conocidos donde se guardan contraseñas y llaves). Tu agente no podría leer nada de ahí, así que no tiene caso añadirla.',
    )
  }
  if (isSameOrWithin(homeReal, dirReal)) {
    return refuse(
      'No puedo añadir esa carpeta: es tu carpeta personal, o la contiene. Si quieres que tu agente vea toda tu carpeta personal, elige la opción 3: toda tu carpeta personal, menos la caja fuerte.',
    )
  }
  // How this folder relates to the ones already on the list, said about the folder just typed.
  const chosenReal = await Promise.all(chosen.map((d) => resolveComparablePath(d)))
  const replaces: string[] = []
  for (const [i, c] of chosen.entries()) {
    const cReal = chosenReal[i] ?? c
    if (cReal === dirReal) return refuse('No puedo añadir esa carpeta: ya está en la lista.')
    if (isSameOrWithin(dirReal, cReal)) {
      return refuse(`No puedo añadir esa carpeta: está dentro de ${c}, que ya añadiste, así que tu agente ya puede leerla.`)
    }
    if (isSameOrWithin(cReal, dirReal)) replaces.push(c)
  }
  const kept = chosen.filter((c) => !replaces.includes(c))
  const keptReal = chosenReal.filter((_, i) => !replaces.includes(chosen[i] ?? ''))
  // A glob character in the name: task 1's writer refuses it, in its own sentence.
  const blocked = unenforceable({ kind: 'folders', extra: [...kept, dir] }, paths)
  if (blocked) return refuse(blocked)
  const problem = scopeProblem(
    { kind: 'folders', extra: [...keptReal, dirReal] },
    { shareDir: shareReal, identityHome: identityReal, profileHome: profileReal },
  )
  if (problem) {
    // Judged on real paths (a `/tmp` that is really `/private/tmp` must not slip past), but said
    // with the paths the person typed: a sentence naming a folder they never mentioned reads as
    // a different folder.
    const typed = [...kept, dir]
    const real = [...keptReal, dirReal]
    const order = real.map((_, i) => i).sort((x, y) => (real[y] ?? '').length - (real[x] ?? '').length)
    let said = problem
    for (const i of order) said = said.replaceAll(real[i] ?? '', typed[i] ?? '')
    return refuse(`No puedo añadir esa carpeta: ${said}.`)
  }
  // The same gate the shared folder went through: hard refusals refuse, danger reasons ask.
  const assessment = await assessShareDir(dir, { identityHome: paths.identityHome, profileHome: paths.profileHome })
  const hard = hardRefusal(assessment)
  if (hard) return refuse(hard)
  // Unlike the shared folder, nothing creates an extra folder: it is one of the person's own,
  // and a missing one would be a readable directory that does not exist.
  if (!assessment.exists) {
    return refuse('No puedo añadir esa carpeta: no existe. Las carpetas extra tienen que existir ya: son carpetas tuyas que quieres que tu agente pueda leer.')
  }
  if (assessment.reasons.length === 0) return { ok: true, replaces }
  o.out.log('Ojo: esa carpeta se ve peligrosa para compartir —')
  for (const reason of assessment.reasons) o.out.log(`  - ${reason}`)
  o.out.log(`Si de verdad quieres añadirla, escribe exactamente ${CONFIRM_WORD}. Cualquier otra respuesta la deja fuera.`)
  if (parseConfirmation(await o.prompt(`Escribe ${CONFIRM_WORD} para añadirla: `))) return { ok: true, replaces }
  o.out.log('No la añadí.')
  return { ok: false }
}

// doctor's own name for the one check this command can fix on the spot instead of merely
// reporting. Matched by name because `Check` carries no identifier of any other kind, and the
// coupling is loud rather than silent: renaming the string in doctor.ts fails four tests in
// `setup.test.ts` (verified in review round 1). Two things that failure would NOT be: subtle, or
// harmless. A rename leaves the stale, pre-login session check inside the blocking list, which
// resurrects exactly the defect fixed below — a person who just logged in successfully being
// told "todavía te falta" and never offered the responder. And it surfaces only in
// `setup.test.ts`, so `npm test -- doctor` alone stays green. If `Check` ever grows a stable id,
// this should move to it.
const SESSION_CHECK_NAME = 'Sesión iniciada en el perfil dedicado'

// How many times this command will open Claude's login before it stops asking. Three is enough
// for the realistic failure (the browser was closed before the login finished, or the wrong
// account was used) without turning a dead end into a loop somebody has to Ctrl+C out of.
const MAX_LOGIN_ATTEMPTS = 3

// Exactly the question `doctor` asks, for exactly the same reason: `claude auth status` exits 0
// whether or not there is a session, so the verdict is the parsed `loggedIn` field and never the
// exit code. Claiming a session that does not exist would send someone to start a responder that
// cannot answer a single question.
async function sessionExists(run: CommandRunner, env: NodeJS.ProcessEnv): Promise<boolean> {
  const status = await run('claude', ['auth', 'status', '--json'], { env, signal: AbortSignal.timeout(15_000) }).catch(() => ({
    code: 127,
    stdout: '',
    stderr: '',
  }))
  try {
    return (JSON.parse(status.stdout) as { loggedIn?: boolean }).loggedIn === true
  } catch {
    // Unparseable output is not a session. Same reading doctor takes.
    return false
  }
}

// Claude's login is a person typing a password into a browser. We cannot do that for them — but
// we CAN open the right Claude, in the right profile, and be there when they come back. What we
// must never do is what 0.2 did: print `CLAUDE_CONFIG_DIR='…' claude` and leave. That line is
// bash; in PowerShell it is a syntax error, and the person who hit it had no way to know that the
// instruction itself was wrong rather than their typing.
export async function loginStep(o: {
  claudeConfigDir: string
  env: NodeJS.ProcessEnv
  out: Output
  prompt: Prompt
  run: CommandRunner
  runInteractive: InteractiveRunner
  alreadyLoggedIn: boolean
}): Promise<boolean> {
  if (o.alreadyLoggedIn) return true
  const env = { ...o.env, CLAUDE_CONFIG_DIR: o.claudeConfigDir }
  // Never "una cuenta aparte": it is the same Claude account, kept in its own folder. Someone who
  // read that as "I need a second account" would stop right here, at the step this whole plan
  // exists to get them through.
  o.out.log('Ahora hay que iniciar sesión en Claude. Queda guardado aparte, solo para contestar preguntas:')
  o.out.log('tu Claude de todos los días no se toca.')
  o.out.log('Te abro el inicio de sesión — se va a abrir tu navegador. Cuando termines, vuelves solo aquí.')
  // Retried here, in place, rather than by sending the person back through the whole interview.
  // Closing the browser before the login finishes is the single most likely first-run outcome,
  // and "vuelve a correr setup" for it is both lazy (the program is standing right here, it can
  // just open it again) and, until the folder default below started reading responder.json,
  // actively dangerous — see the comment on `defaultShare` in the answering branch.
  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    // Enter, not a yes/no: there is no "no" that leads anywhere — without a session there is
    // nothing to answer with. A question with one real answer should not be asked as if it had two.
    await o.prompt(attempt === 1 ? 'Presiona Enter para abrirlo: ' : 'Presiona Enter para abrirlo otra vez: ')
    // `claude auth login`, not a bare `claude`. Claude Code ships a dedicated login subcommand that
    // does one thing and exits; opening the whole interface instead would mean teaching the person
    // two slash commands (`/login` to start it, `/exit` to come back) — which is the very habit this
    // plan exists to end. One command, no instructions to remember.
    const opened = await o.runInteractive('claude', ['auth', 'login'], { env })
    if (opened.spawnFailed) {
      // Not a bare "no está instalado": a missing binary and one that is installed but absent from
      // this terminal's PATH arrive as the very same Node error, and only one of them is fixed by
      // installing anything — the same distinction `responder` already makes for its own spawn.
      // No retry either: opening it again cannot install it.
      o.out.log(
        `No pude abrir Claude Code: puede que no esté instalado, o que sí lo esté pero no aparezca en esta terminal. Instálalo desde claude.com/claude-code (o cierra y vuelve a abrir la terminal) y vuelve a correr: ${CLI_COMMAND} setup`,
      )
      return false
    }
    if (await sessionExists(o.run, env)) {
      o.out.log('Listo: la sesión quedó iniciada.')
      return true
    }
    if (attempt === MAX_LOGIN_ATTEMPTS) break
    o.out.log('La sesión no quedó iniciada. A veces pasa: se cierra el navegador antes de terminar, o se usa otra cuenta.')
    const again = await askWithRetries(
      o.prompt,
      o.out,
      '¿Lo intentamos otra vez? [s/n]: ',
      parseYesNo,
      'Escribe s (sí) o n (no).',
      'No entendí tu respuesta.',
    ).catch(() => false)
    if (!again) break
  }
  // Only now, after the retries: the re-run is safe (the folder question proposes the folder
  // already saved in responder.json, so pressing Enter cannot repoint a working responder at an
  // empty one), and everything else this command did is already on disk.
  o.out.log('Lo dejamos por ahora: sin la sesión iniciada todavía no puedes contestar preguntas.')
  o.out.log(`Cuando quieras intentarlo otra vez: ${CLI_COMMAND} setup — no vas a perder nada de lo que ya quedó listo.`)
  return false
}

// The failing checks that actually stop this person from answering questions. Used for one
// decision only — whether there is any point offering to start the responder.
export function blockers(checks: readonly Check[]): Check[] {
  return checks.filter((c) => !c.ok && c.blocking)
}

// What `setup` says out loud: everything that blocks, PLUS everything whose failure is about the
// safety of the key or the shared folder even when it does not block. Those two are not the same
// set, and the difference is the whole point: "tu llave está dentro de OneDrive, así que se sube
// sola a la nube" blocks nothing at all — the install works perfectly — and it is the single most
// serious sentence this program can say. Filtering the install's own report by `blocking` alone
// silenced exactly it, at the one moment the person is still choosing which folder to use.
// A board down out of five stays hidden, as intended: it is weather, and `doctor` still prints it.
export function mustMention(checks: readonly Check[]): Check[] {
  return checks.filter((c) => !c.ok && (c.blocking || c.security))
}

// Printed right before the responder takes over the terminal, because after that the only thing
// on screen is Claude — and the person will scroll up to here when they want to stop and come
// back tomorrow. Two things travel in rather than being hard-coded. `responderLine`: on a
// non-default --profile a bare `responder` would start a different (empty) profile than the one
// just prepared. `hasPending`: "Ya quedó" is only true of a run with nothing left, and on role 3
// there is almost always something left — the asking side always ends with "reinicia tu sesión de
// Claude Code". Printing "Ya quedó" four lines under "Te falta:" and then taking the terminal
// away told the person both that they were finished and that they still owed two things they
// could now only do by killing the session they had just been told to leave open.
function summaryBeforeStart(responderLine: string, hasPending: boolean): string {
  return [
    hasPending
      ? 'Empiezo a contestar. Lo que te falta (arriba) lo puedes hacer cuando pares con Ctrl+C.'
      : 'Ya quedó. A partir de aquí:',
    `  - Para ver quién te pidió permiso:   ${CLI_COMMAND} requests`,
    `  - Para revisar que todo siga bien:   ${CLI_COMMAND} doctor`,
    `  - Para volver a contestar mañana:    ${responderLine}`,
  ].join('\n')
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
  // Filled in by the answering branch; read after the verdict, which is the only place from which
  // starting the responder cannot swallow a step that has not run yet.
  let canStartResponder = false
  let responderProfileHome: string | null = null
  let responderStartLine = `${CLI_COMMAND} responder`

  // 3. Answering side
  if (willAnswer) {
    out.log(SHARE_FOLDER_EXPLANATION_ES)
    out.log('')
    const repoDir = ctx.repoDir ? resolve(ctx.repoDir) : await repoDirFromBundleLocation(import.meta.url)
    const profileHome = ctx.profileHome ? resolve(ctx.profileHome) : join(homedir(), '.agentbridge-responder')

    // The folder this computer is ALREADY sharing, when there is one, rather than a hard-coded
    // default. This file's own comment on `applyRelays` documents what the hard-coded version
    // cost: someone re-running `setup` pressed Enter at this question — the answer the quick
    // start's own worked example models as normal — and silently repointed a working responder at
    // a brand-new, empty `~/AgentBridge/compartido`, with no error anywhere. Every remedy this
    // command prints now says "vuelve a correr setup", so that trap was about to become the
    // standard route rather than an edge case.
    const saved = await readResponderConfig(profileHome).catch(() => null)
    const defaultShare = saved?.shareDir ?? join(homedir(), 'AgentBridge', 'compartido')

    const platform = ctx.platform ?? process.platform
    const personalHome = ctx.personalHome ?? homedir()
    const { shareDir, assessment } = await chooseShareDir({
      prompt,
      out,
      platform,
      defaultShare,
      assess: (dir) => assessShareDir(dir, { identityHome: ctx.home, profileHome }),
    })

    if (assessment.reasons.length > 0) {
      out.log('Ojo: esa carpeta se ve peligrosa para compartir —')
      for (const reason of assessment.reasons) out.log(`  - ${reason}`)
      // Says what actually happens. It used to promise "Cualquier otra respuesta cancela." and
      // then ask twice more — verified: typing "no" got "No entendí «no»…" twice before it
      // finally cancelled. The person most likely to type "no" here is the person this gate
      // exists for, and telling them the run is over when it is not is the same defect this
      // whole branch is about (whole-branch review, Minor 1).
      out.log(
        `Si de verdad quieres usarla de todos modos, escribe exactamente ${CONFIRM_WORD} (mayúsculas o minúsculas da igual). Si escribes otra cosa te lo vuelvo a preguntar, y si aun así no escribes ${CONFIRM_WORD}, no toco nada.`,
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

    const scope = await chooseScope({
      prompt,
      out,
      shareDir,
      identityHome: ctx.home,
      profileHome,
      home: personalHome,
      platform,
      // Only a saved scope for this same profile; an unreadable file proposes one folder.
      saved: saved?.scope ?? null,
    })
    out.log(scopeSummary(scope))
    out.log('')

    let setupResult: Awaited<ReturnType<typeof setupResponder>>
    try {
      setupResult = await setupResponder({
        shareDir,
        repoDir,
        profileHome,
        identityHome: ctx.home,
        run: ctx.run,
        out,
        printNextSteps: false,
        scope,
        platform,
        home: personalHome,
      })
    } catch (err) {
      if (err instanceof CliError) throw err
      // describeFsError names the kind of filesystem problem (permissions, missing path) without
      // echoing an arbitrary error message, which can carry paths this text must not carry.
      throw new CliError(
        `No pude preparar la carpeta compartida o el perfil dedicado: ${describeFsError(err)}. No se completó la instalación; revisa la ruta y vuelve a correr "${CLI_COMMAND} setup".`,
      )
    }
    out.log('')

    // Said in words, not as a list of check names: this runs for a few seconds (it really does
    // publish to and read back from every board), and silence here reads as a hang.
    out.log('Reviso que todo esté listo…')
    const checks = await runDoctor({
      identityHome: ctx.home,
      profileHome,
      shareDir,
      repoDir,
      run: ctx.run,
      createSocket: ctx.createSocket,
      relayPolicy: ctx.relayPolicy,
    })

    const alreadyLoggedIn = checks.some((c) => c.name === SESSION_CHECK_NAME && c.ok)
    const loggedIn = await loginStep({
      claudeConfigDir: setupResult.claudeConfigDir,
      env: ctx.env,
      out,
      prompt,
      run: ctx.run,
      runInteractive: ctx.runInteractive,
      alreadyLoggedIn,
    })
    // Only when the login step actually said something: an already-logged-in profile prints
    // nothing at all there, and an unconditional blank line left a stray gap under "Reviso que
    // todo esté listo…".
    if (!alreadyLoggedIn) out.log('')

    // Everything that blocks or is about the safety of the key, said once, in the words of
    // whoever wrote the check — and nothing else. `doctor` still prints all of it, and the last
    // line of this command says where to find it.
    // The session check is dropped from this list for two reasons at once: `loginStep` has just
    // spoken about it in far better words, and the check itself was taken BEFORE the login ran,
    // so by now it is stale — reading it here would report "no has iniciado sesión" to someone
    // who just did, and (worse, below) would refuse to start a responder that works perfectly.
    const toSay = mustMention(checks).filter((c) => c.name !== SESSION_CHECK_NAME)
    // Deliberately `blockers`, not `toSay.filter(...)`: the two lists answer two different
    // questions, and only this one may decide whether there is any point offering to start the
    // responder. A key inside OneDrive must be said out loud AND must not stop anything.
    const stillBlocking = blockers(checks).filter((c) => c.name !== SESSION_CHECK_NAME)
    // Two different sentences, because these are two different things: one stops them from
    // answering at all, the other is a machine that works fine and a key that is not safe.
    for (const c of toSay) out.log(`${c.blocking ? 'Falta algo' : 'Ojo'}: ${c.detail}`)
    if (toSay.length > 0) out.log('')

    const copied = await (ctx.copyLink ?? copyToClipboard)(myLink)
    out.log(copied ? 'Tu enlace — ya lo copié al portapapeles:' : 'Tu enlace:')
    out.log(`  ${myLink}`)
    out.log('Dáselo a quien quieras que pueda preguntarte. Cuando te manden una solicitud, la ves con:')
    out.log(`  ${CLI_COMMAND} requests`)
    out.log('')

    // NOT started here. Starting the responder occupies the terminal until Ctrl+C, and this is
    // section 3 of five: someone who answered "3" (both sides) still has the asking side ahead of
    // them — the link they paste, `connect`, the MCP registration. Starting here would silently
    // skip all of it and they would never know what they did not get. The offer happens after the
    // verdict, as the very last thing this command does.
    canStartResponder = loggedIn && stillBlocking.length === 0
    responderProfileHome = profileHome
    // A non-default --profile has to be named, or the printed command would start the wrong
    // (default, empty) profile. Printed PLAIN, never quoted: POSIX single quotes are not quotes
    // to cmd.exe, so wrapping a Windows path in them breaks a whole platform to serve the rarer
    // case of a profile path with a space in it (review round 1, Important 4).
    if (profileHome !== join(homedir(), '.agentbridge-responder')) responderStartLine = `${CLI_COMMAND} responder --profile ${profileHome}`
    // Never "listo para contestar" while something still blocks answering: that is the sentence
    // the person reads to decide whether they are done.
    done.push(canStartResponder ? 'Listo para contestar desde esta computadora.' : 'Dejé preparados la carpeta compartida y el perfil dedicado.')
    done.push(scopeSummary(scope))
    // The summary is the part people scroll back to, so it has to carry its own subject. It used
    // to say only "Cuando esté resuelto, empieza a contestar con: …" — a sentence whose "esto"
    // had been named eight lines earlier and was gone from the screen by then.
    if (!loggedIn) pending.push(`Iniciar sesión en Claude. Cuando quieras intentarlo otra vez: ${CLI_COMMAND} setup`)
    for (const c of toSay) pending.push(c.detail)
    if (!canStartResponder) pending.push(`Después, para empezar a contestar: ${responderStartLine}`)
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
      try {
        await connectWith(link, ctx)
        // Deliberately not "I sent your request": `connect` also returns normally when the contact was
        // already approved and when every board refused the publication, and claiming a send that did
        // not happen is how a person ends up waiting for an answer that was never coming. What it
        // printed is what actually happened; this line only says where to look next.
        pending.push(`Revisa cómo va: ${CLI_COMMAND} contacts`)
      } catch (err) {
        // Wrapped for the same reason the MCP question below is: one mistyped answer must not
        // throw away work that already succeeded. `askWithRetries(parseNonEmpty)` only checks the
        // string is non-empty, so a truncated or line-wrapped paste reaches `decodeLink` and
        // throws — and on role 3 that used to discard the verdict, the whole pending list and the
        // offer to start answering, AFTER the folder, the profile and the browser login had all
        // worked. Only the two error types whose messages are written to be read by this person
        // are caught (CliError here, UserFacingError from core); anything else is a real fault and
        // must not be swallowed behind a reassuring sentence.
        if (!(err instanceof CliError || err instanceof UserFacingError)) throw err
        out.log(err.message)
        out.log('No se perdió nada de lo demás: lo que ya quedó listo sigue guardado en esta computadora.')
        pending.push(`Conéctate con quien vayas a preguntar: ${CLI_COMMAND} connect <enlace>`)
      }
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
      // Bounded like every other `claude` spawn this branch added (`auth status` gets the same 15 s,
      // the clipboard 3 s): this one writes a line into a config file, so anything longer than that
      // is a wedge, and an unbounded spawn here leaves `setup` frozen with no way to know which
      // step stalled. `defaultRunner` hands the signal to `spawn` itself — Node's own kill-on-abort,
      // not a promise race that leaves the real process alive — and reports 124 when it fires.
      const result = await ctx.run('claude', ['mcp', 'add', 'agentbridge', '--scope', 'user', ...envArgs, '--', ...CLI_ARGV, 'mcp'], {
        env: ctx.env,
        signal: AbortSignal.timeout(15_000),
      })
      if (result.code === 0) {
        mcpRegistered = true
        out.log('Listo: el servidor MCP quedó registrado.')
      } else if (result.code === 124) {
        out.log('No pude registrar el servidor MCP automáticamente: el comando claude no respondió en 15 segundos. Hazlo a mano:')
        out.log(`  ${manual}`)
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
  for (const d of done) out.log(`  ✓ ${d}`)
  if (pending.length > 0) {
    out.log('Te falta:')
    for (const p of pending) out.log(`  - ${p}`)
  }
  out.log('')
  // `doctor` named exactly once, at the end, instead of its seventeen lines printed in the middle.
  // Not "si algo no funciona": the most serious thing doctor can report — a secret key sitting in
  // a folder that syncs to somebody else's servers — happens on a machine where everything works,
  // and a pointer conditioned on breakage tells that person the report is not for them.
  out.log(`Para revisar todo con detalle cuando quieras: ${CLI_COMMAND} doctor`)

  // The last thing, after every branch has run and the verdict has been printed. Offered, not
  // ordered, and only when it can actually work: asking someone to start a responder with no
  // session would hand them a failure as the last thing they see.
  if (canStartResponder && responderProfileHome) {
    // Said BEFORE the question, not after it: "sí" hands this terminal to Claude until Ctrl+C,
    // and someone who does not already know that cannot answer the question meaningfully.
    out.log('Si dices que sí, esta terminal se queda contestando hasta que la pares con Ctrl+C.')
    // Said before the question too, and not only at the handover: someone who says "sí" without
    // knowing this meets Claude's own first-run wizard instead of an agent waiting for questions,
    // and reads it as the install having gone wrong. The login is already done by the time this
    // offer exists (canStartResponder requires it), so the only one left is the theme picker —
    // naming the one they will actually see rather than both.
    out.log('La primera vez, Claude te pregunta primero su tema de colores; lo contestas y ya se queda esperando preguntas.')
    // The only question in this whole flow whose closed input is swallowed rather than reported.
    // Everywhere else a PromptEOF means answers are still missing and the run is incomplete; here
    // everything already succeeded and the only thing left is an offer, so ending on
    // "se cerró la entrada" would turn a finished setup into an error message.
    const startNow = await askWithRetries(
      prompt,
      out,
      '¿Empiezo a contestar ahora? [s/n]: ',
      parseYesNo,
      'Escribe s (sí) o n (no).',
      `No entendí tu respuesta. Cuando quieras empezar: ${responderStartLine}`,
    ).catch(() => false)
    if (!startNow) {
      out.log(`Cuando quieras empezar a contestar: ${responderStartLine}`)
      return
    }
    out.log('')
    out.log(summaryBeforeStart(responderStartLine, pending.length > 0))
    // Occupies the terminal until Ctrl+C. Nothing may follow it.
    // Both of its failure shapes are reported the same way, on purpose: everything this command
    // was asked to do already worked, and ending a finished setup with "Error:" would read as if
    // the setup itself had failed. `runResponder` throws only when `claude` cannot be spawned at
    // all — its message is already a finished Spanish sentence — and returns a non-zero code when
    // it ran and failed. Ctrl+C, which is how a person stops this, already comes back as 0.
    try {
      const code = await runResponder({ profileHome: responderProfileHome, env: ctx.env, out, runInteractive: ctx.runInteractive })
      if (code !== 0) out.log(`Claude Code terminó con código ${code}. Si te vuelve a pasar: ${CLI_COMMAND} doctor`)
    } catch (err) {
      if (!(err instanceof CliError)) throw err
      out.log(err.message)
    }
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
  await runSetup({
    ...ctx,
    prompt: ctx.prompt,
    run: defaultRunner,
    runInteractive: defaultInteractiveRunner,
    repoDir: values.repo,
    profileHome: values.profile,
  })
}
