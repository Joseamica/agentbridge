import { EventEmitter } from 'node:events'
import { makeAuthEvent } from 'nostr-tools/nip42'
import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure'
import WebSocket, { createWebSocketStream } from 'ws'
import type { Identity } from '../identity'
import { NOSTR } from '../nostr-constants'
import { sanitizeRelayText } from './relay-text'
import { pinnedSocketFactory, type SocketFactory } from './socket'

export type Filter = { kinds?: number[]; '#p'?: string[]; since?: number; until?: number; limit?: number }
export type SubscriptionHandlers = { onEvent(raw: unknown): void | Promise<void>; onEose(): void; onClosed(reason: string): void }
export type PublishResult = { ok: boolean; message: string }

export type BoardConnectionOptions = {
  url: string
  identity: Identity
  createSocket?: SocketFactory
  timeoutMs?: number
  // Ruling 25: how often an open connection pings the relay. Three intervals with no frame and no
  // pong end the connection. Default 30 000 ms.
  heartbeatMs?: number
  log?: (line: string) => void
}

type Subscription = { filters: Filter[]; handlers: SubscriptionHandlers; retriedAuth: boolean }
// Per socket: when a frame or pong last arrived, and whether the reader is blocked in a handler.
type Liveness = { lastActivity: number; readerBusy: boolean }

const CLOSED_REASON = 'error: connection closed'
const messageOf = (err: unknown) => sanitizeRelayText(err instanceof Error ? err.message : String(err))

// Ruling 8/9: the spec's receive pipeline checks event size first, before anything more expensive
// (such as JSON.parse). The extra 1024 bytes leave room for the ["EVENT","<subscription id>", …]
// envelope around a wrap already at the cap. An oversize EVENT frame is never parsed, but its
// subscription still gets a placeholder in the real event's place — see handleOversizeFrame.
const MAX_FRAME_BYTES = NOSTR.maxWrapBytes + 1024

// Matches the start of ["EVENT","<subscription id>", …] in the first 200 characters of an
// oversize frame, without ever parsing the (possibly huge) rest of it.
const OVERSIZE_EVENT_HEAD = /^\s*\[\s*"EVENT"\s*,\s*"([^"\\]{1,64})"\s*,/

export class BoardConnection extends EventEmitter {
  readonly url: string
  private readonly identity: Identity
  private readonly createSocket: SocketFactory
  private readonly timeoutMs: number
  private readonly heartbeatMs: number
  private readonly log: (line: string) => void
  private socket: WebSocket | null = null
  private opening: Promise<void> | null = null
  private challenge: string | null = null
  private authenticated = false
  private authInFlight: Promise<boolean> | null = null
  private readonly pendingOk = new Map<string, (result: PublishResult) => void>()
  private readonly subs = new Map<string, Subscription>()

