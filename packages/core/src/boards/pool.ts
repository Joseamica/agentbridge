import { randomBytes } from 'node:crypto'
import type { NostrEvent } from 'nostr-tools/pure'
import type { Identity } from '../identity'
import { NOSTR, nowSeconds } from '../nostr-constants'
import { BoardConnection, type Filter } from './connection'
import { ReceiveQueue } from './receive-queue'
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
const newSubscriptionId = () => randomBytes(8).toString('hex')
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Ruling 15b: any relay-supplied string that reaches `log` (a CLOSED reason, an error message
// derived from one) is untrusted and unbounded. Control characters are blanked and the result is
// capped well under typical terminal/log-line limits. Deliberately not exported from index.ts —
// this is an internal detail of how the pool logs, not part of the package's public surface.
export function sanitizeRelayText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200)
}

export class BoardPool {
  private readonly connections = new Map<string, BoardConnection>()
  private readonly liveClosers = new Set<() => Promise<void>>()

  constructor(private readonly options: PoolOptions) {}

  private async connection(relay: string): Promise<BoardConnection> {
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

  async publish(relays: readonly string[], event: NostrEvent, beforeSend: () => boolean = () => true): Promise<PublishOutcome> {
    const outcome: PublishOutcome = { accepted: [], rejected: [] }
    const targets = [...new Set(relays)].slice(0, NOSTR.maxRelaysPerContact)
    await Promise.all(
      targets.map(async (relay) => {
        try {
          const result = await (await this.connection(relay)).publish(event, beforeSend)
          if (result.ok) outcome.accepted.push(relay)
          else outcome.rejected.push({ relay, reason: result.message })
        } catch (err) {
          outcome.rejected.push({ relay, reason: `error: ${messageOf(err)}` })
        }
      }),
    )
    return outcome
  }

  async query(relay: string, filter: Filter, timeoutMs = this.options.timeoutMs ?? 10_000): Promise<QueryResult> {
    let conn: BoardConnection
    try {
      conn = await this.connection(relay)
    } catch (err) {
      return { events: [], complete: false, closedReason: `error: ${messageOf(err)}` }
    }
    const id = newSubscriptionId()
    const events: unknown[] = []
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
          events.push(raw)
        },
        onEose: () => finish({ events, complete: true, closedReason: null }),
        onClosed: (reason) => finish({ events, complete: false, closedReason: reason }),
      })
    })
  }

  subscribeLive<T>(relays: readonly string[], handlers: LiveHandlers<T>): { close(): Promise<void> } {
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
    const close = async () => {
      if (!stopped) {
        stopped = true
        for (const stop of [...stoppers]) stop()
        for (const wake of [...wakers]) wake()
      }
      await Promise.all(loops)
      await queue.idle()
      this.liveClosers.delete(close)
    }
    this.liveClosers.add(close)
    return { close }
  }

  async close(): Promise<void> {
    await Promise.all([...this.liveClosers].map((close) => close()))
    for (const conn of this.connections.values()) conn.close()
    this.connections.clear()
  }
}
