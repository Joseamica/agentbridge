import { EventEmitter } from 'node:events'
import { ServerMessageSchema, type ClientMessage, type Confidence, type ServerMessage } from '@agentbridge/core'

export type QuestionMessage = Extract<ServerMessage, { type: 'question' }>
export type CancelMessage = Extract<ServerMessage, { type: 'cancel' }>
export type AnswerPayload = { attemptId: string; code: string; text: string; source: string; confidence: Confidence }

export interface RelayConnection {
  onQuestion(fn: (m: QuestionMessage) => void): void
  onCancel(fn: (m: CancelMessage) => void): void
  onDisconnect(fn: () => void): void
  sendAnswer(answer: AnswerPayload): Promise<'accepted' | 'rejected'>
}

export type WsLike = {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void
}

type Options = {
  relayUrl: string
  token: string
  createSocket?: (url: string) => WsLike
  backoffMs?: (attempt: number) => number
  pingIntervalMs?: number
  answerTimeoutMs?: number
  log?: (message: string) => void
}

const OPEN = 1
const defaultBackoff = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250)
const stderrLog = (message: string) => process.stderr.write(`[agentbridge] ${message}\n`)

export class RelayWsClient implements RelayConnection {
  private ws: WsLike | null = null
  private readonly events = new EventEmitter()
  private stopped = true
  private failures = 0
  private pingTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private readonly log: (message: string) => void
  // Bumped once per connect() call; each close handler closes over the value current at its
  // own connect(), so comparing it against the live counter tells a stale generation's close
  // apart from the current one without relying on `this.ws`, which stop() can null out from
  // under the very socket whose close is still in flight. See the close handler below.
  private generation = 0

  constructor(private readonly opts: Options) {
    this.log = opts.log ?? stderrLog
    this.events.setMaxListeners(0)
  }

  static responderUrl(relayUrl: string): string {
    return `${relayUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/v1/responder`
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearPing()
    this.clearReconnectTimer()
    this.ws?.close(1000, 'stopped')
    this.ws = null
  }

  onConnected(fn: (handle: string) => void): void {
    this.events.on('connected', fn)
  }
  onQuestion(fn: (m: QuestionMessage) => void): void {
    this.events.on('question', fn)
  }
  onCancel(fn: (m: CancelMessage) => void): void {
    this.events.on('cancel', fn)
  }
  onDisconnect(fn: () => void): void {
    this.events.on('disconnect', fn)
  }

  sendAnswer(answer: AnswerPayload): Promise<'accepted' | 'rejected'> {
    if (!this.ws || this.ws.readyState !== OPEN) return Promise.resolve('rejected')
    return new Promise((resolve) => {
      const onResult = (m: ServerMessage) => {
        if ((m.type === 'answer_accepted' || m.type === 'answer_rejected') && m.attemptId === answer.attemptId) {
          finish(m.type === 'answer_accepted' ? 'accepted' : 'rejected')
        }
      }
      const onDrop = () => finish('rejected')
      const timer = setTimeout(() => finish('rejected'), this.opts.answerTimeoutMs ?? 10_000)
      const finish = (result: 'accepted' | 'rejected') => {
        clearTimeout(timer)
        this.events.off('result', onResult)
        this.events.off('disconnect', onDrop)
        resolve(result)
      }
      this.events.on('result', onResult)
      this.events.on('disconnect', onDrop)
      this.send({ type: 'answer', ...answer })
    })
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(message))
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private connect(): void {
    const gen = ++this.generation
    const url = RelayWsClient.responderUrl(this.opts.relayUrl)
    const ws = this.opts.createSocket ? this.opts.createSocket(url) : (new WebSocket(url) as unknown as WsLike)
    this.ws = ws

    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token: this.opts.token } satisfies ClientMessage)))

    ws.addEventListener('message', (event) => {
      let message: ServerMessage
      try {
        message = ServerMessageSchema.parse(JSON.parse(String(event.data)))
      } catch {
        this.log('ignored a malformed message from the relay')
        return
      }
      if (message.type === 'auth_ok') {
        this.failures = 0
        this.clearPing()
        this.pingTimer = setInterval(() => this.send({ type: 'ping' }), this.opts.pingIntervalMs ?? 25_000)
        this.events.emit('connected', message.handle)
      } else if (message.type === 'question') {
        this.events.emit('question', message)
      } else if (message.type === 'cancel') {
        this.events.emit('cancel', message)
      } else {
        this.events.emit('result', message)
      }
    })

    ws.addEventListener('close', (event) => {
      // A stale generation's close (e.g. an orphan left behind by a stop()/start() or
      // reconnect-backoff race) must not touch state a newer generation now owns — in
      // particular it must never flip `stopped` back on and suppress a reconnect that
      // generation is legitimately waiting on. Comparing `this.ws` to `ws` cannot tell that
      // apart from an ordinary graceful stop(): stop() closes this exact socket and only
      // *then* nulls `this.ws` (see stop() above), but a real WebSocket's close event fires
      // asynchronously, so by the time it arrives `this.ws` is already null even though no
      // newer generation exists — indistinguishable, by identity alone, from a truly stale
      // socket whose generation has since moved on. `gen`, captured once per connect() call,
      // does not have that ambiguity: it only changes when a new generation is actually
      // started. Every test here using ScriptedSocket's synchronous close() used to mask the
      // stop() case, since that close ran before stop() got to null this.ws.
      if (gen !== this.generation) return
      this.ws = null
      this.clearPing()
      this.events.emit('disconnect')
      if (this.stopped) return
      if (event.code === 4401) {
        this.log('relay rejected the device token (4401); run: agentbridge doctor')
        this.stopped = true
        return
      }
      if (event.code === 4000) {
        this.log('another responder session for this account took over (4000); this one stops')
        this.stopped = true
        return
      }
      const delay = (this.opts.backoffMs ?? defaultBackoff)(this.failures++)
      this.clearReconnectTimer()
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (!this.stopped) this.connect()
      }, delay)
    })

    ws.addEventListener('error', () => {
      // A close event always follows; reconnection is handled there.
    })
  }
}
