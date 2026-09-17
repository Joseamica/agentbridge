import type { AddressInfo } from 'node:net'
import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  BoardConnection,
  createPinnedSocketFactory,
  createSafeLookup,
  pinnedSocketFactory,
  type SocketFactory,
  type SubscriptionHandlers,
} from '@agentbridge/core'
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

  // Ruling 9 (amends Ruling 8): an oversize EVENT frame is still never JSON.parse'd, but instead
  // of being dropped silently, the subscription receives `null` in the position the real event
  // would have occupied. A history page (Task 15) can then count what the relay actually returned
  // instead of looking shorter than it was — a gap an attacker could otherwise exploit to hide a
  // genuine wrap that shares the oldest second in a page.
  it('hands an oversize event to its subscription as null, without parsing it or closing the connection', async () => {
    const { board, conn } = await setup()
    const r = recorder()
    conn.subscribe('s', [{ kinds: [1059] }], r.handlers)
    await until(() => r.eose() === 1)
    board.inject(wrapFor('x'.repeat(70_000), 800))
    board.inject(wrapFor('pequeño', 801))
    await until(() => r.events.length === 2)
    expect(r.events[0]).toBeNull()
    expect((r.events[1] as NostrEvent).content).toBe('pequeño')
    expect(conn.isOpen).toBe(true)

    // A wrap whose frame lands just under the cap must still be delivered as the real event.
    const justUnderCap = wrapFor('x'.repeat(66_120), 802)
    const frameBytes = Buffer.byteLength(JSON.stringify(['EVENT', 's', justUnderCap]))
    expect(frameBytes).toBeLessThanOrEqual(65_536 + 1_024)
    board.inject(justUnderCap)
    await until(() => r.events.length === 3)
    expect(r.events[2]).not.toBeNull()
    expect((r.events[2] as NostrEvent).id).toBe(justUnderCap.id)
  })

  // Ruling 10a: a handler that throws is logged, never stops the reader and never crashes the
  // process. This covers onEose; a separate test below covers onClosed reached through the
  // auth-retry continuation, which is the path most prone to becoming an unhandled rejection.
  it('logs a throwing onEose handler, keeps the connection open and still delivers later events', async () => {
    const board = await startFakeBoard()
    const logs: string[] = []
    const conn = new BoardConnection({
      url: board.url,
      identity: me,
      createSocket: plainSocketFactory,
      timeoutMs: 2_000,
      log: (line) => logs.push(line),
    })
    cleanups.push(() => board.close(), () => conn.close())
    await conn.connect()
    const events: unknown[] = []
    conn.subscribe('s', [{ kinds: [1059] }], {
      onEvent: (e) => {
        events.push(e)
      },
      onEose: () => {
        throw new Error('boom')
      },
      onClosed: () => {},
    })
    await until(() => logs.some((line) => line.includes('eose handler failed')))
    expect(conn.isOpen).toBe(true)
    board.inject(wrapFor('después', 900))
    await until(() => events.length === 1)
  })

  it('logs a throwing onClosed handler reached through an auth retry, with no unhandled rejection', async () => {
    const board = await startFakeBoard({ requireAuthToRead: true, sendAuthChallenge: false })
    const logs: string[] = []
    const conn = new BoardConnection({
      url: board.url,
      identity: me,
      createSocket: plainSocketFactory,
      timeoutMs: 2_000,
      log: (line) => logs.push(line),
    })
    cleanups.push(() => board.close(), () => conn.close())
    await conn.connect()
    conn.subscribe('s', [{ kinds: [1059] }], {
      onEvent: () => {},
      onEose: () => {},
      onClosed: () => {
        throw new Error('closed boom')
      },
    })
    await until(() => logs.some((line) => line.includes('closed handler failed')))
  })

  // Ruling 10b: after unsubscribe()+subscribe() reuse the same id while an auth retry from the
  // old subscription is still in flight, the old continuation must not touch the new subscription
  // — neither closing it (auth failed) nor re-sending its predecessor's filters under its id
  // (auth succeeded).
  it('keeps an auth retry from touching a new subscription that reused the same id', async () => {
    const reqs: unknown[][] = []
    let authFrame: unknown[] | undefined
    let releaseAuth!: () => void
    const authGate = new Promise<void>((resolve) => (releaseAuth = resolve))
    let sentClosedForH = false

    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
    server.on('connection', (socket) => {
      socket.send(JSON.stringify(['AUTH', 'challenge']))
      socket.on('message', (data) => {
        const frame = JSON.parse(String(data)) as unknown[]
        if (frame[0] === 'REQ') {
          reqs.push(frame)
          if (frame[1] === 'h' && !sentClosedForH) {
            sentClosedForH = true
            socket.send(JSON.stringify(['CLOSED', 'h', 'auth-required: test']))
          }
          return
        }
        if (frame[0] === 'AUTH') {
          authFrame = frame
          void authGate.then(() => {
            const auth = frame[1] as { id: string }
            socket.send(JSON.stringify(['OK', auth.id, true, '']))
          })
        }
      })
    })
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))

    const conn = new BoardConnection({ url, identity: me, createSocket: plainSocketFactory, timeoutMs: 2_000 })
    cleanups.push(() => conn.close())
    await conn.connect()

    const oldSub = recorder()
    conn.subscribe('h', [{ kinds: [1] }], oldSub.handlers)
    await until(() => authFrame !== undefined)

    conn.unsubscribe('h')
    const newSub = recorder()
    conn.subscribe('h', [{ kinds: [2] }], newSub.handlers)

    releaseAuth()
    await until(() => reqs.filter((r) => r[1] === 'h').length >= 2)
    // Give the (possibly buggy) auth-retry continuation a moment to run.
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(newSub.closed).toEqual([])
    const hReqs = reqs.filter((r) => r[1] === 'h')
    expect(hReqs.at(-1)?.[2]).toEqual({ kinds: [2] })
  })

  // Minor: connect() must call createSocket again on a later attempt after an earlier one threw,
  // instead of permanently caching that first rejection.
  it('lets a later connect() try again after createSocket throws once', async () => {
    const board = await startFakeBoard()
    cleanups.push(() => board.close())
    let calls = 0
    const flakyFactory: SocketFactory = (u) => {
      calls++
      if (calls === 1) throw new Error('boom')
      return plainSocketFactory(u)
    }
    const conn = new BoardConnection({ url: board.url, identity: me, createSocket: flakyFactory, timeoutMs: 2_000 })
    cleanups.push(() => conn.close())
    await expect(conn.connect()).rejects.toThrow('boom')
    await expect(conn.connect()).resolves.toBeUndefined()
    expect(conn.isOpen).toBe(true)
  })
})

