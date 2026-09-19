import {
  CLI_COMMAND,
  REQUEST_ID_LENGTH,
  approveConnection,
  encodeLink,
  listRequests,
  loadIdentity,
  nowSeconds,
  rejectConnection,
  revokeConnection,
  type Contact,
} from '@agentbridge/core'
import { forTerminal, formatContactLine, formatInboundContactLine } from '../asker/format'
import { withAsker, withResponderSession } from '../asker/session'
import { CliError, type CliContext } from '../context'

export async function contacts(_argv: string[], ctx: CliContext): Promise<void> {
  const { outbound, inbound } = await withAsker(ctx, async (service) => ({
    outbound: service.contacts(),
    inbound: service.inboundContacts(),
  }))

  ctx.out.log('A quién puedes preguntarle:')
  if (outbound.length === 0) {
    ctx.out.log(`  (todavía nadie) — pide permiso con: ${CLI_COMMAND} connect <enlace>`)
  } else {
    for (const contact of outbound) ctx.out.log(`  ${formatContactLine(contact)}`)
  }

  ctx.out.log('')
  ctx.out.log('Quién puede preguntarte a ti:')
  // The same contact means the opposite thing in this direction, so it gets its own formatter.
  const allowed = inbound.filter((contact: Contact) => contact.state === 'approved' || contact.state === 'requested')
  if (allowed.length === 0) {
    ctx.out.log(`  (todavía nadie) — revisa las solicitudes con: ${CLI_COMMAND} requests`)
  } else {
    for (const contact of allowed) ctx.out.log(`  ${formatInboundContactLine(contact)}`)
  }
}

export async function whoami(_argv: string[], ctx: CliContext): Promise<void> {
  const identity = await loadIdentity(ctx.home)
  if (!identity) throw new CliError(`Todavía no hay una identidad de AgentBridge en esta computadora. Créala con: ${CLI_COMMAND} setup`)
  const profile = await withAsker(ctx, async (service) => service.profile())
  ctx.out.log(`Tu llave pública: ${identity.publicKey}`)
  ctx.out.log(`Tu nombre: ${profile.name ?? '(sin nombre todavía)'}`)
  ctx.out.log(`Tus tableros: ${profile.relays.join(', ')}`)
  ctx.out.log(`Tu enlace: ${encodeLink(identity.publicKey, profile.relays)}`)
}

export async function requests(_argv: string[], ctx: CliContext): Promise<void> {
  const pending = await withResponderSession(ctx, async ({ store, identity }) => listRequests(store, nowSeconds()))
  if (pending.length === 0) {
    ctx.out.log('No tienes solicitudes nuevas.')
    return
  }
  ctx.out.log('Solicitudes nuevas:')
  for (const request of pending) {
    ctx.out.log('')
    ctx.out.log(`  ${request.id}  ${forTerminal(request.declaredName, 80)}`)
    if (request.note) ctx.out.log(`  nota: ${forTerminal(request.note)}`)
  }
  ctx.out.log('')
  ctx.out.log('Si apruebas a alguien, su agente podrá leer tu carpeta compartida y preguntarte.')
  ctx.out.log(`Acepta con: ${CLI_COMMAND} approve <id>   ·   rechaza con: ${CLI_COMMAND} reject <id>`)
}

// A person may paste a valid identifier made only of digits (a key prefix is hexadecimal), so the
// index guard is about shape and length, not about digits: an identifier is at least 8 hex
// characters, and anything shorter that looks like a list position is the mistake worth catching.
function requireId(argv: string[], verb: 'approve' | 'reject'): string {
  const id = argv[0]
  if (!id) throw new CliError(`Uso: ${CLI_COMMAND} ${verb} <id>   (el id de ${CLI_COMMAND} requests, no un número de la lista)`)
  if (id.length < REQUEST_ID_LENGTH) {
    throw new CliError(
      `Ese identificador es muy corto. Copia los ${REQUEST_ID_LENGTH} caracteres que aparecen junto al nombre en: ${CLI_COMMAND} requests`,
    )
  }
  if (!/^[0-9a-f]+$/i.test(id)) {
    throw new CliError(`Ese identificador no tiene la forma correcta. Cópialo tal cual de: ${CLI_COMMAND} requests`)
  }
  return id.toLowerCase()
}

export async function approve(argv: string[], ctx: CliContext): Promise<void> {
  const id = requireId(argv, 'approve')
  const contact = await withResponderSession(ctx, async ({ store, identity }) =>
    approveConnection(store, { identity, idPrefix: id, now: nowSeconds() }).contact,
  )
  const name = forTerminal(contact.localName ?? contact.declaredName ?? id, 80)
  ctx.out.log(`Listo: ${name} ya puede preguntarte. Su agente puede leer tu carpeta compartida.`)
  ctx.out.log(`Si te arrepientes: ${CLI_COMMAND} revoke ${name}`)
}

export async function reject(argv: string[], ctx: CliContext): Promise<void> {
  const id = requireId(argv, 'reject')
  const contact = await withResponderSession(ctx, async ({ store, identity }) =>
    rejectConnection(store, { identity, idPrefix: id, now: nowSeconds() }).contact,
  )
  ctx.out.log(`Listo: ${forTerminal(contact.declaredName ?? id, 80)} no puede preguntarte.`)
}

export async function revoke(argv: string[], ctx: CliContext): Promise<void> {
  const name = argv[0]
  if (!name) throw new CliError(`Uso: ${CLI_COMMAND} revoke <nombre>   (el nombre que aparece en ${CLI_COMMAND} contacts)`)
  const result = await withResponderSession(ctx, async ({ store, identity }) =>
    revokeConnection(store, { identity, name, now: nowSeconds() }),
  )
  ctx.out.log(`Listo: ${forTerminal(name, 80)} ya no puede preguntarte.`)
  if (result.rejectedQuestions > 0) {
    ctx.out.log(`Cerré ${result.rejectedQuestions} pregunta(s) suya(s) que estaban esperando respuesta.`)
  }
}
