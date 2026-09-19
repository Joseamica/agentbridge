import { CLI_COMMAND, LIMITS, UserFacingError, describeError } from '@agentbridge/core'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { forTerminal, formatContactLine, formatQuestion } from './asker/format'
import { openAskerSession } from './asker/session'
import type { AskerService } from './asker/service'
import { type CliContext } from './context'
import { zodFieldsMessage } from './spanish-errors'

// Tool names, descriptions and argument names are English: Claude reads them. Everything a person
// ends up seeing is Spanish.
const TOOLS = [
  {
    name: 'list_contacts',
    description:
      "List the people whose agents you may ask through AgentBridge. AgentBridge cannot tell whether someone is online: a question waits for them and is retried for up to seven days.",
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'ask_contact',
    description: "Send a question to another person's agent. Returns a question_id; then call check_answer with it.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        contact: { type: 'string', description: 'The name of the person as list_contacts shows it.' },
        question: { type: 'string', description: 'The question, self-contained, in the language that person understands.' },
      },
      required: ['contact', 'question'],
    },
  },
  {
    name: 'check_answer',
    description: 'Wait up to wait_seconds (max 45) for a question to be answered and return its state. Call again while it is still pending.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        question_id: { type: 'string', description: 'The question_id ask_contact returned.' },
        wait_seconds: { type: 'number', description: 'How long to wait in this call, 0 to 45. Default 40.' },
      },
      required: ['question_id'],
    },
  },
  {
    name: 'connect',
    description: 'Ask someone for permission to question their agent, using the agentbridge: link they shared. They decide; nothing is sent until they approve.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        link: { type: 'string', description: 'The agentbridge: link that person shared.' },
        note: { type: 'string', description: 'One line saying who you are, for the person deciding.' },
      },
      required: ['link'],
    },
  },
]

const AskArgs = z.object({ contact: z.string().trim().min(1), question: z.string().trim().min(1).max(LIMITS.questionMaxChars) })
const CheckArgs = z.object({ question_id: z.string().trim().min(1), wait_seconds: z.coerce.number().optional() })
const ConnectArgs = z.object({ link: z.string().trim().min(1), note: z.string().trim().max(500).optional() })

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

export function createAskerServer(service: AskerService, options: { version?: string; log?: (line: string) => void } = {}): Server {
  const server = new Server({ name: 'agentbridge', version: options.version ?? '0.2.0' }, { capabilities: { tools: {} } })
  const log = (line: string) => {
    try {
      options.log?.(line)
    } catch {
      // Nowhere left to report a broken logger.
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      switch (req.params.name) {
        case 'list_contacts': {
          await service.sync()
          const allowed = service.contacts().filter((contact) => contact.state === 'approved')
          if (allowed.length === 0) {
            return ok(`Nadie te ha dado permiso para preguntarle todavía. Pide permiso con la herramienta connect o con: ${CLI_COMMAND} connect <enlace>`)
          }
          return ok(allowed.map((contact) => formatContactLine(contact)).join('\n'))
        }
        case 'ask_contact': {
          const args = AskArgs.parse(req.params.arguments ?? {})
          const question = await service.ask(args.contact, args.question)
          await service.sync()
          // Same honesty as the CLI: `sending` means no relay has taken it yet.
          const stored = service.question(question.questionId)
          const headline =
            stored.state === 'sending'
              ? `Pregunta guardada para ${args.contact}, pendiente de envío: ningún tablero la aceptó todavía.`
              : `Pregunta enviada a ${args.contact}.`
          return ok(
            `${headline} question_id: ${question.questionId}\n` +
              'Llama check_answer con ese question_id. Si esa persona tiene su computadora apagada, la pregunta la espera hasta una semana.',
          )
        }
        case 'check_answer': {
          const args = CheckArgs.parse(req.params.arguments ?? {})
          const seconds = Math.max(0, Math.min(LIMITS.longPollMaxSeconds, Math.floor(args.wait_seconds ?? 40)))
          const question = service.question(args.question_id)
          const settled = await service.waitForAnswer({ recipient: question.recipient, questionId: question.questionId }, seconds)
          return ok(`${formatQuestion(settled)}\n\nquestion_id: ${settled.questionId}`)
        }
        case 'connect': {
          const args = ConnectArgs.parse(req.params.arguments ?? {})
          const outcome = await service.connect(args.link, args.note ?? '')
          await service.sync(30_000)
          if (outcome.kind === 'already_approved') {
            // outcome.name is that person's own declared name — third-party text a hostile contact
            // controls, same as any other declared name (see asker/format.ts's formatContactLine and
            // commands/connect.ts's own already_approved branch). It reaches Claude's transcript, not
            // just a terminal, so it goes through forTerminal here exactly as it does there.
            return ok(`Esa persona ya te dio permiso (la tienes como ${forTerminal(outcome.name, 80)}).`)
          }
          if (outcome.kind === 'already_pending') return ok('Ya le enviaste una solicitud a esa persona y sigue en camino.')
          return ok('Solicitud enviada. Esa persona decide si te da permiso; te enteras cuando list_contacts la muestre como aprobada.')
        }
        default:
          return fail(`Herramienta desconocida: ${req.params.name}`)
      }
    } catch (err) {
      if (err instanceof UserFacingError) return fail(err.message)
      if (err instanceof z.ZodError) return fail(zodFieldsMessage(err))
      // Anything else could carry decrypted content or a path: only its type reaches the log, and
      // the model gets a fixed Spanish sentence.
      log(`asker tool ${req.params.name} failed (${describeError(err)})`)
      return fail('Algo falló al usar AgentBridge. Vuelve a intentarlo; si sigue, revisa la terminal donde corre el servidor.')
    }
  })

  return server
}

export async function mcp(_argv: string[], ctx: CliContext): Promise<void> {
  const log = (message: string) => {
    try {
      process.stderr.write(`[agentbridge] ${message}\n`)
    } catch {
      // Nowhere left to report a broken logger.
    }
  }
  const session = await openAskerSession({ home: ctx.home, log })
  // The MCP server is the only persistent asker: it keeps the live subscription open and runs the
  // retries, history and purge on timers. Every CLI command syncs once instead.
  session.service.start()
  const server = createAskerServer(session.service, { log })

  // The SDK's stdio transport listens for 'data' and 'error', not for 'end': when Claude Code closes
  // the pipe, nothing here would ever resolve and the process would stay alive holding sockets. Every
  // way this process can be told to stop is registered before connecting, and the cleanup is
  // idempotent so two of them arriving together is harmless.
  let stopping: Promise<void> | null = null
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      try {
        await server.close()
      } catch (err) {
        log(`closing the MCP server failed (${describeError(err)})`)
      }
      await session.close()
    })()
    return stopping
  }
  const ended = new Promise<void>((resolve) => {
    process.stdin.once('end', resolve)
    process.stdin.once('close', resolve)
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
    server.onclose = () => resolve()
  })

  try {
    await server.connect(new StdioServerTransport())
    await ended
  } finally {
    await stop()
  }
}
