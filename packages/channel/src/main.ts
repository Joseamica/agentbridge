import {
  CLI_COMMAND,
  Device,
  acquireChannelLock,
  agentbridgeHome,
  currentProcess,
  describeError,
  handleResponderMessage,
  isProcessAlive,
  loadIdentity,
  nowSeconds,
  openStore,
  releaseChannelLock,
} from '@agentbridge/core'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createChannelServer } from './channel'
import { Dispatcher } from './dispatcher'
import { responderMessageHandler } from './inbound'
import { notifyNewRequests } from './notify'

// A closed stdio pipe makes this throw. Every caller below (the Dispatcher, the Device, this file's
// own shutdown path) depends on log never being the thing that takes the process down, so the write
// itself must swallow its own failure — there is nowhere left to report it.
const log = (message: string) => {
  try {
    process.stderr.write(`[agentbridge] ${message}\n`)
  } catch {
    // Nowhere left to report a broken logger.
  }
}

async function main(): Promise<void> {
  const home = agentbridgeHome()
  const identity = await loadIdentity(home)
  if (!identity) {
    log(`Todavía no hay una identidad de AgentBridge en esta computadora. Créala con: ${CLI_COMMAND} setup`)
    process.exit(1)
  }
  const store = await openStore(home)
  // The lock comes before any network activity: a second channel must not even connect.
  const lock = acquireChannelLock(store, { self: currentProcess(), isAlive: isProcessAlive, now: nowSeconds() })
  if (lock.kind === 'held') {
    // pid 0 is not a real holder: it means acquireChannelLock lost all three of its rounds to
    // concurrent takers (or found no lock row at all). The lock is free, not held by anyone we can
    // name, so saying "process 0 has it" would be a lie.
    if (lock.holder.pid === 0) {
      log('El candado del canal está libre, pero no se pudo tomar en este momento. Intenta de nuevo.')
    } else {
      log(`Ya hay otro canal de AgentBridge abierto con esta identidad (proceso ${lock.holder.pid}). Ciérralo antes de abrir otro.`)
    }
    store.close()
    process.exit(1)
  }
  // Captured once: TypeScript does not carry the narrowing of `lock` into the hoisted shutdown below.
  const epoch = lock.epoch

  const wiring: { dispatcher: Dispatcher | null } = { dispatcher: null }
  const channel = createChannelServer(
    { reply: (args) => (wiring.dispatcher ? wiring.dispatcher.reply(args) : { kind: 'no_active' }) },
    { log },
  )
  const notifyRequests = () => void notifyNewRequests({ store, now: nowSeconds(), log })
  const device = new Device({
    store,
    identity,
    role: 'responder',
    handleMessage: handleResponderMessage,
    log,
    onMessage: responderMessageHandler({ wakeDispatcher: () => wiring.dispatcher?.wake(), notifyRequests, log }),
  })

  // A request stored by another process (a CLI sync) leaves a pending notice in SQLite: try it at start
  // and every minute. Declared before the dispatcher below (whose onFenced calls shutdown(), and
  // shutdown()'s first statement clears this timer) so a fence that somehow fired during construction
  // could never read this `const` while it is still in its temporal dead zone.
  const noticeTimer = setInterval(notifyRequests, 60_000)
  noticeTimer.unref()

  const dispatcher = new Dispatcher({
    store,
    identity,
    epoch,
    deliver: channel.deliverQuestion,
    cancel: channel.cancelQuestion,
    onEnqueued: () => device.wakePublisher(),
    onFenced: () => void shutdown(1),
    log,
  })
  wiring.dispatcher = dispatcher

  let stopping = false
  async function shutdown(code: number): Promise<void> {
    if (stopping) return
    stopping = true
    clearInterval(noticeTimer)
    try {
      await dispatcher.stop()
      await device.close()
      // A fenced channel no longer owns the lock; releasing by its old epoch would be a no-op anyway.
      if (code === 0) releaseChannelLock(store, { epoch })
      store.close()
    } catch (err) {
      // Every caller below fires this with `void`: a throw here (SQLITE_BUSY closing a contended
      // home, for example) must never escape as an unhandled rejection, or process.exit below never
      // runs and a clean SIGTERM turns into a dirty exit that still holds the lock.
      log(`shutdown failed (${describeError(err)})`)
    } finally {
      process.exit(code)
    }
  }
  process.on('SIGTERM', () => void shutdown(0))
  process.on('SIGINT', () => void shutdown(0))
  process.stdin.on('end', () => void shutdown(0))

  await channel.server.connect(new StdioServerTransport())
  device.start()
  dispatcher.start()
  notifyRequests()
  log('channel started')
}

main().catch((err: unknown) => {
  log(`could not start (${describeError(err)})`)
  process.exit(1)
})
