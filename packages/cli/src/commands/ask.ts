import { LIMITS, type RelayHttpClient, type TicketView } from '@agentbridge/core'
import { parseArgs } from 'node:util'
import { CliError, clientFor, requireConfig, type CliContext } from '../context'

const TERMINAL = new Set<TicketView['status']>(['answered', 'expired', 'cancelled'])

export function isTerminal(status: TicketView['status']): boolean {
  return TERMINAL.has(status)
}

export function formatTicket(view: TicketView): string {
  switch (view.status) {
    case 'answered': {
      const seconds = view.latencyMs === null ? '?' : Math.round(view.latencyMs / 1000)
      return `@${view.to} contestó (${seconds} s):\n\n${view.answer}\n\nFuente: ${view.source}\nConfianza: ${view.confidence}`
    }
    case 'queued':
      return `En cola: @${view.to} todavía no la recibe (su agente no está conectado o está contestando otra pregunta).`
    case 'dispatched':
      return `@${view.to} la está contestando.`
    case 'expired':
      return `Expiró sin respuesta de @${view.to}.`
    case 'cancelled':
      return `Se canceló: @${view.to} retiró el permiso.`
  }
}

export async function waitForTicket(
  client: Pick<RelayHttpClient, 'ticket'>,
  ticketId: string,
  totalSeconds: number,
): Promise<TicketView> {
  const deadline = Date.now() + totalSeconds * 1000
  let view = await client.ticket(ticketId, 0)
  while (!isTerminal(view.status)) {
    const remaining = Math.floor((deadline - Date.now()) / 1000)
    if (remaining <= 0) break
    view = await client.ticket(ticketId, Math.min(LIMITS.longPollMaxSeconds, remaining))
  }
  return view
}

// Shared by `ask` and `ticket` so a mistyped --wait gives the exact same clean, local
// Spanish message in both commands, instead of a bare `Number(...)` turning into NaN and
// only failing much later at the relay with a generic "Datos inválidos en: wait".
function parseWaitSeconds(raw: string | undefined, fallback: number): number {
  const seconds = Number(raw ?? fallback)
  if (!Number.isFinite(seconds) || seconds < 0) throw new CliError('--wait debe ser un número de segundos')
  return seconds
}

export async function ask(argv: string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { wait: { type: 'string' }, 'no-wait': { type: 'boolean' } },
  })
  const [rawHandle, ...words] = positionals
  const question = words.join(' ').trim()
  if (!rawHandle || !question) throw new CliError('Uso: agentbridge ask <handle> <pregunta…> [--wait <segundos>|--no-wait]')
  const totalSeconds = values['no-wait'] ? 0 : parseWaitSeconds(values.wait, 120)

  const config = await requireConfig(ctx)
  const client = clientFor(ctx, config)
  const { ticketId } = await client.ask(rawHandle.replace(/^@/, ''), question)
  ctx.out.log(`Pregunta enviada. ticket_id: ${ticketId}`)
  if (totalSeconds === 0) return
  const view = await waitForTicket(client, ticketId, totalSeconds)
  ctx.out.log(formatTicket(view))
  if (!isTerminal(view.status)) ctx.out.log(`Sigue pendiente. Consulta después con: agentbridge ticket ${ticketId} --wait 45`)
}

export async function ticket(argv: string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { wait: { type: 'string' } } })
  const ticketId = positionals[0]
  if (!ticketId) throw new CliError('Uso: agentbridge ticket <ticket_id> [--wait <segundos>]')
  const waitSeconds = parseWaitSeconds(values.wait, 0)
  const config = await requireConfig(ctx)
  const view = await waitForTicket(clientFor(ctx, config), ticketId, waitSeconds)
  ctx.out.log(formatTicket(view))
}