  constructor(options: BoardConnectionOptions) {
    super()
    this.url = options.url
    this.identity = options.identity
    this.createSocket = options.createSocket ?? pinnedSocketFactory
    this.timeoutMs = options.timeoutMs ?? 10_000
    const heartbeatMs = options.heartbeatMs ?? 30_000
    // 0, a negative or fractional value, or anything above setInterval's maximum becomes a ~1 ms
    // interval: instant terminations and a reconnect storm (plan 1 final review).
    if (!Number.isInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs > 2_147_483_647) {
      throw new RangeError('heartbeatMs must be an integer from 10 to 2147483647')
    }
    this.heartbeatMs = heartbeatMs
    this.log = options.log ?? (() => {})
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  connect(): Promise<void> {
    if (this.opening) return this.opening
    // createSocket runs before the promise is created (and outside its executor): the promise
    // constructor's return value is assigned to `this.opening` only after the executor has run,
    // so setting `this.opening = null` from inside the executor's catch was immediately
    // overwritten by that assignment — pinning the rejection forever and never calling the
    // factory again. Rejecting directly here leaves `this.opening` untouched (still null), so the
    // next connect() retries.
    let socket: WebSocket
    try {
      socket = this.createSocket(this.url)
    } catch (err) {
      return Promise.reject(err)
    }
    this.opening = new Promise<void>((resolve, reject) => {
      this.socket = socket
      // The stream must exist before the first frame can arrive; it owns all reading from here on.
      const stream = createWebSocketStream(socket, { readableObjectMode: true })
      stream.on('error', (err) => this.log(`${this.url}: ${messageOf(err)}`))
      const liveness: Liveness = { lastActivity: Date.now(), readerBusy: false }
      void this.readFrames(stream, liveness)
      const timer = setTimeout(() => {
        socket.terminate()
        reject(new Error(`timed out connecting to ${this.url}`))
      }, this.timeoutMs)
      socket.on('open', () => {
        clearTimeout(timer)
        this.startHeartbeat(socket, liveness)
        resolve()
      })
      socket.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      socket.on('close', () => {
        clearTimeout(timer)
        reject(new Error(`connection to ${this.url} closed`))
        this.handleClose(socket)
      })
    })
    return this.opening
  }

  async publish(event: NostrEvent, beforeSend: () => boolean = () => true): Promise<PublishResult> {
    const first = await this.sendEvent(event, beforeSend)
    if (first.ok || !first.message.startsWith('auth-required:')) return first
    if (!(await this.authenticate())) return first
    return this.sendEvent(event, beforeSend)
  }

  subscribe(id: string, filters: Filter[], handlers: SubscriptionHandlers): void {
    this.subs.set(id, { filters, handlers, retriedAuth: false })
    if (!this.send(['REQ', id, ...filters])) {
      this.subs.delete(id)
      void this.runHandler(() => handlers.onClosed(CLOSED_REASON), 'closed')
    }
  }

  unsubscribe(id: string): void {
    if (this.subs.delete(id)) this.send(['CLOSE', id])
  }

  close(): void {
    this.socket?.close()
  }

  // Drops the socket at once, without the close handshake. Shutdown uses it: against a relay that
  // stopped reading, close() waits up to 30 s for a close frame that never comes, and every query
  // still in flight waits for its own timeout.
  terminate(): void {
    this.socket?.terminate()
  }

  // Settles everything a caller could be waiting on, without closing the socket: a cancelled sync
  // must not leave a publish waiting for an OK that will never come, and must not kill a connection
  // the next command would reuse. The AUTH round trip settles through the same map, so a handshake
  // in flight ends as "not authenticated" instead of running to its own timeout.
  abort(reason: string): void {
    const waiting = [...this.pendingOk.values()]
    this.pendingOk.clear()
    for (const settle of waiting) settle({ ok: false, message: `error: ${reason}` })
    // A cancelled query must not be left running to its own EOSE/CLOSED timeout either: every
    // pending subscription is torn down the same way unsubscribe() ends one — CLOSE sent, removed
    // from `subs`, so a lagging EVENT/EOSE/CLOSED for this id is quietly ignored by onFrame's own
    // `if (!sub) return` — and told why, so its own wait (and whatever timer it holds, such as
    // pool.ts's query timeout) settles now instead of running to its own end. The snapshot is taken
    // before any of this runs, so tearing one down can never affect the others mid-loop.
    for (const [id, sub] of [...this.subs.entries()]) {
      this.unsubscribe(id)
      void this.runHandler(() => sub.handlers.onClosed(`error: ${reason}`), 'closed')
    }
  }

  private async readFrames(stream: AsyncIterable<unknown>, liveness: Liveness): Promise<void> {
    try {
      for await (const chunk of stream) {
        liveness.readerBusy = true
        try {
          await this.onFrame(chunk)
        } finally {
          liveness.readerBusy = false
          liveness.lastActivity = Date.now()
        }
      }
    } catch (err) {
      // Handler exceptions are caught inside onFrame/runHandler, so anything reaching here is a
      // genuine stream failure. The socket's own 'close' handler still runs the actual cleanup;
      // this just makes sure the error itself is not silently swallowed.
      this.log(`${this.url}: read loop failed: ${messageOf(err)}`)
    }
  }

  // Ruling 25: a half-open socket (after sleep, a Wi-Fi change or a NAT drop) never reports an
  // error, so the connection pings and ends the socket after 3 intervals with no frame and no pong.
  // Time the reader spends blocked inside a handler does not count: ws stops reading the socket
  // while we fall behind, pongs included, and that backpressure is deliberate. An OK timeout never
  // ends the socket either, because OK frames legitimately wait behind the same backpressure.
  private startHeartbeat(socket: WebSocket, liveness: Liveness): void {
    const touch = () => {
      liveness.lastActivity = Date.now()
    }
    socket.on('message', touch)
    socket.on('pong', touch)
    let lastTick = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      // A tick that fires this late means the process itself was stalled (synchronous work, sleep),
      // so frames and pongs may be waiting unread behind this very timer: judge on the next tick.
      const stalled = now - lastTick > 2 * this.heartbeatMs
      lastTick = now
      if (liveness.readerBusy) {
        liveness.lastActivity = now
      } else if (!stalled && now - liveness.lastActivity > 3 * this.heartbeatMs) {
        clearInterval(timer)
        this.log(`${this.url}: no frames or pongs for ${3 * this.heartbeatMs} ms, closing the connection`)
        socket.terminate()
        return
      }
      socket.ping()
    }, this.heartbeatMs)
    timer.unref()
    socket.once('close', () => clearInterval(timer))
  }

  // Runs a subscription callback and never lets it escape: a throwing onEvent/onEose/onClosed
  // must not stop the reader (which would drop the socket for every other subscription too) and
  // must not become an unhandled rejection when reached from a detached `.then()` continuation.
  private async runHandler(action: () => void | Promise<void>, what: string): Promise<void> {
    try {
      await action()
    } catch (err) {
      this.log(`${this.url}: ${what} handler failed: ${messageOf(err)}`)
    }
  }

  private send(frame: unknown[]): boolean {
    if (!this.isOpen) return false
    this.socket!.send(JSON.stringify(frame))
    return true
  }

  private sendEvent(event: NostrEvent, beforeSend: () => boolean): Promise<PublishResult> {
    return new Promise((resolve) => {
      if (!this.isOpen) {
        resolve({ ok: false, message: CLOSED_REASON })
        return
      }
      // Checked at the last synchronous moment before the write, so a claim that expired while we
      // were connecting or authenticating can never be published.
      if (!beforeSend()) {
        resolve({ ok: false, message: 'error: publish guard refused' })
        return
      }
      const timer = setTimeout(() => {
        this.pendingOk.delete(event.id)
        resolve({ ok: false, message: 'error: timed out waiting for OK' })
      }, this.timeoutMs)
      this.pendingOk.set(event.id, (result) => {
        clearTimeout(timer)
        this.pendingOk.delete(event.id)
        resolve(result)
      })
      this.send(['EVENT', event])
    })
  }

  private authenticate(): Promise<boolean> {
    if (this.authenticated) return Promise.resolve(true)
    const challenge = this.challenge
    if (!challenge) return Promise.resolve(false)
    this.authInFlight ??= new Promise<boolean>((resolve) => {
      const auth = finalizeEvent(makeAuthEvent(this.url, challenge), this.identity.secretKey)
      const timer = setTimeout(() => {
        this.pendingOk.delete(auth.id)
        resolve(false)
      }, this.timeoutMs)
      this.pendingOk.set(auth.id, (result) => {
        clearTimeout(timer)
        this.pendingOk.delete(auth.id)
        this.authenticated = result.ok
        resolve(result.ok)
      })
      if (!this.send(['AUTH', auth])) {
        clearTimeout(timer)
        this.pendingOk.delete(auth.id)
        resolve(false)
      }
    }).finally(() => {
      this.authInFlight = null
    })
    return this.authInFlight
  }

  private async onFrame(chunk: unknown): Promise<void> {
    // Ruling 8/9: measure size before converting to text, and before doing anything more
    // expensive such as JSON.parse. An oversize Buffer is never turned into a full string.
    const isBuffer = Buffer.isBuffer(chunk)
    const bytes = isBuffer ? (chunk as Buffer).length : Buffer.byteLength(typeof chunk === 'string' ? chunk : String(chunk), 'utf8')
    if (bytes > MAX_FRAME_BYTES) {
      await this.handleOversizeFrame(chunk, isBuffer, bytes)
      return
    }
    const text = typeof chunk === 'string' ? chunk : isBuffer ? (chunk as Buffer).toString('utf8') : String(chunk)
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (!Array.isArray(frame) || typeof frame[0] !== 'string') return
    switch (frame[0]) {
      case 'EVENT': {
        const sub = this.subs.get(String(frame[1]))
        if (!sub) return
        await this.runHandler(() => sub.handlers.onEvent(frame[2]), 'event')
        return
      }
      case 'EOSE': {
        const sub = this.subs.get(String(frame[1]))
        if (!sub) return
        await this.runHandler(() => sub.handlers.onEose(), 'eose')
        return
      }
      case 'CLOSED': {
        const id = String(frame[1])
        const reason = String(frame[2] ?? '')
        const sub = this.subs.get(id)
        if (!sub) return
        if (reason.startsWith('auth-required:') && !sub.retriedAuth) {
          sub.retriedAuth = true
          this.authenticate()
            .then(async (ok) => {
              // Ruling 10b: `id` may have been reused by unsubscribe()+subscribe() while this
              // retry was in flight. Only the subscription that started the retry may be acted
              // on — never whatever now sits at the same id.
              if (this.subs.get(id) !== sub) return
              if (ok && this.send(['REQ', id, ...sub.filters])) return
              this.subs.delete(id)
              await this.runHandler(() => sub.handlers.onClosed(reason), 'closed')
            })
            .catch((err) => this.log(`${this.url}: auth retry failed: ${messageOf(err)}`))
          return
        }
        this.subs.delete(id)
        await this.runHandler(() => sub.handlers.onClosed(reason), 'closed')
        return
      }
      case 'OK': {
        this.pendingOk.get(String(frame[1]))?.({ ok: frame[2] === true, message: String(frame[3] ?? '') })
        return
      }
      case 'AUTH': {
        if (typeof frame[1] === 'string') this.challenge = frame[1]
        return
      }
      case 'NOTICE': {
        this.log(`${this.url} notice: ${sanitizeRelayText(String(frame[1]))}`)
        return
      }
    }
  }

  // Ruling 9: an oversize EVENT frame is never JSON.parse'd, but dropping it silently would make
  // a relay's page look shorter than what it actually returned — the history pager (Task 15)
  // would then believe the page was not truncated and skip same-second events that follow it, a
  // gap an attacker could otherwise exploit to hide a genuine wrap. Instead, when the frame's head
  // identifies a live subscription, that subscription receives `null` in the real event's place,
  // so callers can still count it.
  private async handleOversizeFrame(chunk: unknown, isBuffer: boolean, bytes: number): Promise<void> {
    const head = isBuffer ? (chunk as Buffer).subarray(0, 200).toString('utf8') : String(chunk).slice(0, 200)
    const id = OVERSIZE_EVENT_HEAD.exec(head)?.[1]
    const sub = id !== undefined ? this.subs.get(id) : undefined
    if (id !== undefined && sub) {
      this.log(`${this.url}: oversize event (${bytes} bytes) on subscription ${sanitizeRelayText(id)}`)
      await this.runHandler(() => sub.handlers.onEvent(null), 'event')
      return
    }
    this.log(`${this.url}: oversize frame (${bytes} bytes) dropped`)
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) return
    this.socket = null
    this.opening = null
    this.challenge = null
    this.authenticated = false
    for (const resolve of [...this.pendingOk.values()]) resolve({ ok: false, message: CLOSED_REASON })
    this.pendingOk.clear()
    const subs = [...this.subs.values()]
    this.subs.clear()
    for (const sub of subs) void this.runHandler(() => sub.handlers.onClosed(CLOSED_REASON), 'closed')
    this.emit('close')
  }
}
