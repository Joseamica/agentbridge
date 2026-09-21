import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { CLI_COMMAND } from '@agentbridge/core'
import { CliError, type CliContext, type Output } from '../context'
import { defaultInteractiveRunner, type InteractiveRunner } from '../interactive'
import { ALLOWED_EFFORTS, SAFE_MODEL_PATTERN } from './setup-responder'

export const RESPONDER_CONFIG_FILE = 'responder.json'

// What `start.sh` used to carry inside a bash script. Kept as data, in the dedicated profile,
// at 0600: the answering session is fenced out of this folder, so nothing it reads can rewrite
// which folder it serves or which settings file locks it down.
export type ResponderConfig = {
  version: 1
  shareDir: string
  identityHome: string
  model: string
  effort: string
}

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
  const c = parsed as Partial<ResponderConfig>
  if (c.version !== 1) {
    // A newer AgentBridge wrote a shape this build does not know. Guessing at it would run the
    // answering session with the wrong folder or the wrong settings — the two things that must
    // never be wrong.
    throw new CliError(`Ese perfil lo escribió una versión más nueva de AgentBridge. Actualiza AgentBridge o vuelve a correr: ${CLI_COMMAND} setup`)
  }
  if (typeof c.shareDir !== 'string' || !c.shareDir || typeof c.identityHome !== 'string' || !c.identityHome) {
    throw new CliError(`El archivo de configuración del respondedor está incompleto. Vuelve a correr: ${CLI_COMMAND} setup`)
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
  return { version: 1, shareDir: c.shareDir, identityHome: c.identityHome, model: c.model, effort: c.effort }
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
  const env = {
    ...o.env,
    // The person's own identity and database, shared with every command they type — not a second
    // set for the answering side, which would give them two links and two contact lists.
    AGENTBRIDGE_HOME: config.identityHome,
    // Claude's profile, on the other hand, IS dedicated: its own login and its own locked-down
    // settings never touch their everyday Claude Code.
    CLAUDE_CONFIG_DIR: join(profileHome, 'claude'),
  }
  o.out.log('Estás contestando preguntas. Déjalo abierto. Para parar: Ctrl+C.')
  const result = await o.runInteractive(
    'claude',
    responderArgs({ settingsPath: join(profileHome, 'settings.json'), model: config.model, effort: config.effort }),
    { env, cwd: config.shareDir },
  )
  if (result.spawnFailed) {
    throw new CliError('No encontré Claude Code en esta computadora. Instálalo desde claude.com/claude-code y vuelve a intentarlo.')
  }
  if (result.code === null) {
    // Killed by a signal — Ctrl+C, which is exactly how a person stops this. Reporting it as a
    // failure would teach them that stopping is an error.
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
