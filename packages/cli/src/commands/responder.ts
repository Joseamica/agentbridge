import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { CLI_COMMAND } from '@agentbridge/core'
import { CliError, type CliContext, type Output } from '../context'
import { isSameOrWithin } from '../fs-paths'
import { defaultInteractiveRunner, type InteractiveRunner } from '../interactive'
import {
  ALLOWED_EFFORTS,
  RESPONDER_CONFIG_FILE,
  SAFE_MODEL_PATTERN,
  scopeProblem,
  type ResponderConfig,
  type ResponderScope,
} from './responder-config'
import { inspectResponderSettings } from './setup-responder'

export { RESPONDER_CONFIG_FILE, type ResponderConfig } from './responder-config'

export async function readResponderConfig(profileHome: string): Promise<ResponderConfig> {
  const path = join(resolve(profileHome), RESPONDER_CONFIG_FILE)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    // Never the underlying error: it carries a path, and this is the single most likely first
    // failure (someone ran `responder` before `setup`). One sentence, one thing to do.
    throw new CliError(`Todavía no está preparado el respondedor en esta computadora. Corre: ${CLI_COMMAND} setup`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CliError(`El archivo de configuración del respondedor está dañado. Vuelve a correr: ${CLI_COMMAND} setup`)
  }
  const c = parsed as Partial<Omit<ResponderConfig, 'version'>> & { version?: unknown }
  if (c.version !== 1 && c.version !== 2) {
    // A newer AgentBridge wrote a shape this build does not know. Guessing at it would run the
    // answering session with the wrong folder or the wrong settings — the two things that must
    // never be wrong.
    throw new CliError(`Ese perfil lo escribió una versión más nueva de AgentBridge. Actualiza AgentBridge o vuelve a correr: ${CLI_COMMAND} setup`)
  }
  if (typeof c.shareDir !== 'string' || !c.shareDir || typeof c.identityHome !== 'string' || !c.identityHome) {
    throw new CliError(`El archivo de configuración del respondedor está incompleto. Vuelve a correr: ${CLI_COMMAND} setup`)
  }
  // `setupResponder` only ever writes `resolve()`d, mutually-exclusive paths here — but this
  // file sits on disk between runs, reachable by a hand-edit or a future version, and the two
  // things it names are not interchangeable with a stray value: a relative `shareDir` would
  // silently serve whatever folder the person happened to run `responder` from, and an
  // `identityHome` that is the shared folder (or inside it) does not fail to protect the secret
  // key — it fences the answering session INTO the folder that holds it, the opposite of what
  // `blockReadsOutsideWorkingDirectories` is there for. Re-running the same guard
  // `setupResponder` performs at write time (see setup-responder.ts), reused rather than
  // re-written, so the two can never disagree.
  if (!isAbsolute(c.shareDir) || !isAbsolute(c.identityHome)) {
    throw new CliError(`El archivo de configuración del respondedor tiene una ruta que no es absoluta. Vuelve a correr: ${CLI_COMMAND} setup`)
  }
  if (isSameOrWithin(c.identityHome, c.shareDir)) {
    throw new CliError(`La configuración guardada dejaría tu identidad dentro de la carpeta compartida. Vuelve a correr: ${CLI_COMMAND} setup`)
  }
  // Re-validated on the way IN, not only on the way out. setup validates what it writes, but this
  // file sits on disk between runs and reaches `claude` as argv: a model string with a space in it
  // would become two arguments, and `--settings` is one of them.
  if (typeof c.model !== 'string' || !SAFE_MODEL_PATTERN.test(c.model)) {
    throw new CliError(`El modelo guardado no es válido. Vuelve a correr: ${CLI_COMMAND} setup`)
  }
  if (typeof c.effort !== 'string' || !(ALLOWED_EFFORTS as readonly string[]).includes(c.effort)) {
    throw new CliError(`El esfuerzo guardado no es válido: "${String(c.effort)}". Vuelve a correr: ${CLI_COMMAND} setup`)
  }
  // A version-1 file predates scopes and meant one folder; it is read as exactly that, so every
  // 0.3 install keeps working without re-running setup (D4).
  const scope = c.version === 1 ? ({ kind: 'folder' } as const) : readScope(c.scope)
  const problem = scopeProblem(scope, { shareDir: c.shareDir, identityHome: c.identityHome, profileHome: resolve(profileHome) })
  if (problem) {
    throw new CliError(`El alcance guardado del respondedor no es válido: ${problem}. Vuelve a correr: ${CLI_COMMAND} setup`)
  }
  return { version: 2, shareDir: c.shareDir, identityHome: c.identityHome, model: c.model, effort: c.effort, scope }
}

