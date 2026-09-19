import {
  CLI_COMMAND,
  Device,
  agentbridgeHome,
  handleResponderMessage,
  loadIdentity,
  openStore,
  type Identity,
  type RelayPolicy,
  type SocketFactory,
  type Store,
} from '@agentbridge/core'
import { CliError, type CliContext } from '../context'
import { AskerService } from './service'

export type AskerSession = { service: AskerService; close(): Promise<void> }

// Opens the identity and the store this person already has. A missing identity is the one thing a
// person can fix themselves, so it says how.
export async function openAskerSession(options: {
  home?: string
  now?: () => number
  createSocket?: SocketFactory
  log?: (line: string) => void
  relayPolicy?: RelayPolicy
}): Promise<AskerSession> {
  const home = options.home ?? agentbridgeHome()
  const identity = await loadIdentity(home)
  if (!identity) {
    throw new CliError(`Todavía no hay una identidad de AgentBridge en esta computadora. Créala con: ${CLI_COMMAND} setup`)
  }
  let store: Store
  try {
    store = await openStore(home, options.relayPolicy ? { relayPolicy: options.relayPolicy } : {})
  } catch (err) {
    throw new CliError(`No se pudo abrir la base de datos en ${home}. Revisa los permisos de esa carpeta.`, { cause: err })
  }
  const service = new AskerService({ store, identity, now: options.now, createSocket: options.createSocket, log: options.log })
  return {
    service,
    close: async () => {
      await service.close()
      store.close()
    },
  }
}

// The whole short-lived cycle every command runs: start → sync → operate → sync → close. The second
// sync is what publishes whatever the command just enqueued, and `close` is in a finally so a
// command always ends, even when a relay is slow or the operation threw.
export async function withAsker<T>(
  ctx: CliContext,
  fn: (service: AskerService) => Promise<T>,
  options: { firstSyncMs?: number; lastSyncMs?: number } = {},
): Promise<T> {
  const session = await openAskerSession({ home: ctx.home, relayPolicy: ctx.relayPolicy, createSocket: ctx.createSocket })
  try {
    await session.service.sync(options.firstSyncMs)
    const result = await fn(session.service)
    await session.service.sync(options.lastSyncMs)
    return result
  } finally {
    await session.close()
  }
}

// The same short-lived cycle for the four commands that are about messages addressed to this person
// as a responder: a request arriving, and the decisions that answer it. `handleAskerMessage` drops
// those on purpose, so they need their own role, their own cursors and their own handler — but not
// the channel lock and not a dispatcher: only the channel hands questions to Claude (P10).
export async function withResponderSession<T>(
  ctx: CliContext,
  fn: (input: { store: Store; identity: Identity; sync: () => Promise<void> }) => Promise<T>,
): Promise<T> {
  const home = ctx.home
  const identity = await loadIdentity(home)
  if (!identity) {
    throw new CliError(`Todavía no hay una identidad de AgentBridge en esta computadora. Créala con: ${CLI_COMMAND} setup`)
  }
  const store = await openStore(home, ctx.relayPolicy ? { relayPolicy: ctx.relayPolicy } : {})
  const device = new Device({ store, identity, role: 'responder', handleMessage: handleResponderMessage, createSocket: ctx.createSocket })
  const sync = async () => {
    await device.syncOnce({ maxMs: 10_000 })
  }
  try {
    await sync()
    const result = await fn({ store, identity, sync })
    await sync()
    return result
  } finally {
    await device.close()
    store.close()
  }
}