// Ruling 25: a half-open socket (laptop sleep, Wi-Fi change, NAT drop) never errors on its own.
// The connection pings every `heartbeatMs` and terminates the socket after three silent intervals.
describe('BoardConnection heartbeat', () => {
  async function watched(options: FakeBoardOptions = {}) {
    const board = await startFakeBoard(options)
    const conn = new BoardConnection({ url: board.url, identity: me, createSocket: plainSocketFactory, timeoutMs: 2_000, heartbeatMs: 50 })
    cleanups.push(() => board.close(), () => conn.close())
    let closedAt: number | null = null
    conn.on('close', () => (closedAt = Date.now()))
    await conn.connect()
    return { board, conn, closedAt: () => closedAt }
  }

  it('terminates a socket whose relay went silent, closing its subscriptions', async () => {
    const { board, conn, closedAt } = await watched()
    const r = recorder()
    conn.subscribe('s', [{ kinds: [1059] }], r.handlers)
    await until(() => r.eose() === 1)
    const silentAt = Date.now()
    board.goSilent()
    await until(() => closedAt() !== null)
    expect(closedAt()! - silentAt).toBeLessThan(400)
    expect(conn.isOpen).toBe(false)
    expect(r.closed).toEqual(['error: connection closed'])
  })

  it('keeps a quiet socket open while the relay answers pings', async () => {
    const { conn, closedAt } = await watched()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(closedAt()).toBeNull()
    expect(conn.isOpen).toBe(true)
  })

  it('does not count time blocked inside an event handler as silence', async () => {
    const { board, conn, closedAt } = await watched()
    // Enough frames behind the blocked one that ws pauses the socket, so pongs stop being read too.
    const behind = Array.from({ length: 60 }, (_, i) => wrapFor(`detrás ${i}`, 701))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const r = recorder(async (raw) => {
      if ((raw as NostrEvent).content === 'lento') await gate
    })
    conn.subscribe('s', [{ kinds: [1059] }], r.handlers)
    await until(() => r.eose() === 1)
    board.inject(wrapFor('lento', 700))
    for (const event of behind) board.inject(event)
    await until(() => r.events.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(closedAt()).toBeNull()
    release()
    await until(() => r.events.length === 1 + behind.length)
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
