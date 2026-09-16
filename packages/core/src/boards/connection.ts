import { EventEmitter } from 'node:events'
import { makeAuthEvent } from 'nostr-tools/nip42'
import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure'
import WebSocket, { createWebSocketStream } from 'ws'
import type { Identity } from '../identity'
import { NOSTR } from '../nostr-constants'
import { pinnedSocketFactory, type SocketFactory } from './socket'

export type Filter = { kinds?: number[]; '#p'?: string[]; since?: number; until?: number; limit?: number }
export type SubscriptionHandlers = { onEvent(raw: unknown): void | Promise<void>; onEose(): void; onClosed(reason: string): void }
export type PublishResult = { ok: boolean; message: string }

export type BoardConnectionOptions = {
  url: string
  identity: Identity
  createSocket?: SocketFactory
  timeoutMs?: number
  log?: (line: string) => void
}

type Subscription = { filters: Filter[]; handlers: SubscriptionHandlers; retriedAuth: boolean }

const CLOSED_REASON = 'error: connection closed'

// Ruling 8: the spec's receive pipeline checks event size first, before anything more expensive
// (such as JSON.parse). The extra 1024 bytes leave room for the ["EVENT","<subscription id>", …]
// envelope around a wrap already at the cap.
const MAX_FRAME_BYTES = NOSTR.maxWrapBytes + 1024

export class BoardConnection extends EventEmitter {
  readonly url: string
  private readonly identity: Identity
  private readonly createSocket: SocketFactory
  private readonly timeoutMs: number
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
    this.log = options.log ?? (() => {})
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  connect(): Promise<void> {
    if (this.opening) return this.opening
    this.opening = new Promise<void>((resolve, reject) => {
      let socket: WebSocket
      try {
        socket = this.createSocket(this.url)
      } catch (err) {
        this.opening = null
        reject(err)
        return
      }
      this.socket = socket
      // The stream must exist before the first frame can arrive; it owns all reading from here on.
      const stream = createWebSocketStream(socket, { readableObjectMode: true })
      stream.on('error', (err) => this.log(`${this.url}: ${err.message}`))
      void this.readFrames(stream)
      const timer = setTimeout(() => {
        socket.terminate()
        reject(new Error(`timed out connecting to ${this.url}`))
      }, this.timeoutMs)
      socket.on('open', () => {
        clearTimeout(timer)
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
      handlers.onClosed(CLOSED_REASON)
    }
  }

  unsubscribe(id: string): void {
    if (this.subs.delete(id)) this.send(['CLOSE', id])
  }

  close(): void {
    this.socket?.close()
  }

  private async readFrames(stream: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const chunk of stream) await this.onFrame(chunk)
    } catch {
      // Socket errors surface through the 'close' handler.
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
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    // Ruling 8: check the frame's size before doing anything more expensive, such as JSON.parse.
    // A wrap that passed the publish-side cap can never legitimately produce a larger frame here,
    // so an oversize frame is dropped rather than parsed; the connection stays open.
    if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) return
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
        try {
          await sub.handlers.onEvent(frame[2])
        } catch (err) {
          this.log(`${this.url}: event handler failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      case 'EOSE': {
        this.subs.get(String(frame[1]))?.handlers.onEose()
        return
      }
      case 'CLOSED': {
        const id = String(frame[1])
        const reason = String(frame[2] ?? '')
        const sub = this.subs.get(id)
        if (!sub) return
        if (reason.startsWith('auth-required:') && !sub.retriedAuth) {
          sub.retriedAuth = true
          void this.authenticate().then((ok) => {
            if (!this.subs.has(id)) return
            if (ok && this.send(['REQ', id, ...sub.filters])) return
            this.subs.delete(id)
            sub.handlers.onClosed(reason)
          })
          return
        }
        this.subs.delete(id)
        sub.handlers.onClosed(reason)
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
        this.log(`${this.url} notice: ${String(frame[1]).slice(0, 200)}`)
        return
      }
    }
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
    for (const sub of subs) sub.handlers.onClosed(CLOSED_REASON)
    this.emit('close')
  }
}
