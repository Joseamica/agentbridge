import { writeConfig } from '@agentbridge/core'
import type { Dirent } from 'node:fs'
import { access, lstat, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { CliError, PromptEOF, requireConfig, tryReadConfig, type CliContext, type Output, type Prompt } from '../context'
import { isSameOrWithin, resolveComparablePath } from '../fs-paths'
import { describeFsError } from '../spanish-errors'
import { enroll } from './account'
import { projectConfigArtifacts, runDoctor } from './doctor'
import { defaultRunner, repoDirFromBundleLocation, setupResponder, type CommandRunner } from './setup-responder'

// The guided flow needs two extra things the plain CliContext does not carry: something to
// drive prompts with (real readline in production, a scripted queue in tests — see
// context.ts's `Prompt` type) and a CommandRunner to hand to setupResponder/doctor and to the
// `claude mcp add` step, so every subprocess spawn in this whole command goes through the same
// injectable seam the rest of the CLI already tests with. `repoDir` and `responderHome` are
// optional overrides: setupCommand fills them from --repo/--responder-home (or the same
// defaults setup-responder and doctor use); tests always pass explicit temp directories so
// nothing here ever touches a real ~/.agentbridge-responder or a real Claude Code checkout.
export type SetupContext = CliContext & {
  prompt: Prompt
  run: CommandRunner
  repoDir?: string
  responderHome?: string
}

export const NON_INTERACTIVE_ES = [
  'agentbridge setup necesita una terminal interactiva para hacerte preguntas, y esta no lo es',
  '(por ejemplo, se está corriendo dentro de un script, con la entrada redirigida, o en CI).',
  '',
  'Corre el equivalente a mano, en este orden:',
  '  AGENTBRIDGE_HOME=~/.agentbridge-responder agentbridge enroll <tu enlace de alta>',
  '  agentbridge setup-responder --share <carpeta compartida> --home ~/.agentbridge-responder',
  '  agentbridge doctor --home ~/.agentbridge-responder --share <carpeta compartida>',
  '  AGENTBRIDGE_HOME=~/.agentbridge-responder agentbridge invite',
  '  claude mcp add agentbridge --scope user -- npx -y agentbridge@latest mcp',
  '',
  'O sigue la guía completa: docs/inicio-rapido.md',
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
function expandUserPath(raw: string): string {
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
  throw new CliError('No pude confirmar una carpeta para compartir después de 3 intentos. Vuelve a correr "agentbridge setup".')
}

// Patterns a fresh, curated share folder should never contain. Matched against bare file
// names anywhere in the tree — good enough to catch the common, careless case (a `.env` copied
// in alongside real files, at any depth) without pretending to be a full secret scanner.
const CREDENTIAL_NAME_PATTERNS = [/^\.env(\..*)?$/, /\.pem$/i, /\.key$/i, /^id_rsa/i, /^credentials/i]

const MAX_SCAN_DEPTH = 6
const MAX_SCAN_ENTRIES = 20000

type ShareDirScan = { gitDirs: string[]; suspiciousFiles: string[]; truncated: boolean }

// Walks the whole tree, not just the top level: a single `readdir()` on the share folder's own
// root let `share/project/.git` and `share/sub/.env` both through with zero warning — the
// single most likely real mistake ("I'll share the folder where my projects live"). Mirrors the
// traversal shape of doctor.ts's walkShareDir (skip node_modules; name a `.git` directory
// instead of descending into it) without needing to also chase escaping symlinks — that is
// doctor's own, separate job. This function never follows a symlink at all (Dirent's
// isDirectory()/isFile() are both false for a symlink), which also means it cannot loop on a
// symlink cycle. Bounded by both depth and total entries visited so a pathologically large or
// deeply nested folder cannot make `setup` hang; hitting either bound is reported back as
// `truncated` so the caller treats "I couldn't finish looking" as a reason to ask for
// confirmation rather than silently declaring the folder clean.
async function scanShareDirForDanger(root: string): Promise<ShareDirScan> {
  const gitDirs: string[] = []
  const suspiciousFiles: string[] = []
  let visited = 0
  let truncated = false

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
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        if (entry.name === '.git') {
          gitDirs.push(entryRel)
          continue
        }
        if (depth >= MAX_SCAN_DEPTH) {
          truncated = true
          continue
        }
        await walk(join(dir, entry.name), entryRel, depth + 1)
      } else if (entry.isFile() && CREDENTIAL_NAME_PATTERNS.some((re) => re.test(entry.name))) {
        suspiciousFiles.push(entryRel)
      }
    }
  }

  await walk(root, '', 0)
  return { gitDirs, suspiciousFiles, truncated }
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
  guard: { identityHome: string; responderHome: string },
): Promise<ShareDirAssessment> {
  const shareDir = resolve(shareDirRaw)
  const [shareReal, homeReal, identityReal, responderReal] = await Promise.all([
    resolveComparablePath(shareDir),
    resolveComparablePath(homedir()),
    resolveComparablePath(guard.identityHome),
    resolveComparablePath(guard.responderHome),
  ])
  const isHome = shareReal === homeReal

  let credentialConflict: string | null = null
  if (isSameOrWithin(identityReal, shareReal)) {
    credentialConflict = `tu identidad de AgentBridge (${guard.identityHome})`
  } else if (isSameOrWithin(responderReal, shareReal)) {
    credentialConflict = `el perfil dedicado del respondedor (${guard.responderHome})`
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
    const projectConfig = await projectConfigArtifacts(shareDir)
    if (projectConfig.length > 0) reasons.push(`ya tiene configuración de proyecto que doctor vigila: ${projectConfig.join(', ')}`)
    if (scan.truncated) {
      reasons.push('la carpeta es muy grande o profunda; no la pude revisar por completo — revísala tú antes de confirmar')
    }
  }
  return { exists, isHome, credentialConflict, problem, reasons }
}

