import { randomBytes } from 'node:crypto'
import type { NostrEvent } from 'nostr-tools/pure'
import type { Identity } from '../identity'
import { NOSTR, nowSeconds } from '../nostr-constants'
import { BoardConnection, type Filter, type PublishResult } from './connection'
import { ReceiveQueue } from './receive-queue'
import { sanitizeRelayText } from './relay-text'
import type { SocketFactory } from './socket'

export type PoolOptions = {
  identity: Identity
  createSocket?: SocketFactory
  timeoutMs?: number
  // Passed to every connection: see BoardConnectionOptions.heartbeatMs.
  heartbeatMs?: number
  reconnectDelaysMs?: readonly number[]
  now?: () => number
  log?: (line: string) => void
  onPressure?: (relay: string, waiting: boolean) => void
}

export type PublishOutcome = { accepted: string[]; rejected: Array<{ relay: string; reason: string }> }
export type QueryResult = { events: unknown[]; complete: boolean; closedReason: string | null }
export type LiveHandlers<T> = { precheck(raw: unknown, relay: string): T | null; process(item: T, relay: string): Promise<void> }

const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]
// Ruling 14: a subscription only counts as healthy — and earns a backoff reset — once it has
// stayed open this long after its EOSE. Without a minimum, a relay that sends EOSE and closes
// immediately would force a full re-subscription (re-downloading up to two days of events) on
// every cycle, at the fastest configured delay, forever.
const STABLE_SUBSCRIPTION_MS = 60_000
const QUERY_EXTRA_EVENTS = 64
const newSubscriptionId = () => randomBytes(8).toString('hex')
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

type LiveSubscription = { stop(): void; close(): Promise<void> }

export class BoardPool {
  private readonly connections = new Map<string, BoardConnection>()
  private readonly live = new Set<LiveSubscription>()
  // Ruling 26: once closed, the pool never connects again. publish rejects every relay and query
  // returns incomplete, both with 'error: pool closed', and subscribeLive starts nothing.
  private closed = false

  constructor(private readonly options: PoolOptions) {}

  private async connection(relay: string): Promise<BoardConnection> {
    if (this.closed) throw new Error('pool closed')
    let conn = this.connections.get(relay)
    if (!conn) {
      const created = new BoardConnection({
        url: relay,
        identity: this.options.identity,
        createSocket: this.options.createSocket,
        timeoutMs: this.options.timeoutMs,
        heartbeatMs: this.options.heartbeatMs,
        log: this.options.log,
      })
      created.on('close', () => {
        if (this.connections.get(relay) === created) this.connections.delete(relay)
      })
      this.connections.set(relay, created)
      conn = created
    }
    try {
      await conn.connect()
    } catch (err) {
      if (this.connections.get(relay) === conn) this.connections.delete(relay)
      throw err
    }
    return conn
  }

  // Exposed so a caller can make "the socket opened" its own explicit outcome, distinct from
  // whatever happens afterwards on the wire. `doctor`'s board probe needs exactly this: NIP-01
  // lets a relay answer `OK false` with any reason text it likes, including the same `error:`
  // catch-all prefix this pool's own synthesized failures already use (see `publish`'s catch
  // below and `BoardConnection`'s `CLOSED_REASON`/timeout/guard messages) — so classifying a
  // rejection by its text can misread a spec-compliant refusal as "never connected", which is
  // exactly what let a real relay outage read as an active refusal. Whether the socket itself
  // opened is the one thing only this pool controls, never the relay, so it is what stays safe to
  // branch on. Reuses (and caches) the same connection `publish`/`query` would open next — this
  // is not a second, throwaway handshake.
  async connect(relay: string): Promise<void> {
    await this.connection(relay)
  }