// The scope decides which directories the answering session can read, so its shape is checked
// field by field and rebuilt, never passed through: an unknown `kind` guessed as the nearest
// known one, or an `extra` that is not an array of strings, would hand `claude` directories
// nobody chose. A fresh object also drops any stray field a hand-edit added.
function readScope(raw: unknown): ResponderScope {
  const invalid = () =>
    new CliError(`El alcance guardado del respondedor no es válido. Vuelve a correr: ${CLI_COMMAND} setup`)
  if (typeof raw !== 'object' || raw === null) throw invalid()
  const r = raw as { kind?: unknown; extra?: unknown }
  if (r.kind === 'folder' || r.kind === 'home') return { kind: r.kind }
  if (r.kind !== 'folders') throw invalid()
  if (!Array.isArray(r.extra) || r.extra.length === 0 || !r.extra.every((d) => typeof d === 'string' && d.length > 0)) throw invalid()
  return { kind: 'folders', extra: [...(r.extra as string[])] }
}

export function responderArgs(o: { settingsPath: string; model: string; effort: string }): string[] {
  return [
    '--dangerously-load-development-channels',
    'plugin:agentbridge@agentbridge-local',
    '--permission-mode',
    'dontAsk',
    '--settings',
    o.settingsPath,
    '--model',
    o.model,
    '--effort',
    o.effort,
  ]
}

