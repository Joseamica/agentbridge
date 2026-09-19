import { recoverHistory } from '../boards/history'
import { BoardPool, type PoolOptions } from '../boards/pool'
import { sanitizeRelayText } from '../boards/relay-text'
import type { SocketFactory } from '../boards/socket'
import { SeenIds } from '../envelope/dedupe'
import { openWrap, precheckWrap, type OpenedMessage, type PrecheckedWrap } from '../envelope/open'
import { describeError } from '../errors'
import type { Identity } from '../identity'
import { nowSeconds } from '../nostr-constants'
import { purgeRequests } from '../store/contacts'
import { purgeCursors, type CursorRole } from '../store/cursors'
import type { Store } from '../store/db'
import { purgeInbox } from '../store/inbox'
import { purgeOutbox, type OutboxItem } from '../store/outbox'
import { expireOutboundQuestions, markSentQuestions, purgeOutboundQuestions } from '../store/outbox-questions'
import { getProfile } from '../store/settings'
import { publishDue, type PublishReport } from './publisher'

export type InboundHandler<T> = (store: Store, input: { identity: Identity; opened: OpenedMessage; now: number }) => T

export type DeviceOptions<T> = {
  store: Store
  identity: Identity
  role: CursorRole
  handleMessage: InboundHandler<T>
  onMessage?: (opened: OpenedMessage, outcome: T) => void
  onPublished?: (item: OutboxItem) => void
  createSocket?: SocketFactory
  now?: () => number
  log?: (line: string) => void
  pool?: Partial<Pick<PoolOptions, 'timeoutMs' | 'heartbeatMs' | 'reconnectDelaysMs'>>
  historyIntervalMs?: number
  publishIntervalMs?: number
  purgeIntervalMs?: number
  // Proof of work is CPU, not network: forwarded to every publishDue call, separate from the sync's
  // own network deadline.
  miningMs?: number
}

export type HistoryRun = { relay: string; completed: number; incomplete: number; events: number; failed: boolean }
export type SyncReport = { history: HistoryRun[]; published: PublishReport; timedOut: boolean }

type InFlight = { promise: Promise<void>; resolve(): void; reject(err: unknown): void }

// Thrown when a received message could not be stored. Its message never includes the original error's
// text (which may carry decrypted content): the live queue logs this message as it is.
export class MessageProcessingError extends Error {
  constructor(cause: unknown) {
    super(`could not store a received message (${describeError(cause)})`)
    this.name = 'MessageProcessingError'
  }
}