  // A helper used by both operations below: the caller's wait ends when the signal aborts, even
  // though the underlying socket work is also stopped through `abort()` on the connection.
  private async raceSignal<T>(work: Promise<T>, onAbort: () => T, signal?: AbortSignal): Promise<T> {
    if (!signal) return work
    if (signal.aborted) return onAbort()
    return new Promise<T>((resolve) => {
      const finish = (value: T) => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      }
      const aborted = () => finish(onAbort())
      signal.addEventListener('abort', aborted, { once: true })
      void work.then(finish, () => finish(onAbort()))
    })
  }

  async publish(
    relays: readonly string[],
    event: NostrEvent,
    beforeSend: () => boolean = () => true,
    options: { signal?: AbortSignal } = {},
  ): Promise<PublishOutcome> {
    const signal = options.signal
    const targets = [...new Set(relays)].slice(0, NOSTR.maxRelaysPerContact)
    // An already-aborted signal never opens a connection: every target is refused up front.
    if (signal?.aborted) {
      return { accepted: [], rejected: targets.map((relay) => ({ relay, reason: 'error: sync deadline reached' })) }
    }
    const outcome: PublishOutcome = { accepted: [], rejected: [] }
    await Promise.all(
      targets.map(async (relay) => {
        let conn: BoardConnection | undefined
        const attempt = (async (): Promise<PublishResult> => {
          try {
            conn = await this.connection(relay)
            return await conn.publish(event, beforeSend)
          } catch (err) {
            return { ok: false, message: `error: ${messageOf(err)}` }
          }
        })()
        // On abort, settle whatever this relay's connection is still waiting on (a pending OK, or an
        // AUTH round trip) instead of leaving it to its own timeout. A relay that already accepted
        // still counts: `attempt` has already resolved by the time raceSignal would race it.
        const result = await this.raceSignal(
          attempt,
          () => {
            conn?.abort('sync deadline reached')
            return { ok: false, message: 'error: sync deadline reached' }
          },
          signal,
        )
        if (result.ok) outcome.accepted.push(relay)
        else outcome.rejected.push({ relay, reason: result.message })
      }),
    )
    return outcome
  }

  async query(
    relay: string,
    filter: Filter,
    timeoutMs = this.options.timeoutMs ?? 10_000,
    options: { signal?: AbortSignal } = {},
  ): Promise<QueryResult> {
    // The third argument stays the number every current caller passes positionally (history.ts and
    // plan 1's tests); the signal is a fourth, optional one.
    const signal = options.signal
    if (signal?.aborted) return { events: [], complete: false, closedReason: 'error: sync deadline reached' }
    let conn: BoardConnection | undefined
    const attempt = (async (): Promise<QueryResult> => {
      try {
        conn = await this.connection(relay)
        return await this.runQuery(conn, filter, timeoutMs)
      } catch (err) {
        return { events: [], complete: false, closedReason: `error: ${messageOf(err)}` }
      }
    })()
    return this.raceSignal(
      attempt,
      () => {
        conn?.abort('sync deadline reached')
        return { events: [], complete: false, closedReason: 'error: sync deadline reached' }
      },
      signal,
    )
  }

  private runQuery(conn: BoardConnection, filter: Filter, timeoutMs: number): Promise<QueryResult> {
    const id = newSubscriptionId()
    const events: unknown[] = []
    // Ruling 27: bound what one query holds in memory. A relay may add a few events before EOSE (a
    // live one racing the query), but one that keeps sending past the limit is misbehaving. Oversize
    // placeholders (null) count too.
    const cap = (filter.limit ?? Math.max(...NOSTR.historyPageLimits)) + QUERY_EXTRA_EVENTS
    return new Promise<QueryResult>((resolve) => {
      let finished = false
      const finish = (result: QueryResult) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        conn.unsubscribe(id)
        resolve(result)
      }
      const timer = setTimeout(() => finish({ events, complete: false, closedReason: 'error: timed out waiting for EOSE' }), timeoutMs)
      conn.subscribe(id, [filter], {
        onEvent: (raw) => {
          if (finished) return
          if (events.length >= cap) {
            finish({ events, complete: false, closedReason: 'error: relay sent more events than requested' })
            return
          }
          events.push(raw)
        },
        onEose: () => finish({ events, complete: true, closedReason: null }),
        onClosed: (reason) => finish({ events, complete: false, closedReason: reason }),
      })
    })
  }

  subscribeLive<T>(relays: readonly string[], handlers: LiveHandlers<T>): { close(): Promise<void> } {
    if (this.closed) return { close: async () => {} }
    // Ruling 14: an empty array is a caller mistake, not "reconnect with no delay" — fall back to
    // the default schedule rather than hammering the relay.
    const delays = this.options.reconnectDelaysMs?.length ? this.options.reconnectDelaysMs : DEFAULT_RECONNECT_DELAYS_MS
    const now = this.options.now ?? nowSeconds
    const wakers = new Set<() => void>()
    // Ruling 13: per-cycle stoppers, each removed once its cycle ends, instead of every cycle
    // attaching a fresh `.then()` reaction to one long-lived `stop` promise that never settles
    // until close() — which retained roughly 460 B per reconnect cycle for as long as the
    // subscription kept reconnecting.
    const stoppers = new Set<() => void>()
    let stopped = false

    const queue = new ReceiveQueue<T>({
      max: NOSTR.receiveQueueMax,
      process: (item, relay) => handlers.process(item, relay),
      onPressure: (relay, waiting) => this.options.onPressure?.(relay, waiting),
      onError: (err, relay) => this.options.log?.(`${relay}: processing failed: ${sanitizeRelayText(messageOf(err))}`),
    })

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer)
          wakers.delete(wake)
          resolve()
        }
        const timer = setTimeout(wake, ms)
        wakers.add(wake)
      })

    const run = async (relay: string) => {
      let attempt = 0
      while (!stopped) {
        // Ruling 14: set once EOSE arrives (in wall-clock time, not the pool's injectable `now`,
        // which is in seconds and meant for filters); reset to null at the top of every cycle.
        let stableSince: number | null = null
        try {
          const conn = await this.connection(relay)
          if (stopped) break
          const id = newSubscriptionId()
          let stopper!: () => void
          const reason = await new Promise<string>((resolve) => {
            stopper = () => resolve('stopped')
            stoppers.add(stopper)
            conn.subscribe(id, [{ kinds: [NOSTR.wrapKind], '#p': [this.options.identity.publicKey], since: now() - NOSTR.liveSinceSeconds }], {
              onEvent: async (raw) => {
                if (stopped) return
                const item = handlers.precheck(raw, relay)
                if (item !== null) await queue.push(relay, item)
              },
              onEose: () => {
                stableSince = Date.now()
              },
              onClosed: (closedReason) => resolve(closedReason),
            })
          }).finally(() => stoppers.delete(stopper))
          conn.unsubscribe(id)
          if (stopped) break
          this.options.log?.(`${relay}: live subscription closed (${sanitizeRelayText(reason)})`)
          // Ruling 14: only a subscription that proved itself stable — EOSE, then staying open for
          // STABLE_SUBSCRIPTION_MS — earns a backoff reset. Otherwise keep escalating.
          if (stableSince !== null && Date.now() - stableSince >= STABLE_SUBSCRIPTION_MS) attempt = 0
        } catch (err) {
          if (stopped) break
          this.options.log?.(`${relay}: ${sanitizeRelayText(messageOf(err))}`)
        }
        await sleep(delays[Math.min(attempt, delays.length - 1)]!)
        attempt++
      }
    }

    const loops = [...new Set(relays)].slice(0, NOSTR.maxRelaysPerContact).map((relay) => run(relay))
    const subscription: LiveSubscription = {
      stop: () => {
        if (stopped) return
        stopped = true
        for (const stop of [...stoppers]) stop()
        for (const wake of [...wakers]) wake()
      },
      close: async () => {
        subscription.stop()
        await Promise.all(loops)
        await queue.idle()
        this.live.delete(subscription)
      },
    }
    this.live.add(subscription)
    return { close: subscription.close }
  }

  // Ruling 26: stop every live loop first, then terminate every connection (no close handshake) —
  // which also aborts connects still in progress, so a relay that never finishes its handshake
  // cannot hold close() up — and only then wait for the loops to exit and their queues to drain.
  async close(): Promise<void> {
    this.closed = true
    const live = [...this.live]
    for (const subscription of live) subscription.stop()
    for (const conn of this.connections.values()) conn.terminate()
    this.connections.clear()
    await Promise.all(live.map((subscription) => subscription.close()))
  }
}
