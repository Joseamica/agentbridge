import { parseArgs } from 'node:util'
import { CLI_COMMAND, encodeLink, loadIdentity } from '@agentbridge/core'
import { forTerminal } from '../asker/format'
import { openAskerSession, withAsker } from '../asker/session'
import { CliError, type CliContext } from '../context'

const NOTE_MAX_CHARS = 500
// P5c: a connect_request is mined at 22 bits, which takes seconds even on a fast machine. The
// second sync (after connect() enqueues the row) gets a longer network budget than the default ten
// seconds, so a slow relay round trip on top of that mining does not also time out the publish.
const CONNECT_SECOND_SYNC_MS = 30_000

export async function link(_argv: string[], ctx: CliContext): Promise<void> {
  const identity = await loadIdentity(ctx.home)
  if (!identity) throw new CliError(`Todavía no hay una identidad de AgentBridge en esta computadora. Créala con: ${CLI_COMMAND} setup`)
  // Reading the profile needs the store, but nothing here talks to a relay: a link is local.
  const session = await openAskerSession({ home: ctx.home, relayPolicy: ctx.relayPolicy })
  try {
    const profile = session.service.profile()
    ctx.out.log(encodeLink(identity.publicKey, profile.relays))
    ctx.out.log('')
    ctx.out.log('Comparte ese enlace con quien quieras que te pregunte. Esa persona lo usará con:')
    ctx.out.log(`  ${CLI_COMMAND} connect <enlace> --note "quién eres"`)
  } finally {
    await session.close()
  }
}

export async function connect(argv: string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { note: { type: 'string' } } })
  const target = positionals[0]
  if (!target) throw new CliError(`Uso: ${CLI_COMMAND} connect <enlace> [--note "quién eres"]`)
  const note = (values.note ?? '').trim()
  if (note.length > NOTE_MAX_CHARS) throw new CliError(`La nota puede tener como máximo ${NOTE_MAX_CHARS} caracteres.`)

  ctx.out.log('Preparando la solicitud… esto tarda unos segundos la primera vez (tu computadora resuelve una prueba de trabajo).')
  // The command's own second sync — the one right after connect() enqueues the request — is the one
  // that actually mines and publishes it, so it gets the longer budget (P5c); withAsker's own
  // bracketing syncs keep their default, since neither has any of this row's mining to wait through.
  const { outcome, published } = await withAsker(ctx, async (service) => {
    const outcome = await service.connect(target, note)
    await service.sync(CONNECT_SECOND_SYNC_MS)
    return { outcome, published: service.wasPublished(outcome.pubkey) }
  })

  switch (outcome.kind) {
    case 'requested':
      if (published) {
        ctx.out.log('Solicitud enviada. Esa persona la verá cuando abra su AgentBridge y decide si te da permiso.')
      } else {
        ctx.out.log('Solicitud guardada, pendiente de envío: ningún tablero la aceptó todavía. Se reintenta sola cada vez que corres un comando.')
      }
      ctx.out.log(`Mientras tanto puedes revisar con: ${CLI_COMMAND} contacts`)
      return
    case 'already_pending':
      ctx.out.log('Ya le enviaste una solicitud a esa persona y sigue en camino. Se reintenta sola cada vez que corres un comando.')
      return
    case 'already_approved': {
      // outcome.name is whatever that person declared to us — never printed raw, same as
      // formatContactLine (asker/format.ts) treats every other declared name.
      const safeName = forTerminal(outcome.name, 80)
      ctx.out.log(`Esa persona ya te dio permiso (la tienes como ${safeName}). Pregúntale con:`)
      ctx.out.log(`  ${CLI_COMMAND} ask ${safeName} "tu pregunta"`)
    }
  }
}