function inFlight(): InFlight {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Waiting is optional: a failure nobody waits for must not become an unhandled rejection.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

// Everything one process needs to take part for one role: receive live, recover history, publish the
// outbox and purge old data. It owns no files: callers open the identity and the store (so a channel
// can take its lock before any network activity) and close the store after close().
export class Device<T> {
  readonly pool: BoardPool
  private readonly seen = new SeenIds()
  private readonly flying = new Map<string, InFlight>()
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly shutdown = new AbortController()
  private live: { close(): Promise<void> } | null = null
  private publishing: Promise<void> | null = null
  private publishAgain = false
  private historyRunning: Promise<HistoryRun[]> | null = null
  private syncing: Promise<SyncReport> | null = null
  private started = false
  private closed = false

  constructor(private readonly options: DeviceOptions<T>) {
    this.now = options.now ?? nowSeconds
    this.log = options.log ?? (() => {})
    this.pool = new BoardPool({ identity: options.identity, createSocket: options.createSocket, now: this.now, log: this.log, ...options.pool })
  }

  // A throwing sink (a stderr write on a closed pipe) must never itself become the failure: every
  // catch block in this class that logs goes through here instead of calling `this.log` directly.
  private safeLog(line: string): void {
    try {
      this.log(line)
    } catch {
      // Nowhere left to report a broken logger.
    }
  }

  start(): void {
    if (this.closed || this.live) return
    this.started = true
    const relays = getProfile(this.options.store).relays
    this.live = this.pool.subscribeLive<PrecheckedWrap>(relays, {
      precheck: (raw) => this.precheck(raw),
      process: (item) => this.process(item),
    })
    this.purge()
    void this.runHistory()
    this.wakePublisher()
    this.every(this.options.historyIntervalMs ?? 15 * 60_000, () => void this.runHistory())
    this.every(this.options.publishIntervalMs ?? 5_000, () => this.wakePublisher())
    this.every(this.options.purgeIntervalMs ?? 60 * 60_000, () => this.purge())
  }

  // Background publishing belongs to a started (persistent) device only. A short-lived client publishes
  // inside syncOnce, under its deadline, so nothing keeps writing after the sync returned.
  wakePublisher(): void {
    if (this.closed || !this.started) return
    if (this.publishing) {
      this.publishAgain = true
      return
    }
    this.publishing = (async () => {
      do {
        this.publishAgain = false
        try {
          await publishDue({
            store: this.options.store,
            identity: this.options.identity,
            pool: this.pool,
            now: this.now,
            signal: this.shutdown.signal,
            miningMs: this.options.miningMs,
            log: this.log,
            onPublished: this.options.onPublished,
          })
        } catch (err) {
          // A throw here (including from the log call itself) must never escape: nothing awaits this
          // async IIFE's promise until close(), so it would otherwise become an unhandled rejection.
          this.safeLog(`publishing failed (${describeError(err)})`)
        }
      } while (this.publishAgain && !this.closed)
    })().finally(() => {
      this.publishing = null
    })
  }

  syncOnce(options: { maxMs?: number } = {}): Promise<SyncReport> {
    // Mirrors the closed guard on start()/wakePublisher(): the caller closes the store right after
    // close() returns, so a sync that started after that must not touch the store or the pool.
    if (this.closed) return Promise.resolve({ history: [], published: { published: 0, failed: 0, postponed: 0, lost: 0 }, timedOut: false })
    const run = this.runSync(options.maxMs ?? 10_000)
    this.syncing = run
    return run.finally(() => {
      if (this.syncing === run) this.syncing = null
    })
  }

  private async runSync(maxMs: number): Promise<SyncReport> {
    const deadline = new AbortController()
    const onShutdown = () => deadline.abort()
    this.shutdown.signal.addEventListener('abort', onShutdown, { once: true })
    const timer = setTimeout(() => deadline.abort(), maxMs)
    try {
      this.purge()
      const queryTimeoutMs = Math.max(250, Math.min(3_000, Math.floor(maxMs / 3)))
      const history = await this.recoverAll(deadline.signal, queryTimeoutMs)
      const published = await publishDue({
        store: this.options.store,
        identity: this.options.identity,
        pool: this.pool,
        now: this.now,
        signal: deadline.signal,
        miningMs: this.options.miningMs,
        log: this.log,
        onPublished: this.options.onPublished,
      })
      return { history, published, timedOut: deadline.signal.aborted }
    } finally {
      clearTimeout(timer)
      this.shutdown.signal.removeEventListener('abort', onShutdown)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers.clear()
    this.shutdown.abort()
    // Closing the pool stops the live loops, terminates every connection and drains the live queue,
    // so every wrap already received is still processed before this returns.
    await this.pool.close()
    await this.live?.close()
    await this.publishing
    await this.historyRunning?.catch(() => [])
    await this.syncing?.catch(() => undefined)
  }

  private every(ms: number, run: () => void): void {
    const timer = setInterval(run, ms)
    timer.unref()
    this.timers.add(timer)
  }

  private precheck(raw: unknown): PrecheckedWrap | null {
    const result = precheckWrap(raw, { identity: this.options.identity, now: this.now(), seen: this.seen })
    if (!result.ok) return null
    this.flying.set(result.wrap.id, inFlight())
    return result
  }

  private async process(item: PrecheckedWrap): Promise<void> {
    const id = item.wrap.id
    const pending = this.flying.get(id)
    try {
      const opened = openWrap(item, { identity: this.options.identity, now: this.now(), seen: this.seen })
      if (!opened.ok) {
        this.log(`discarded a wrap at the ${opened.stage} stage: ${opened.detail}`)
      } else {
        const outcome = this.options.handleMessage(this.options.store, { identity: this.options.identity, opened, now: this.now() })
        try {
          this.options.onMessage?.(opened, outcome)
        } catch (err) {
          this.log(`message callback failed (${describeError(err)})`)
        }
        this.wakePublisher()
      }
      pending?.resolve()
    } catch (err) {
      // Nothing was persisted: forget the wrap so another copy, or the next history pass, retries it.
      this.seen.delete(id)
      const failure = new MessageProcessingError(err)
      pending?.reject(failure)
      throw failure
    } finally {
      this.flying.delete(id)
    }
  }

  private async handleHistoryEvent(raw: unknown): Promise<void> {
    const item = this.precheck(raw)
    if (item) return this.process(item)
    // A duplicate may still be waiting in the live queue or being processed. History must not count
    // it as handled (and possibly mark its window complete) until that processing has succeeded.
    const id = (raw as { id?: unknown } | null)?.id
    if (typeof id === 'string') await this.flying.get(id)?.promise
  }

  private runHistory(): Promise<HistoryRun[]> {
    if (this.historyRunning) return this.historyRunning
    this.historyRunning = this.recoverAll(this.shutdown.signal).finally(() => {
      this.historyRunning = null
    })
    return this.historyRunning
  }

  private async recoverAll(signal: AbortSignal, queryTimeoutMs?: number): Promise<HistoryRun[]> {
    let relays: string[]
    try {
      relays = getProfile(this.options.store).relays
    } catch (err) {
      // Reading the profile is the first synchronous step of a history pass. Marking this method
      // async turns that throw into a rejection instead of one that could escape a setInterval
      // callback synchronously (an uncaughtException that would kill the process); catching it here
      // keeps the promise resolved so callers never see a rejection either. `runHistory()` is called
      // through `void` both at start() and on the history interval, so a throw from the log call
      // itself must not leave this rejected either, or it becomes an unhandled rejection.
      this.safeLog(`history failed (${describeError(err)})`)
      return []
    }
    return Promise.all(
      relays.map(async (relay): Promise<HistoryRun> => {
        try {
          const result = await recoverHistory({
            pool: this.pool,
            store: this.options.store,
            relay,
            role: this.options.role,
            recipientPubkey: this.options.identity.publicKey,
            now: this.now(),
            handle: (raw) => this.handleHistoryEvent(raw),
            queryTimeoutMs,
            signal,
          })
          return { relay, completed: result.completed, incomplete: result.incomplete, events: result.events, failed: false }
        } catch (err) {
          this.safeLog(`${sanitizeRelayText(relay)}: history failed (${describeError(err)})`)
          return { relay, completed: 0, incomplete: 0, events: 0, failed: true }
        }
      }),
    )
  }

  private purge(): void {
    const now = this.now()
    const steps: Array<[string, () => unknown]> = [
      ['requests', () => purgeRequests(this.options.store, now)],
      ['inbox', () => purgeInbox(this.options.store, { identity: this.options.identity, now })],
      ['outbox', () => purgeOutbox(this.options.store, now)],
      // The sweep half of P1: a crash between a publish and its promotion, or a publish by a process
      // that did not wire onPublished, is caught here.
      ['promote sent questions', () => markSentQuestions(this.options.store, now)],
      ['sent questions', () => expireOutboundQuestions(this.options.store, now)],
      ['sent question content', () => purgeOutboundQuestions(this.options.store, now)],
      ['cursors', () => purgeCursors(this.options.store, now)],
    ]
    for (const [name, run] of steps) {
      try {
        run()
      } catch (err) {
        // purge() runs synchronously inside a setInterval callback: a throw here (including from the
        // log call itself) would otherwise be an uncaughtException, and would also stop this loop
        // before the remaining steps ran.
        this.safeLog(`purge of ${name} failed (${describeError(err)})`)
      }
    }
  }
}
