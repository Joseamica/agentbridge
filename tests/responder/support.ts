import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  BoardPool,
  Device,
  SeenIds,
  acquireChannelLock,
  approveConnection,
  createRumor,
  handleResponderMessage,
  nowSeconds,
  openStore,
  openWrap,
  precheckWrap,
  recordIncomingRequest,
  setProfile,
  wrapRumor,
  type Identity,
  type Message,
  type OpenedMessage,
  type PrecheckedWrap,
  type ResponderInboundOutcome,
  type Rumor,
  type Store,
} from '@agentbridge/core'
import { createChannelServer } from '../../packages/channel/src/channel'
import { Dispatcher, type ReplyArgs } from '../../packages/channel/src/dispatcher'
import { plainSocketFactory } from '../../packages/core/test/support/fake-board'

export { startFakeBoard, type FakeBoard, type FakeBoardOptions } from '../../packages/core/test/support/fake-board'
export { testIdentity } from '../../packages/core/test/support/keys'

export type Cleanups = Array<() => unknown>
export type Clock = { now: number }
export type ChannelNote = { content: string; meta: Record<string, string> }

export const allowAnyRelay = (inputs: readonly unknown[]): string[] => inputs.filter((x): x is string => typeof x === 'string').slice(0, 5)

export async function until(check: () => boolean, ms = 20_000, label = 'a condition'): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

export type ResponderHarness = {
  home: string
  store: Store
  device: Device<ResponderInboundOutcome>
  dispatcher: Dispatcher
  notes: ChannelNote[]
  questions(): ChannelNote[]
  cancellations(): ChannelNote[]
  reply(args: ReplyArgs): Promise<{ text: string; isError: boolean }>
  stop(): Promise<void>
}

export async function startResponder(input: {
  identity: Identity
  relays: string[]
  cleanups: Cleanups
  home?: string
  clock?: Clock
  attemptTimeoutMs?: number
  seed?: (store: Store) => void
}): Promise<ResponderHarness> {
  const home = input.home ?? join(await mkdtemp(join(tmpdir(), 'ab-responder-')), 'home')
  const store = await openStore(home, { relayPolicy: allowAnyRelay })
  const now = () => (input.clock ? input.clock.now : nowSeconds())
  setProfile(store, { name: 'Ana', relays: input.relays, now: now() })
  input.seed?.(store)
  const lock = acquireChannelLock(store, { self: { pid: process.pid, start: `harness-${randomUUID()}` }, isAlive: () => false, now: now() })
  if (lock.kind !== 'acquired') throw new Error('the harness could not take the channel lock')

  const notes: ChannelNote[] = []
  const wiring: { dispatcher: Dispatcher | null } = { dispatcher: null }
  const channel = createChannelServer({ reply: (args) => (wiring.dispatcher ? wiring.dispatcher.reply(args) : { kind: 'no_active' }) })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const claude = new Client({ name: 'fake-claude', version: '0.0.0' })
  claude.fallbackNotificationHandler = async (notification) => {
    const params = (notification as { params?: { content?: string; meta?: Record<string, string> } }).params
    notes.push({ content: params?.content ?? '', meta: params?.meta ?? {} })
  }
  await Promise.all([channel.server.connect(serverTransport), claude.connect(clientTransport)])

  const device = new Device({
    store,
    identity: input.identity,
    role: 'responder',
    handleMessage: handleResponderMessage,
    createSocket: plainSocketFactory,
    now,
    pool: { timeoutMs: 2_000, reconnectDelaysMs: [100] },
    publishIntervalMs: 250,
    onMessage: (_opened, outcome) => {
      if (outcome.kind === 'question') wiring.dispatcher?.wake()
    },
  })
  const dispatcher = new Dispatcher({
    store,
    identity: input.identity,
    epoch: lock.epoch,
    deliver: channel.deliverQuestion,
    cancel: channel.cancelQuestion,
    onEnqueued: () => device.wakePublisher(),
    attemptTimeoutMs: input.attemptTimeoutMs,
    pollMs: 50,
    nowMs: () => (input.clock ? input.clock.now * 1000 : Date.now()),
  })
  wiring.dispatcher = dispatcher
  device.start()
  dispatcher.start()

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await dispatcher.stop()
    await device.close()
    await claude.close()
    store.close()
  }
  input.cleanups.push(stop)

  return {
    home,
    store,
    device,
    dispatcher,
    notes,
    questions: () => notes.filter((note) => note.meta.event !== 'cancelled'),
    cancellations: () => notes.filter((note) => note.meta.event === 'cancelled'),
    reply: async (args) => {
      const result = await claude.callTool({ name: 'reply', arguments: args })
      return { text: (result.content as Array<{ text: string }>)[0]?.text ?? '', isError: result.isError === true }
    },
    stop,
  }
}

// The asker side, built from plan 1's primitives only: plan 3 builds the real asker service.
export class FakeAsker {
  readonly pool: BoardPool
  readonly received: OpenedMessage[] = []
  private readonly seen = new SeenIds()

  constructor(
    readonly identity: Identity,
    readonly relays: string[],
    cleanups: Cleanups,
  ) {
    this.pool = new BoardPool({ identity, createSocket: plainSocketFactory, timeoutMs: 2_000, reconnectDelaysMs: [100] })
    cleanups.push(() => this.close())
  }

  listen(): void {
    this.pool.subscribeLive<PrecheckedWrap>(this.relays, {
      precheck: (raw) => {
        const pre = precheckWrap(raw, { identity: this.identity, now: nowSeconds(), seen: this.seen })
        return pre.ok ? pre : null
      },
      process: async (item) => {
        const opened = openWrap(item, { identity: this.identity, now: nowSeconds(), seen: this.seen })
        if (opened.ok) this.received.push(opened)
      },
    })
  }

  // Passing an earlier rumor resends that same rumor in a fresh wrap, exactly like a real retry.
  async send(to: { publicKey: string; relays: string[] }, message: Message, options: { rumor?: Rumor; createdAt?: number } = {}): Promise<Rumor> {
    const rumor = options.rumor ?? createRumor(message, this.identity, options.createdAt ?? nowSeconds())
    const wrap = await wrapRumor(rumor, this.identity, to.publicKey, { now: nowSeconds() })
    const outcome = await this.pool.publish(to.relays, wrap)
    if (outcome.accepted.length === 0) throw new Error(`no relay accepted the ${message.type}`)
    return rumor
  }

  messages<K extends Message['type']>(type: K): Array<Extract<Message, { type: K }>> {
    return this.received.map((opened) => opened.message).filter((message): message is Extract<Message, { type: K }> => message.type === type)
  }

  close(): Promise<void> {
    return this.pool.close()
  }
}

export function seedApprovedContact(store: Store, input: { responder: Identity; asker: Identity; askerRelays: string[]; now: number }): void {
  recordIncomingRequest(store, {
    pubkey: input.asker.publicKey,
    requestId: randomUUID(),
    requestRumorId: randomBytes(32).toString('hex'),
    declaredName: 'Beto',
    note: '',
    relays: input.askerRelays,
    now: input.now,
  })
  approveConnection(store, { identity: input.responder, idPrefix: input.asker.publicKey.slice(0, 8), now: input.now })
}
