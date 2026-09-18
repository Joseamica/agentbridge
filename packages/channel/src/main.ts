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

const log = (message: string) => process.stderr.write(`[agentbridge] ${message}\n`)

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
    log(`Ya hay otro canal de AgentBridge abierto con esta identidad (proceso ${lock.holder.pid}). Ciérralo antes de abrir otro.`)
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

  // A request stored by another process (a CLI sync) leaves a pending notice in SQLite: try it at start
  // and every minute.
  const noticeTimer = setInterval(notifyRequests, 60_000)
  noticeTimer.unref()

  let stopping = false
  async function shutdown(code: number): Promise<void> {
    if (stopping) return
    stopping = true
    clearInterval(noticeTimer)
    await dispatcher.stop()
    await device.close()
    // A fenced channel no longer owns the lock; releasing by its old epoch would be a no-op anyway.
    if (code === 0) releaseChannelLock(store, { epoch })
    store.close()
    process.exit(code)
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
