import { CLI_COMMAND, RelayError, UserFacingError, describeError } from '@agentbridge/core'
import { ask, ticket } from './commands/ask'
import { connect, link } from './commands/connect'
import { approve, contacts, reject, requests, revoke, whoami } from './commands/contacts'
import { doctorCommand } from './commands/doctor'
import { setupCommand } from './commands/setup'
import { setupResponderCommand } from './commands/setup-responder'
import { CliError, type CliContext } from './context'
import { mcp } from './mcp-asker'
import { isNetworkError, RELAY_UNREACHABLE_ES } from './spanish-errors'

export type Command = (argv: string[], ctx: CliContext) => Promise<void>

export const USAGE = `AgentBridge — pregúntale al agente de otra persona.

Para empezar:
  ${CLI_COMMAND} setup                       (te hace las preguntas necesarias y deja todo listo)

Tu enlace y tus permisos:
  ${CLI_COMMAND} link                        (muestra tu enlace, para compartirlo)
  ${CLI_COMMAND} connect <enlace> [--note "quién eres"]
  ${CLI_COMMAND} contacts                    (a quién puedes preguntarle y quién puede preguntarte)
  ${CLI_COMMAND} whoami

Solicitudes que te llegan:
  ${CLI_COMMAND} requests
  ${CLI_COMMAND} approve <id>
  ${CLI_COMMAND} reject <id>
  ${CLI_COMMAND} revoke <nombre>

Preguntar:
  ${CLI_COMMAND} ask <nombre> <pregunta…> [--wait <segundos>|--no-wait]
  ${CLI_COMMAND} ticket <id> [--wait <segundos>]
  ${CLI_COMMAND} mcp                         (servidor MCP para Claude Code o Codex)

Responder desde esta computadora:
  ${CLI_COMMAND} setup-responder --share <carpeta> [--profile <carpeta>] [--repo <carpeta>] [--model sonnet] [--effort low]
  ${CLI_COMMAND} doctor [--home <carpeta>] [--profile <carpeta>] [--share <carpeta>] [--repo <carpeta>]

Variable: AGENTBRIDGE_HOME (la carpeta con tu identidad y tu base de datos)`

const COMMANDS: Record<string, Command> = {
  setup: setupCommand,
  'setup-responder': setupResponderCommand,
  doctor: doctorCommand,
  link,
  connect,
  contacts,
  whoami,
  requests,
  approve,
  reject,
  revoke,
  ask,
  ticket,
  mcp,
}

function isParseArgsError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof TypeError && 'code' in err && String((err as { code?: string }).code).startsWith('ERR_PARSE_ARGS')
}

// node:util's parseArgs throws English TypeErrors (ERR_PARSE_ARGS_UNKNOWN_OPTION,
// ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL, ERR_PARSE_ARGS_INVALID_OPTION_VALUE). This is the
// most likely mistake on a first run (a mistyped flag), so it must read in Spanish.
function translateParseArgsError(err: NodeJS.ErrnoException): string {
  const message = err.message
  switch (err.code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION': {
      // Not anchored with `$`: when the command was parsed with `allowPositionals: true`,
      // Node appends an extra sentence ("To specify a positional argument starting with a
      // '-', ...") after the quoted option, and that sentence itself contains several more
      // single quotes. A `$`-anchored (or otherwise unanchored-but-greedy `.+`) pattern either
      // misses entirely or, worse, greedily captures all the way through to the last quote in
      // that trailing sentence. Matching only up to the *next* quote avoids both failure modes.
      const m = /^Unknown option '([^']+)'/.exec(message)
      return `Opción desconocida: ${m?.[1] ?? message}`
    }
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL': {
      const m = /^Unexpected argument '([^']+)'\./.exec(message)
      return `Este comando no acepta ese argumento: ${m?.[1] ?? message}`
    }
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE': {
      const m = /^Option '([^']+)'/.exec(message)
      return `Falta el valor de la opción: ${(m?.[1] ?? message).replace(' <value>', '')}`
    }
    default:
      return 'Argumentos inválidos.'
  }
}

// Same swallow-its-own-failure guard as the channel's own `log` (packages/channel/src/main.ts): a
// closed stderr pipe must never be the thing that takes a short-lived CLI process down while it is
// trying to report an unexpected failure that already has nowhere better to go.
const log = (message: string) => {
  try {
    process.stderr.write(`[agentbridge] ${message}\n`)
  } catch {
    // Nowhere left to report a broken logger.
  }
}

// A seam so a test can exercise the dispatch and error-handling logic against a fake command table
// (one that always throws a chosen error) without needing a real command to fail in just the right
// way. `run` is the only production caller and always passes the real COMMANDS table.
export async function runWith(commands: Record<string, Command>, argv: string[], ctx: CliContext): Promise<number> {
  const [name, ...rest] = argv
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    ctx.out.log(USAGE)
    return 0
  }
  const command = commands[name]
  if (!command) {
    ctx.out.error(`Comando desconocido: ${name}\n\n${USAGE}`)
    return 1
  }
  try {
    await command(rest, ctx)
    return 0
  } catch (err) {
    if (err instanceof CliError || err instanceof UserFacingError || err instanceof RelayError) {
      ctx.out.error(err.message)
      return 1
    }
    if (isParseArgsError(err)) {
      ctx.out.error(`${translateParseArgsError(err)}\n\n${USAGE}`)
      return 1
    }
    if (isNetworkError(err)) {
      ctx.out.error(RELAY_UNREACHABLE_ES)
      return 1
    }
    // Never the error's own message here: it can carry a filesystem path, relay text or decrypted
    // content — this catch is the last line of defense for every command. The person sees a fixed
    // Spanish sentence; only describeError's type-and-code goes to the log.
    ctx.out.error(`Algo falló al ejecutar ese comando. Vuelve a intentarlo; si sigue fallando, corre: ${CLI_COMMAND} doctor`)
    log(`command ${name} failed (${describeError(err)})`)
    return 2
  }
}

export async function run(argv: string[], ctx: CliContext): Promise<number> {
  return runWith(COMMANDS, argv, ctx)
}
