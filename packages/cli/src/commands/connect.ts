import { parseArgs } from 'node:util'
import { CLI_COMMAND, encodeLink, loadIdentity } from '@agentbridge/core'
import { forTerminal } from '../asker/format'
import { openAskerSession, withAsker } from '../asker/session'
import { CliError, type CliContext } from '../context'

const NOTE_MAX_CHARS = 500

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

  const { outcome, published } = await withAsker(ctx, async (service) => {
    const outcome = await service.connect(target, note)
    // Only a brand-new request (this call's own store.tx just enqueued it) is about to be mined —
    // 'already_pending'/'already_approved' mine nothing, so the notice would be misleading there
    // (Fix round 1, M1). Printed here, right before the sync that does the mining, and not a moment
    // earlier, so a pause during that sync never reads as a hang (P5c).
    if (outcome.kind !== 'requested') return { outcome, published: false }
    ctx.out.log('Preparando la solicitud… esto tarda unos segundos la primera vez (tu computadora resuelve una prueba de trabajo).')
    // Fix round 1, I1: the sync below keeps its ordinary default budget. A longer one buys nothing —
    // mining runs on its own separate budget (CONNECT_MINING_MS in service.ts) regardless of what
    // maxMs this sync gets, and publisher.ts publishes a row it already claimed through to the end
    // regardless of the deadline too (a claim in flight is never abandoned, only a *new* claim is
    // refused once the deadline has passed). Nothing here needed lengthening.
    await service.sync()
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
      // outcome.name (whatever that person declared to us) is for identifying them, never printed
      // raw — same rule formatContactLine (asker/format.ts) applies to every other declared name.
      // outcome.localName is the exact, already-safe slug `ask` itself resolves against (Fix round 1,
      // M2): showing the declared name there could hand back a command that fails to resolve.
      const safeName = forTerminal(outcome.name, 80)
      ctx.out.log(`Esa persona ya te dio permiso (la tienes como ${safeName}). Pregúntale con:`)
      ctx.out.log(`  ${CLI_COMMAND} ask ${outcome.localName} "tu pregunta"`)
    }
  }
}
