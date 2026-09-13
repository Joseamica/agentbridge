import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { authHeader, buildTestApp, enrollViaApi, resetDb, testPool } from '../../../apps/relay/test/helpers'
import { RelayWsClient, type CancelMessage, type QuestionMessage, type WsLike } from '../src/relay-client'

async function until(check: () => boolean, ms = 4000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('RelayWsClient against a real relay', () => {
  let pool: pg.Pool
  let app: FastifyInstance
  let relayUrl: string
  let devToken: string
  let amievaToken: string
  let client: RelayWsClient | null = null

  beforeAll(async () => {
    pool = await testPool()
  })
  beforeEach(async () => {
    await resetDb(pool)
    app = (await buildTestApp(pool)).app
    await app.listen({ port: 0, host: '127.0.0.1' })
    relayUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    devToken = await enrollViaApi(app, 'dev', 'Dev Ejemplo')
    amievaToken = await enrollViaApi(app, 'amieva', 'Amieva')
    const inv = await app.inject({ method: 'POST', url: '/v1/contact-invites', headers: authHeader(devToken) })
    const code = (inv.json() as { acceptUrl: string }).acceptUrl.split('/').pop()!
    await app.inject({ method: 'POST', url: '/v1/contact-invites/accept', headers: authHeader(amievaToken), payload: { code } })
  })
  afterEach(async () => {
    client?.stop()
    client = null
    await app.close()
  })
  afterAll(async () => {
    await pool.end()
  })

  it('builds the responder URL from an http or https relay URL', () => {
    expect(RelayWsClient.responderUrl('https://r.example.com/')).toBe('wss://r.example.com/v1/responder')
    expect(RelayWsClient.responderUrl('http://127.0.0.1:9')).toBe('ws://127.0.0.1:9/v1/responder')
  })

  it('receives a question and gets the answer accepted', async () => {
    const questions: QuestionMessage[] = []
    let connectedAs = ''
    client = new RelayWsClient({ relayUrl, token: devToken, log: () => {} })
    client.onConnected((h) => (connectedAs = h))
    client.onQuestion((m) => questions.push(m))
    client.start()
    await until(() => connectedAs === 'dev')

    await app.inject({ method: 'POST', url: '/v1/tickets', headers: authHeader(amievaToken), payload: { to: 'dev', question: '¿Cuál es el timeout?' } })
    await until(() => questions.length === 1)
    const q = questions[0]!
    expect(q.from).toEqual({ handle: 'amieva', displayName: 'Amieva' })

    const wrong = await client.sendAnswer({ attemptId: q.attemptId, code: q.code === 'AAAA' ? 'BBBB' : 'AAAA', text: 'x', source: 'y', confidence: 'creo' })
    expect(wrong).toBe('rejected')
    const right = await client.sendAnswer({ attemptId: q.attemptId, code: q.code, text: '45 s', source: 'config/timeouts.yaml', confidence: 'seguro' })
    expect(right).toBe('accepted')
  })

  it('stops reconnecting when the relay rejects the token', async () => {
    const logs: string[] = []
    let opened = 0
    client = new RelayWsClient({
      relayUrl,
      token: 'x'.repeat(43),
      backoffMs: () => 10,
      log: (m) => logs.push(m),
      createSocket: (url) => {
        opened++
        return new WebSocket(url) as unknown as WsLike
      },
    })
    client.start()
    await until(() => logs.some((l) => l.includes('4401')))
    await new Promise((r) => setTimeout(r, 200))
    expect(opened).toBe(1)
  })
})

describe('RelayWsClient reconnect logic', () => {
  class ScriptedSocket implements WsLike {
    readyState = 0
    sent: string[] = []
    private listeners: Record<string, ((e: { data?: unknown; code?: number }) => void)[]> = {}
    addEventListener(type: string, fn: (e: { data?: unknown; code?: number }) => void) {
      ;(this.listeners[type] ??= []).push(fn)
    }
    emit(type: string, e: { data?: unknown; code?: number } = {}) {
      if (type === 'open') this.readyState = 1
      if (type === 'close') this.readyState = 3
      for (const fn of this.listeners[type] ?? []) fn(e)
    }
    send(data: string) {
      this.sent.push(data)
    }
    close() {
      this.emit('close', { code: 1000 })
    }
  }

  // A real WebSocket's close() only *initiates* the close handshake; the 'close' event
  // fires asynchronously afterwards. ScriptedSocket's close() re-enters synchronously
  // instead, which would hide a bug where stop() nulls this.ws before that event arrives.
  class AsyncCloseSocket extends ScriptedSocket {
    override close() {
      setTimeout(() => this.emit('close', { code: 1000 }), 0)
    }
  }

  it('reconnects after an abnormal close and stops when replaced by another session', async () => {
    const sockets: ScriptedSocket[] = []
    let disconnects = 0
    const client = new RelayWsClient({
      relayUrl: 'http://relay.test',
      token: 't'.repeat(43),
      backoffMs: () => 5,
      log: () => {},
      createSocket: () => {
        const s = new ScriptedSocket()
        sockets.push(s)
        return s
      },
    })
    client.onDisconnect(() => disconnects++)
    client.start()
    sockets[0]!.emit('open')
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: 'auth', token: 't'.repeat(43) })

    sockets[0]!.emit('close', { code: 1006 })
    await until(() => sockets.length === 2)
    expect(disconnects).toBe(1)

    sockets[1]!.emit('close', { code: 4000 })
    await new Promise((r) => setTimeout(r, 50))
    expect(sockets).toHaveLength(2)
    client.stop()
  })

  it('resolves sendAnswer as rejected when the socket is not open', async () => {
    const client = new RelayWsClient({ relayUrl: 'http://relay.test', token: 't'.repeat(43), log: () => {}, createSocket: () => new ScriptedSocket() })
    client.start()
    expect(await client.sendAnswer({ attemptId: 'a', code: 'AAAA', text: 'x', source: 'y', confidence: 'creo' })).toBe('rejected')
    client.stop()
  })

  it('sends a ping on the wire on the configured interval after auth_ok', async () => {
    const sockets: ScriptedSocket[] = []
    const client = new RelayWsClient({
      relayUrl: 'http://relay.test',
      token: 't'.repeat(43),
      pingIntervalMs: 15,
      log: () => {},
      createSocket: () => {
        const s = new ScriptedSocket()
        sockets.push(s)
        return s
      },
    })
    client.start()
    sockets[0]!.emit('open')
    sockets[0]!.emit('message', { data: JSON.stringify({ type: 'auth_ok', handle: 'dev' }) })

    await until(() => sockets[0]!.sent.some((m) => JSON.parse(m).type === 'ping'))
    const ping = sockets[0]!.sent.map((m) => JSON.parse(m)).find((m) => m.type === 'ping')
    expect(ping).toEqual({ type: 'ping' })
    client.stop()
  })

  it('delivers a cancel message to the registered onCancel handler', async () => {
    const sockets: ScriptedSocket[] = []
    const cancels: CancelMessage[] = []
    const client = new RelayWsClient({
      relayUrl: 'http://relay.test',
      token: 't'.repeat(43),
      log: () => {},
      createSocket: () => {
        const s = new ScriptedSocket()
        sockets.push(s)
        return s
      },
    })
    client.onCancel((m) => cancels.push(m))
    client.start()
    sockets[0]!.emit('open')
    sockets[0]!.emit('message', { data: JSON.stringify({ type: 'auth_ok', handle: 'dev' }) })

    const attemptId = randomUUID()
    sockets[0]!.emit('message', { data: JSON.stringify({ type: 'cancel', attemptId, reason: 'timeout' }) })

    expect(cancels).toEqual([{ type: 'cancel', attemptId, reason: 'timeout' }])
    client.stop()
  })

  it('cancels a pending reconnect on stop() so a later start() does not orphan the live connection', async () => {
    const sockets: ScriptedSocket[] = []
    const client = new RelayWsClient({
      relayUrl: 'http://relay.test',
      token: 't'.repeat(43),
      backoffMs: () => 30,
      log: () => {},
      createSocket: () => {
        const s = new ScriptedSocket()
        sockets.push(s)
        return s
      },
    })
    client.start()
    sockets[0]!.emit('open')
    sockets[0]!.emit('message', { data: JSON.stringify({ type: 'auth_ok', handle: 'dev' }) })
    sockets[0]!.emit('close', { code: 1006 }) // schedules a reconnect after 30ms via backoffMs

    // Interleave stop()/start() before the stale backoff timer would fire.
    client.stop()
    client.start()

    // Give the stale timer, if not cancelled, more than enough time to fire and create a stray socket.
    await new Promise((r) => setTimeout(r, 90))
    expect(sockets).toHaveLength(2)

    sockets[1]!.emit('open')
    sockets[1]!.emit('message', { data: JSON.stringify({ type: 'auth_ok', handle: 'dev' }) })

    const attemptId = randomUUID()
    const answer = client.sendAnswer({ attemptId, code: 'AAAA', text: 'x', source: 'y', confidence: 'creo' })
    sockets[1]!.emit('message', { data: JSON.stringify({ type: 'answer_accepted', attemptId }) })
    expect(await answer).toBe('accepted')

    client.stop()
  })

  it('still emits disconnect from stop() when the close event only arrives after this.ws is already null', async () => {
    // Regression test: stop() nulls this.ws synchronously, then calls ws.close(). Against a
    // real WebSocket the 'close' event fires later, asynchronously — by then this.ws is
    // already null even though no newer generation has taken over. The close handler must
    // still treat that as a real disconnect (and channel.ts relies on this to cancel the
    // in-flight question and notify the session), not silently swallow it as "stale".
    const sockets: AsyncCloseSocket[] = []
    let disconnects = 0
    const client = new RelayWsClient({
      relayUrl: 'http://relay.test',
      token: 't'.repeat(43),
      log: () => {},
      createSocket: () => {
        const s = new AsyncCloseSocket()
        sockets.push(s)
        return s
      },
    })
    client.onDisconnect(() => disconnects++)
    client.start()
    sockets[0]!.emit('open')
    sockets[0]!.emit('message', { data: JSON.stringify({ type: 'auth_ok', handle: 'dev' }) })

    client.stop()
    await until(() => disconnects === 1)
    expect(sockets).toHaveLength(1) // stopped, so no reconnect was scheduled
  })

  it('ignores a stopped socket\'s late close once a fresh start() has already taken over', async () => {
    // The flip side of the fix above: a stale generation's async close arriving after
    // stop()+start() replaced it must still be ignored, or it would incorrectly tear down
    // the new, live connection's state.
    const sockets: AsyncCloseSocket[] = []
    let disconnects = 0
    const client = new RelayWsClient({
      relayUrl: 'http://relay.test',
      token: 't'.repeat(43),
      log: () => {},
      createSocket: () => {
        const s = new AsyncCloseSocket()
        sockets.push(s)
        return s
      },
    })
    client.onDisconnect(() => disconnects++)
    client.start()
    sockets[0]!.emit('open')
    sockets[0]!.emit('message', { data: JSON.stringify({ type: 'auth_ok', handle: 'dev' }) })

    client.stop() // schedules sockets[0]'s async close via setTimeout
    client.start() // immediately replaces it with sockets[1] before that close fires
    sockets[1]!.emit('open')
    sockets[1]!.emit('message', { data: JSON.stringify({ type: 'auth_ok', handle: 'dev' }) })

    await new Promise((r) => setTimeout(r, 20)) // let sockets[0]'s stale close event fire
    expect(disconnects).toBe(0) // the stale close must not be reported as a disconnect...

    const attemptId = randomUUID()
    const answer = client.sendAnswer({ attemptId, code: 'AAAA', text: 'x', source: 'y', confidence: 'creo' })
    sockets[1]!.emit('message', { data: JSON.stringify({ type: 'answer_accepted', attemptId }) })
    expect(await answer).toBe('accepted') // ...nor clobber the new socket's live state

    client.stop()
  })

  it('ignores an orphaned generation\'s stale close during another generation\'s reconnect backoff window', async () => {
    // Fix round 1 regression test. The null-permissive guard this replaced
    // (`this.ws !== null && this.ws !== ws`) re-admitted a stale close whenever `this.ws`
    // happened to be null, not only when nothing newer had taken over. Concretely: an
    // orphaned generation A (superseded by a second start() without ever closing — not
    // reachable through today's single-call wiring in main.ts, but reachable through this
    // class's own public API) can have its close event arrive late, *after* the live
    // generation B has already dropped abnormally, nulled this.ws itself, and scheduled its
    // own reconnect. A's belated close (e.g. a 4000 from the relay, meaning "another session
    // took over") would then flip `stopped` back to true and permanently suppress B's
    // already-scheduled reconnect — the responder goes offline with no recognisable log,
    // because the disconnect log line reads exactly like the ordinary "another session took
    // over" case. The generation counter fixes this: A's close closes over an older `gen`
    // that no longer matches `this.generation`, so it is ignored regardless of `this.ws`.
    const sockets: ScriptedSocket[] = []
    const client = new RelayWsClient({
      relayUrl: 'http://relay.test',
      token: 't'.repeat(43),
      backoffMs: () => 20,
      log: () => {},
      createSocket: () => {
        const s = new ScriptedSocket()
        sockets.push(s)
        return s
      },
    })
    client.start() // generation 1: socket A
    sockets[0]!.emit('open')
    sockets[0]!.emit('message', { data: JSON.stringify({ type: 'auth_ok', handle: 'dev' }) })

    client.start() // orphans A without closing it; generation 2: socket B
    sockets[1]!.emit('open')
    sockets[1]!.emit('message', { data: JSON.stringify({ type: 'auth_ok', handle: 'dev' }) })

    sockets[1]!.emit('close', { code: 1006 }) // B drops abnormally, schedules a reconnect in 20ms

    // A's stale close arrives inside B's backoff window, after B's own close already nulled
    // this.ws. A 4000 here would (with the old guard) be misread as "this connection was
    // replaced" and set stopped = true.
    sockets[0]!.emit('close', { code: 4000 })

    // The reconnect B scheduled must still happen — proof that `stopped` was never flipped.
    await until(() => sockets.length === 3)
    sockets[2]!.emit('open')
    sockets[2]!.emit('message', { data: JSON.stringify({ type: 'auth_ok', handle: 'dev' }) })

    client.stop()
  })
})
