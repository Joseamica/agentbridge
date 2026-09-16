import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardConnection, createPinnedSocketFactory, createSafeLookup, pinnedSocketFactory, type SubscriptionHandlers } from '@agentbridge/core'
import { plainSocketFactory, startFakeBoard, type FakeBoardOptions } from './support/fake-board'
import { testIdentity } from './support/keys'

const me = testIdentity(5)
const other = testIdentity(6)
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function setup(options: FakeBoardOptions = {}) {
  const board = await startFakeBoard(options)
  const conn = new BoardConnection({ url: board.url, identity: me, createSocket: plainSocketFactory, timeoutMs: 2_000 })
  cleanups.push(() => board.close(), () => conn.close())
  await conn.connect()
  return { board, conn }
}

const wrapFor = (content: string, created_at = 1_000): NostrEvent =>
  finalizeEvent({ kind: 1059, created_at, tags: [['p', me.publicKey]], content }, other.secretKey)

function recorder(onEvent?: (raw: unknown) => void | Promise<void>) {
  const events: unknown[] = []
  let eose = 0
  const closed: string[] = []
  const handlers: SubscriptionHandlers = {
    onEvent: async (e) => {
      events.push(e)
      await onEvent?.(e)
    },
    onEose: () => eose++,
    onClosed: (r) => closed.push(r),
  }
  return { handlers, events, closed, eose: () => eose }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

describe('BoardConnection', () => {
  it('publishes and reports the relay verdict', async () => {
    const { conn } = await setup()
    const event = wrapFor('hola')
    expect(await conn.publish(event)).toEqual({ ok: true, message: '' })
    expect(await conn.publish(event)).toEqual({ ok: true, message: 'duplicate: already have this event' })
  })

  it('reports a rejection without throwing', async () => {
    const { conn } = await setup({ maxFrameBytes: 300 })
    expect(await conn.publish(wrapFor('x'.repeat(400)))).toEqual({ ok: false, message: 'invalid: event too large' })
  })

  it('authenticates once and retries when publishing requires auth', async () => {
    const { board, conn } = await setup({ requireAuthToWrite: true })
    expect(await conn.publish(wrapFor('con auth'))).toEqual({ ok: true, message: '' })
    expect(board.authenticated.has(me.publicKey)).toBe(true)
    expect(board.frames.filter((f) => f[0] === 'AUTH')).toHaveLength(1)
  })

  it('returns the auth-required verdict when the relay never sent a challenge', async () => {
    const { conn } = await setup({ requireAuthToWrite: true, sendAuthChallenge: false })
    expect(await conn.publish(wrapFor('sin reto'))).toMatchObject({ ok: false, message: expect.stringMatching(/^auth-required:/) })
  })

  it('never writes the event when the guard refuses right before sending', async () => {
    const { board, conn } = await setup()
    expect(await conn.publish(wrapFor('vetado'), () => false)).toEqual({ ok: false, message: 'error: publish guard refused' })
    expect(board.frames.filter((f) => f[0] === 'EVENT')).toHaveLength(0)
  })

  it('runs the guard again before the write that follows authentication', async () => {
    const { conn } = await setup({ requireAuthToWrite: true })
    let calls = 0
    expect(await conn.publish(wrapFor('dos veces'), () => ++calls <= 2)).toEqual({ ok: true, message: '' })
    expect(calls).toBe(2)
    let refused = 0
    const { conn: second } = await setup({ requireAuthToWrite: true })
    expect(await second.publish(wrapFor('segunda vez no'), () => ++refused === 1)).toEqual({ ok: false, message: 'error: publish guard refused' })
  })

  it('serves stored events, then EOSE, then live events', async () => {
    const { board, conn } = await setup()
    board.inject(wrapFor('guardado', 500))
    const r = recorder()
    conn.subscribe('s', [{ kinds: [1059], '#p': [me.publicKey] }], r.handlers)
    await until(() => r.eose() === 1)
    expect(r.events).toHaveLength(1)
    board.inject(wrapFor('en vivo', 600))
    await until(() => r.events.length === 2)
  })

  it('waits for a slow event handler before reading the next frame', async () => {
    const { board, conn } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const r = recorder(async (raw) => {
      if ((raw as NostrEvent).content === 'primero') await gate
    })
    conn.subscribe('s', [{ kinds: [1059] }], r.handlers)
    await until(() => r.eose() === 1)
    board.inject(wrapFor('primero', 700))
    board.inject(wrapFor('segundo', 701))
    await until(() => r.events.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(r.events).toHaveLength(1)
    release()
    await until(() => r.events.length === 2)
  })

  it('authenticates and re-subscribes when reading requires auth', async () => {
    const { board, conn } = await setup({ requireAuthToRead: true })
    board.inject(wrapFor('privado', 700))
    const r = recorder()
    conn.subscribe('s', [{ kinds: [1059] }], r.handlers)
    await until(() => r.eose() === 1)
    expect(r.events).toHaveLength(1)
    expect(r.closed).toEqual([])
  })

  it('passes a non-auth CLOSED reason through without retrying', async () => {
    const { board, conn } = await setup({ rejectReads: true })
    const r = recorder()
    conn.subscribe('s', [{ kinds: [1059] }], r.handlers)
    await until(() => r.closed.length === 1)
    expect(r.closed).toEqual(['restricted: reads are disabled'])
    expect(board.frames.filter((f) => f[0] === 'REQ')).toHaveLength(1)
  })

  it('closes subscriptions and pending publishes when the socket drops', async () => {
    const { board, conn } = await setup({ ignoreReads: true })
    const r = recorder()
    conn.subscribe('s', [{ kinds: [1059] }], r.handlers)
    let closedEvent = false
    conn.on('close', () => (closedEvent = true))
    board.disconnectAll()
    await until(() => closedEvent)
    expect(r.closed).toEqual(['error: connection closed'])
    expect(conn.isOpen).toBe(false)
    expect(await conn.publish(wrapFor('tarde'))).toEqual({ ok: false, message: 'error: connection closed' })
  })

  // Ruling 8: the receive pipeline must check event size before doing anything more expensive,
  // such as JSON.parse. A frame larger than the wrap cap (plus room for the REQ envelope) is
  // skipped instead of parsed, and the connection stays open for the next, well-sized frame.
  it('skips frames larger than the wrap cap without closing the connection', async () => {
    const { board, conn } = await setup()
    const r = recorder()
    conn.subscribe('s', [{ kinds: [1059] }], r.handlers)
    await until(() => r.eose() === 1)
    board.inject(wrapFor('x'.repeat(70_000), 800))
    board.inject(wrapFor('pequeño', 801))
    await until(() => r.events.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(r.events).toHaveLength(1)
    expect((r.events[0] as NostrEvent).content).toBe('pequeño')
    expect(conn.isOpen).toBe(true)
  })
})

describe('pinned socket factory', () => {
  it.each(['ws://relay.example.com', 'wss://127.0.0.1:7777', 'wss://[::1]', 'wss://localhost:9', 'wss://relay.example.com/?x=1'])(
    'refuses %s before opening any socket',
    (url) => {
      expect(() => pinnedSocketFactory(url)).toThrow(/tablero/)
    },
  )

  it('refuses to connect when the validated name resolves to a forbidden address', async () => {
    const factory = createPinnedSocketFactory(createSafeLookup(async () => [{ address: '10.0.0.1', family: 4 }]))
    const socket = factory('wss://relay.example.com')
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => socket.once('error', resolve))
    expect(error.code).toBe('EAGENTBRIDGE_FORBIDDEN_ADDRESS')
  })
})