export async function runResponder(o: {
  profileHome: string
  env: NodeJS.ProcessEnv
  out: Output
  runInteractive: InteractiveRunner
}): Promise<number> {
  const profileHome = resolve(o.profileHome)
  const config = await readResponderConfig(profileHome)

  // The one file that actually fences this session, checked before spawning — not merely
  // reported by `doctor`, which nothing makes anyone run. `responder.json` is re-validated on
  // every read above, and it is the harmless one: it names a folder and a model. `settings.json`
  // is what carries `permissions.blockReadsOutsideWorkingDirectories` and RESPONDER_DENY, and it
  // is handed to `claude --settings` unread. Claude Code refuses a MISSING settings file but
  // accepts one that exists and is not valid JSON in silence (verified against the real 2.1.278
  // binary), so a settings.json truncated by a crash, mangled by a sync-conflict copy or broken
  // by a hand-edit would otherwise start a `--permission-mode dontAsk` session with no deny list
  // and no read fence — answering another person's questions with the whole machine readable,
  // and nothing said. `responder --profile <any directory>` makes that reachable on purpose, so
  // the check belongs here and not only in `doctor`. The reader itself lives beside the writer
  // (setup-responder.ts) so this and doctor's own check can never disagree.
  const fence = await inspectResponderSettings(profileHome, config.scope, { identityHome: config.identityHome, home: homedir() })
  if (fence.problems.length > 0) {
    throw new CliError(
      `No puedo ponerte a contestar: los permisos del perfil dedicado no están como deben (${fence.problems.join(' · ')}). Sin ellos, la sesión que contesta podría leer archivos fuera de la carpeta compartida. Vuelve a correr: ${CLI_COMMAND} setup`,
    )
  }

  // Checked here, before spawning, rather than inferred from the spawn's own failure: `spawn`
  // raises the same ENOENT for a `cwd` that does not exist as it does for a binary that is not
  // installed, and the InteractiveRunner has no way to tell the two apart (it is one Node error
  // event either way). Without this check, a shared folder that was moved, renamed, or sits on
  // an unmounted drive would be reported as "Claude Code is not installed" — sending the person
  // to reinstall a program that already works. The folder path is safe to show here: it is
  // exactly what this person chose during setup and is looking at right now, in a sentence that
  // is about that folder — the constraint against printing it is about errors and logs leaking
  // it incidentally, not this.
  const shareInfo = await stat(config.shareDir).catch(() => null)
  if (!shareInfo?.isDirectory()) {
    throw new CliError(
      `No encuentro la carpeta que compartes para contestar (${config.shareDir}). Puede que se haya movido, se haya renombrado, o esté en una unidad que no está conectada. Vuelve a correr: ${CLI_COMMAND} setup y elige una carpeta que exista.`,
    )
  }

  const env = {
    ...o.env,
    // The person's own identity and database, shared with every command they type — not a second
    // set for the answering side, which would give them two links and two contact lists.
    AGENTBRIDGE_HOME: config.identityHome,
    // Claude's profile, on the other hand, IS dedicated: its own login and its own locked-down
    // settings never touch their everyday Claude Code.
    CLAUDE_CONFIG_DIR: join(profileHome, 'claude'),
  }
  // Announced, never asserted. Found by running the packaged CLI in a real terminal: this used to
  // say "Estás contestando preguntas" and then Claude Code ran its OWN onboarding — a seven-option
  // theme picker and, with no session, a login menu and the whole browser flow — so the sentence
  // was false at the moment the person read it, and in the bad case was followed by a raw English
  // error from Claude. The warning is a heads-up, not a tutorial: the point is that a question
  // about colours appearing instead of an agent waiting for questions is normal and not a sign
  // that the install is broken. The marker Claude keeps for this lives in its own private
  // `<perfil>/claude/.claude.json` and changes between versions, so this says what is about to
  // happen rather than writing into a file we do not own.
  o.out.log('Abro Claude para ponerte a contestar. Déjalo abierto. Para parar: Ctrl+C.')
  o.out.log('La primera vez, Claude hace primero un par de preguntas suyas (el tema de colores y, si hace falta, el inicio de sesión).')
  const result = await o.runInteractive(
    'claude',
    responderArgs({ settingsPath: join(profileHome, 'settings.json'), model: config.model, effort: config.effort }),
    { env, cwd: config.shareDir },
  )
  if (result.spawnFailed) {
    // Never a bare "no está instalado": the shared folder is already known-good at this point
    // (checked above), so a spawn failure here is really about `claude` itself — but "not
    // installed" and "installed, just not on this terminal's PATH" produce the exact same Node
    // error event, and only one of those is fixed by reinstalling.
    throw new CliError(
      'No pude ejecutar Claude Code. Puede que no esté instalado, o que sí lo esté pero no aparezca en el PATH de esta terminal: cierra y vuelve a abrir la terminal, o instala Claude Code con su propio instalador (no por npm), y vuelve a intentarlo.',
    )
  }
  // The two shapes a person's Ctrl+C actually takes, said the same way, because to them they are
  // the same thing. `code === null` is the child killed by the signal itself — reachable since
  // the handoff runs with the terminal cooked and this process ignoring SIGINT (see
  // interactive.ts), which is the startup window before Claude Code takes the terminal. `code
  // === 0` is the ordinary case a second later: Claude is in raw mode, handles the Ctrl+C itself
  // and exits cleanly — and used to print nothing at all, so the person pressed the key the docs
  // tell them to press and got silence. Reporting either as a failure would teach them that
  // stopping is an error.
  if (result.code === null || result.code === 0) {
    o.out.log('Dejaste de contestar preguntas. Las que te lleguen mientras tanto se reintentan durante siete días.')
    return 0
  }
  return result.code
}

export const responderCommand = async (argv: string[], ctx: CliContext): Promise<void> => {
  const { values } = parseArgs({ args: argv, options: { profile: { type: 'string' } }, allowPositionals: false })
  const profileHome = values.profile ? resolve(values.profile) : join(homedir(), '.agentbridge-responder')
  const code = await runResponder({ profileHome, env: ctx.env, out: ctx.out, runInteractive: defaultInteractiveRunner })
  if (code !== 0) throw new CliError(`Claude Code terminó con código ${code}. Si se repite, corre: ${CLI_COMMAND} doctor`)
}