const MCP_YESNO_GIVEUP_ES =
  'No entendí tu respuesta. Puedes registrarlo tú cuando quieras con: claude mcp add agentbridge --scope user -- npx -y agentbridge@latest mcp'

// The public entry point tests and setupCommand call. It's a thin wrapper around
// `runGuidedSetup`: its only job is to turn a `PromptEOF` that escapes the whole flow into the
// same Spanish "needs an interactive terminal" message `setupCommand` already gives when there
// is no prompt at all (see NON_INTERACTIVE_ES) — reached whenever stdin closes or a test's
// scripted answers run out partway through, not just when there was never a prompt to begin
// with. Every other error (a normal CliError from a validation or a give-up message, a relay
// error, …) passes through unchanged.
export async function runSetup(ctx: SetupContext): Promise<void> {
  try {
    await runGuidedSetup(ctx)
  } catch (err) {
    if (err instanceof PromptEOF) {
      throw new CliError(NON_INTERACTIVE_ES)
    }
    throw err
  }
}

async function runGuidedSetup(ctx: SetupContext): Promise<void> {
  const { out, prompt } = ctx

  out.log('AgentBridge — configuración guiada')
  out.log('Te voy a hacer las preguntas necesarias para dejarlo listo. Puedes cancelar con Ctrl+C.')
  out.log('')

  // 1. Identity — reuse enroll's own logic and messages verbatim; never re-derive a device
  // token or re-implement what counts as "already enrolled". This identity lives at ctx.home
  // (this device's default AgentBridge home) regardless of role — see the credential-copy step
  // below for why the responding side still works from the very same, single enrollment link.
  let config = await tryReadConfig(ctx)
  if (!config) {
    out.log('Esta computadora todavía no está dada de alta.')
    out.log('Pide un enlace de alta a quien opere el relay (o créalo tú con: agentbridge admin enroll-link).')
    const link = await askWithRetries(
      prompt,
      out,
      'Enlace de alta: ',
      parseNonEmpty,
      'Necesito el enlace que te mandaron para darte de alta.',
      'No diste un enlace de alta. Vuelve a correr "agentbridge setup" cuando lo tengas, o da de alta a mano: agentbridge enroll <enlace>',
    )
    await enroll([link], ctx)
    config = await requireConfig(ctx)
  } else {
    out.log(`Esta computadora ya está dada de alta como ${config.displayName} (@${config.handle}) en ${config.relayUrl}.`)
  }
  out.log('')

  // 2. Which side
  const role = await askWithRetries(
    prompt,
    out,
    ROLE_QUESTION_ES,
    parseRole,
    'Escribe 1, 2 o 3.',
    'No pude entender qué ibas a hacer. Vuelve a correr "agentbridge setup" y responde 1, 2 o 3.',
  )
  const willAnswer = role === 'responder' || role === 'ambas'
  const willAsk = role === 'preguntar' || role === 'ambas'
  out.log('')

  const done: string[] = [`Identidad: ${config.displayName} (@${config.handle}) en ${config.relayUrl}.`]
  const pending: string[] = []

  // 3. Answering side
  if (willAnswer) {
    out.log(SHARE_FOLDER_EXPLANATION_ES)
    out.log('')
    const defaultShare = join(homedir(), 'AgentBridge', 'compartido')
    const repoDir = ctx.repoDir ? resolve(ctx.repoDir) : await repoDirFromBundleLocation(import.meta.url)
    const responderHome = ctx.responderHome ? resolve(ctx.responderHome) : join(homedir(), '.agentbridge-responder')

    const shareDir = await chooseShareDir(prompt, out, defaultShare)

    const assessment = await assessShareDir(shareDir, { identityHome: ctx.home, responderHome })
    if (assessment.problem) {
      throw new CliError(`No puedo usar ${shareDir}: ${assessment.problem}. Elige otra ruta y vuelve a correr "agentbridge setup".`)
    }
    if (assessment.isHome) {
      throw new CliError(
        `No puedo usar ${shareDir} como carpeta compartida: es tu carpeta de usuario (home) y dejaría visible todo lo que tienes en la computadora. Vuelve a correr "agentbridge setup" con otra carpeta.`,
      )
    }
    if (assessment.credentialConflict) {
      throw new CliError(
        `No puedo usar ${shareDir} como carpeta compartida: ahí dentro está ${assessment.credentialConflict}, que guarda el token del dispositivo — cualquier pregunta podría leerlo y hacerse pasar por ti en el relay. Vuelve a correr "agentbridge setup" con otra carpeta.`,
      )
    }
    if (assessment.reasons.length > 0) {
      out.log(`Ojo: ${shareDir} se ve peligrosa para compartir —`)
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
        `No escribiste "${CONFIRM_WORD}". No se tocó ${shareDir}. Vuelve a correr "agentbridge setup" con otra carpeta si quieres, o confirma esta de nuevo.`,
      )
    }
    // Never create the folder silently: say so before setupResponder does it.
    out.log(assessment.exists ? `Voy a usar la carpeta que ya existe: ${shareDir}` : `${shareDir} no existe todavía; la voy a crear vacía.`)
    out.log('')

    let setupResult: Awaited<ReturnType<typeof setupResponder>>
    try {
      setupResult = await setupResponder({ shareDir, repoDir, home: responderHome, run: ctx.run, out })
    } catch (err) {
      if (err instanceof CliError) throw err
      throw new CliError(
        `No pude preparar la carpeta compartida o el perfil dedicado: ${describeFsError(err)}. No se completó la instalación; revisa la ruta y vuelve a correr "agentbridge setup".`,
      )
    }

    // The dedicated responder session always runs with AGENTBRIDGE_HOME=<responderHome> (see
    // startScript() in setup-responder.ts) — a device enrolled only at ctx.home (this device's
    // default identity, from step 1) would leave that session with no config.json to read, and
    // it exits immediately with "no config". Enrollment codes are single-use, so this person
    // only has the one link; copying the very same device token here — rather than a second
    // enrollment — is what lets a single link produce a responder that actually connects, and
    // is also what lets "both ask and answer" work: the same identity is simply valid from two
    // directories instead of needing two device tokens. Never overwrites a config that is
    // already there for a DIFFERENT identity — that would silently swap out a working
    // responder's credential out from under it.
    const existingResponderConfig = await tryReadConfig({ home: responderHome })
    if (!existingResponderConfig) {
      await writeConfig(config, responderHome)
      out.log(`Copié tu credencial al perfil dedicado (${responderHome}) para que el respondedor pueda conectarse.`)
    } else if (existingResponderConfig.handle !== config.handle) {
      out.log(
        `Ojo: el perfil dedicado (${responderHome}) ya tenía otra identidad (@${existingResponderConfig.handle}); no la reemplacé. Si quieres usar @${config.handle} ahí, hazlo a mano.`,
      )
    }
    out.log('')

    out.log('Verificando con doctor…')
    const checks = await runDoctor({ home: responderHome, shareDir, repoDir, run: ctx.run, fetchImpl: ctx.fetchImpl })
    for (const c of checks) out.log(`${c.ok ? '[ok]    ' : '[falta] '}${c.name}: ${c.detail}`)
    out.log('')

    out.log('Para terminar de dejarlo contestando, en este orden:')
    out.log(`  1. Inicia sesión una vez en el perfil dedicado:  CLAUDE_CONFIG_DIR='${setupResult.claudeConfigDir}' claude   (usa /login y sal)`)
    out.log(`  2. Arráncalo:  ${setupResult.startScriptPath}`)
    out.log('  3. Deja entrar a quien va a preguntarte:  agentbridge invite   (y mándale el enlace que imprime)')
    out.log('')

    // The verdict must reflect what doctor actually found, not just one check picked out of
    // ten — reporting "listo" while doctor had just printed [falta] a few lines above is
    // exactly the bug this replaces. Every failing check's own name and detail (already
    // Spanish, already actionable — see doctor.ts) becomes a pending item verbatim.
    done.push(`Perfil dedicado preparado en ${responderHome}.`)
    for (const c of checks) {
      if (!c.ok) pending.push(`${c.name}: ${c.detail}`)
    }
    pending.push(`Arranca el respondedor: ${setupResult.startScriptPath}`)
    pending.push('Invita a quien va a preguntarte: agentbridge invite')
  }

  // 4. Asking side
  if (willAsk) {
    out.log('Para poder preguntar, alguien tiene que haberte invitado antes. Si ya tienes su enlace, acéptalo con:')
    out.log('  agentbridge accept <enlace de invitación>')
    out.log('(Si no lo tienes, pídeselo — lo consigue con: agentbridge invite)')
    out.log('')
    pending.push('Acepta la invitación de quien vas a preguntar: agentbridge accept <enlace de invitación>')

    out.log('Para preguntar desde tu propio Claude Code hace falta además registrar el servidor MCP de AgentBridge una vez.')
    let wantsMcp: boolean
    try {
      wantsMcp = await askWithRetries(prompt, out, '¿Lo registro ahora? [s/n]: ', parseYesNo, 'Escribe s (sí) o n (no).', MCP_YESNO_GIVEUP_ES)
    } catch (err) {
      // Exhausting this one question must not throw away a verdict for work that may already
      // have succeeded on the responder side (the "ambas" role) — treat it as "no" and keep
      // going, the same graceful landing as if they had typed "n" the first time.
      if (err instanceof CliError && err.message === MCP_YESNO_GIVEUP_ES) {
        out.log('No pude entender tu respuesta después de varios intentos; sigo sin registrar el servidor MCP automáticamente.')
        wantsMcp = false
      } else {
        throw err
      }
    }
    let mcpRegistered = false
    if (wantsMcp) {
      const result = await ctx.run(
        'claude',
        ['mcp', 'add', 'agentbridge', '--scope', 'user', '--', 'npx', '-y', 'agentbridge@latest', 'mcp'],
        { env: ctx.env },
      )
      if (result.code === 0) {
        mcpRegistered = true
        out.log('Listo: el servidor MCP quedó registrado.')
      } else {
        out.log(
          `No pude registrar el servidor MCP automáticamente (${result.stderr || result.stdout || 'sin más detalle'}). Hazlo a mano:`,
        )
        out.log('  claude mcp add agentbridge --scope user -- npx -y agentbridge@latest mcp')
      }
    } else {
      out.log('Está bien. Cuando quieras, corre:')
      out.log('  claude mcp add agentbridge --scope user -- npx -y agentbridge@latest mcp')
    }
    out.log('')
    out.log('Importante: si ya tenías una sesión de Claude Code abierta, ciérrala y ábrela de nuevo — la herramienta nueva')
    out.log('no aparece hasta que reinicias la sesión.')
    out.log('Para preguntar desde la terminal en cualquier momento: agentbridge ask <handle> "<pregunta>"')
    out.log('')

    if (mcpRegistered) {
      done.push('Servidor MCP registrado en Claude Code.')
      pending.push('Reinicia (o abre) tu sesión de Claude Code para que aparezca la herramienta nueva.')
    } else {
      pending.push('Registra el servidor MCP: claude mcp add agentbridge --scope user -- npx -y agentbridge@latest mcp')
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

export async function setupCommand(argv: string[], ctx: CliContext): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { repo: { type: 'string' }, 'responder-home': { type: 'string' } } })
  if (!ctx.prompt) {
    throw new CliError(NON_INTERACTIVE_ES)
  }
  await runSetup({ ...ctx, prompt: ctx.prompt, run: defaultRunner, repoDir: values.repo, responderHome: values['responder-home'] })
}
