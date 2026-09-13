import { LIMITS, RelayError, type RelayHttpClient } from '@agentbridge/core'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { formatTicket } from './commands/ask'
import { clientFor, requireConfig, type CliContext } from './context'
import { isNetworkError, RELAY_UNREACHABLE_ES, zodFieldsMessage } from './spanish-errors'

export type AskerApi = Pick<RelayHttpClient, 'contacts' | 'ask' | 'ticket'>

const TOOLS = [
  {
    name: 'list_contacts',
    description: 'List the people whose agents you are allowed to ask through AgentBridge, and whether their agent is online.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'ask_contact',
    description: "Send a question to another person's agent through AgentBridge. Returns a ticket_id; then call check_answer.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        contact: { type: 'string', description: 'Handle of the person, for example dev or @dev.' },
        question: { type: 'string', description: 'The question, self-contained, in the language the person understands.' },
      },
      required: ['contact', 'question'],
    },
  },
  {
    name: 'check_answer',
    description: 'Wait up to wait_seconds (max 45) for the answer to a ticket and return its status. Call again while it is still pending.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticket_id: { type: 'string' },
        wait_seconds: { type: 'number', description: 'How long to wait in this call, 0 to 45. Default 40.' },
      },
      required: ['ticket_id'],
    },
  },
]

const AskArgs = z.object({ contact: z.string().min(1), question: z.string().trim().min(1).max(LIMITS.questionMaxChars) })
const CheckArgs = z.object({ ticket_id: z.string().min(1), wait_seconds: z.coerce.number().optional() })

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

export function createAskerServer(api: AskerApi): Server {
  const server = new Server({ name: 'agentbridge', version: '0.1.0' }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      switch (req.params.name) {
        case 'list_contacts': {
          const view = await api.contacts()
          if (view.canAsk.length === 0) return ok('Nadie te ha dado permiso para preguntarle todavía.')
          return ok(view.canAsk.map((c) => `@${c.handle} (${c.displayName}) ${c.online ? 'en línea' : 'desconectado'}`).join('\n'))
        }
        case 'ask_contact': {
          const args = AskArgs.parse(req.params.arguments ?? {})
          const { ticketId } = await api.ask(args.contact.replace(/^@/, ''), args.question)
          return ok(`Pregunta enviada a @${args.contact.replace(/^@/, '')}. ticket_id: ${ticketId}\nLlama check_answer con ese ticket_id para esperar la respuesta.`)
        }
        case 'check_answer': {
          const args = CheckArgs.parse(req.params.arguments ?? {})
          const wait = Math.max(0, Math.min(LIMITS.longPollMaxSeconds, Math.floor(args.wait_seconds ?? 40)))
          const view = await api.ticket(args.ticket_id, wait)
          return ok(`${formatTicket(view)}\n\nticket_id: ${view.ticketId} · estado: ${view.status}`)
        }
        default:
          return fail(`Herramienta desconocida: ${req.params.name}`)
      }
    } catch (err) {
      if (err instanceof RelayError) return fail(err.message)
      if (err instanceof z.ZodError) return fail(zodFieldsMessage(err))
      if (isNetworkError(err)) return fail(RELAY_UNREACHABLE_ES)
      return fail(`Error inesperado: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  return server
}

export async function mcp(_argv: string[], ctx: CliContext): Promise<void> {
  const config = await requireConfig(ctx)
  const server = createAskerServer(clientFor(ctx, config))
  await server.connect(new StdioServerTransport())
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve()
  })
}
