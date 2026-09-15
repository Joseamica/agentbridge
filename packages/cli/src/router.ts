import { RelayError } from '@agentbridge/core'
import { accept, adminEnrollLink, contacts, enroll, invite, revoke, whoami } from './commands/account'
import { ask, ticket } from './commands/ask'
import { doctorCommand } from './commands/doctor'
import { setupCommand } from './commands/setup'
import { setupResponderCommand } from './commands/setup-responder'
import { CliError, type CliContext } from './context'
import { mcp } from './mcp-asker'
import { isNetworkError, RELAY_UNREACHABLE_ES } from './spanish-errors'

export type Command = (argv: string[], ctx: CliContext) => Promise<void>

export const USAGE = `AgentBridge — pregúntale al agente de otra persona.

Para empezar (recomendado):
  agentbridge setup [--repo <carpeta>] [--responder-home <carpeta>]
                              (te hace las preguntas necesarias y deja todo listo; las dos
                               opciones son solo para quien corre agentbridge desde el código
                               fuente — --responder-home es la carpeta del perfil dedicado del
                               respondedor, no la de tu identidad)

Alta y permisos:
  agentbridge admin enroll-link --handle <h> --name <nombre> --relay <url> --admin-token <token>
  agentbridge enroll <enlace> [--device <nombre>]
  agentbridge whoami
  agentbridge invite
  agentbridge accept <enlace>
  agentbridge contacts
  agentbridge revoke <handle>

Preguntar:
  agentbridge ask <handle> <pregunta…> [--wait <segundos>|--no-wait]
  agentbridge ticket <ticket_id> [--wait <segundos>]
  agentbridge mcp            (servidor MCP para Claude Code o Codex)

Responder desde esta computadora:
  agentbridge setup-responder --share <carpeta> [--home <carpeta>] [--repo <carpeta>] [--model sonnet] [--effort low]
  agentbridge doctor [--home <carpeta>] [--share <carpeta>] [--repo <carpeta>]

Variables: AGENTBRIDGE_HOME (carpeta de la credencial), AGENTBRIDGE_RELAY_URL, AGENTBRIDGE_ADMIN_TOKEN`

const COMMANDS: Record<string, Command> = {
  setup: setupCommand,
  enroll,
  whoami,
  invite,
  accept,
  contacts,
  revoke,
  ask,
  ticket,
  mcp,
  'setup-responder': setupResponderCommand,
  doctor: doctorCommand,
  admin: async (argv, ctx) => {
    const [sub, ...rest] = argv
    if (sub !== 'enroll-link') throw new CliError('Uso: agentbridge admin enroll-link --handle <h> --name <nombre> --relay <url> --admin-token <token>')
    await adminEnrollLink(rest, ctx)
  },
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

export async function run(argv: string[], ctx: CliContext): Promise<number> {
  const [name, ...rest] = argv
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    ctx.out.log(USAGE)
    return 0
  }
  const command = COMMANDS[name]
  if (!command) {
    ctx.out.error(`Comando desconocido: ${name}\n\n${USAGE}`)
    return 1
  }
  try {
    await command(rest, ctx)
    return 0
  } catch (err) {
    if (err instanceof CliError || err instanceof RelayError) {
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
    ctx.out.error(`Error inesperado: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }
}
