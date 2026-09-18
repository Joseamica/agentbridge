import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NostrEvent } from 'nostr-tools/pure'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Device,
  SeenIds,
  approveRequest,
  createRumor,
  handleResponderMessage,
  nowSeconds,
  openStore,
  openWrap,
  precheckWrap,
  recordIncomingRequest,
  setProfile,
  wrapRumor,
  type HistoryRun,
  type Message,
  type PrecheckedWrap,
  type Store,
} from '@agentbridge/core'
import { plainSocketFactory, startFakeBoard, type FakeBoard, type FakeBoardOptions } from './support/fake-board'
import { testIdentity } from './support/keys'

const responder = testIdentity(91)
const asker = testIdentity(92)
const uuid = (k: number) => `00000000-0000-4000-8000-${k.toString(16).padStart(12, '0')}`
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const until = async (check: () => boolean, ms = 10_000) => {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function setup(options: { mine?: FakeBoardOptions; handle?: typeof handleResponderMessage } = {}) {
  const mine = await startFakeBoard(options.mine ?? {})
  const theirs = await startFakeBoard()
  const store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-device-')), 'home'), {
    relayPolicy: (inputs) => inputs.filter((x): x is string => typeof x === 'string'),
  })
  const now = nowSeconds()
  setProfile(store, { name: 'Ana', relays: [mine.url], now })
  recordIncomingRequest(store, { pubkey: asker.publicKey, requestId: uuid(1), requestRumorId: '1'.repeat(64), declaredName: 'Beto', note: '', relays: [theirs.url], now })
  approveRequest(store, { pubkey: asker.publicKey, now })
  const logs: string[] = []
  const outcomes: unknown[] = []
  const device = new Device({
    store,
    identity: responder,
    role: 'responder',
    handleMessage: options.handle ?? handleResponderMessage,
    onMessage: (_opened, outcome) => outcomes.push(outcome),
    createSocket: plainSocketFactory,
    log: (line) => logs.push(line),
    pool: { timeoutMs: 2_000, reconnectDelaysMs: [50] },
    publishIntervalMs: 200,
  })
  cleanups.push(() => mine.close(), () => theirs.close(), () => store.close(), () => device.close())
  return { mine, theirs, store, device, logs, outcomes }
}

async function questionWrap(questionId: string, text = '¿Cuándo?'): Promise<NostrEvent> {
  const now = nowSeconds()
  const message: Message = { v: 1, type: 'question', questionId, generation: 1, text }
  return wrapRumor(createRumor(message, asker, now), asker, responder.publicKey, { now })
}

function openedByAsker(board: FakeBoard): Message[] {
  const seen = new SeenIds()
  const now = nowSeconds()
  return board.events.flatMap((event) => {
    const pre = precheckWrap(JSON.parse(JSON.stringify(event)), { identity: asker, now, seen })
    if (!pre.ok) return []
    const opened = openWrap(pre, { identity: asker, now, seen })
    return opened.ok ? [opened.message] : []
  })
}

const inboxCount = (store: Store) => Number(store.db.prepare('SELECT count(*) AS n FROM inbox_questions').get()?.n)

describe('Device', () => {
  it('admits a live question and publishes its receipt to the asker’s relays', async () => {
    const { mine, theirs, store, device } = await setup()
    device.start()
    await until(() => mine.frames.some((f) => f[0] === 'REQ'))
    mine.inject(await questionWrap(uuid(10)))
    await until(() => openedByAsker(theirs).some((m) => m.type === 'receipt'))
    expect(inboxCount(store)).toBe(1)
    expect(openedByAsker(theirs)).toEqual([{ v: 1, type: 'receipt', questionId: uuid(10) }])
  })

  it('recovers a question stored before it started', async () => {
    const { mine, theirs, store, device, outcomes } = await setup()
    mine.inject(await questionWrap(uuid(11)))
    device.start()
    await until(() => inboxCount(store) === 1)
    await until(() => openedByAsker(theirs).length === 1)
    expect(outcomes).toEqual([{ kind: 'question', outcome: { kind: 'queued' } }])
  })

  it('forgets a wrap whose processing failed, so a later pass processes it again, and never logs the error text', async () => {
    let failures = 1
    const { mine, store, device, logs } = await setup({
      handle: (s, input) => {
        if (failures-- > 0) throw new Error('disk full near PRIVATE_DECRYPTED_CANARY')
        return handleResponderMessage(s, input)
      },
    })
    mine.inject(await questionWrap(uuid(12)))
    const first = await device.syncOnce({ maxMs: 5_000 })
    expect(first.history.every((run) => run.failed)).toBe(true)
    expect(inboxCount(store)).toBe(0)
    expect(logs.some((line) => line.includes('history failed'))).toBe(true)
    expect(logs.join('\n')).not.toContain('PRIVATE_DECRYPTED_CANARY')
    await device.syncOnce({ maxMs: 5_000 })
    expect(inboxCount(store)).toBe(1)
  })

  it('never lets a live processing failure put the error text in a log line', async () => {
    const { mine, device, logs } = await setup({
      handle: () => {
        throw new Error('disk full near PRIVATE_DECRYPTED_CANARY')
      },
    })
    device.start()
    await until(() => mine.frames.some((f) => f[0] === 'REQ'))
    mine.inject(await questionWrap(uuid(15)))
    await until(() => logs.some((line) => line.includes('could not store a received message')))
    expect(logs.join('\n')).not.toContain('PRIVATE_DECRYPTED_CANARY')
  })

  it('makes history wait for a wrap still in flight before counting it as handled', async () => {
    const { mine, device } = await setup()
    const wrap = await questionWrap(uuid(13))
    mine.inject(wrap)
    const internals = device as unknown as {
      precheck(raw: unknown): PrecheckedWrap | null
      process(item: PrecheckedWrap): Promise<void>
      handleHistoryEvent(raw: unknown): Promise<void>
    }
    const raw = JSON.parse(JSON.stringify(wrap))
    const item = internals.precheck(raw)
    expect(item).not.toBeNull()
    let historyDone = false
    const history = internals.handleHistoryEvent(JSON.parse(JSON.stringify(wrap))).then(() => {
      historyDone = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(historyDone).toBe(false)
    await internals.process(item!)
    await history
    expect(historyDone).toBe(true)
  })

  it('publishes only inside a sync, never through a background publisher left running after it', async () => {
    const { mine, theirs, device } = await setup()
    mine.inject(await questionWrap(uuid(14)))
    const report = await device.syncOnce({ maxMs: 10_000 })
    expect(report.published.published).toBe(1)
    expect((device as unknown as { publishing: Promise<void> | null }).publishing).toBeNull()
    const events = theirs.events.length
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(theirs.events.length).toBe(events)
  })

  it('stops starting work once a sync runs out of time', async () => {
    const { device } = await setup({ mine: { ignoreReads: true } })
    const started = Date.now()
    const report = await device.syncOnce({ maxMs: 1_000 })
    expect(report.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('closes cleanly while running', async () => {
    const { mine, device } = await setup()
    device.start()
    await until(() => mine.frames.some((f) => f[0] === 'REQ'))
    await device.close()
    await device.close()
  })

  it('reports a history run as failed when the profile read throws, instead of escaping synchronously', async () => {
    const { store, device, logs } = await setup()
    const boom = new Error('disk full near PRIVATE_DECRYPTED_CANARY')
    ;(store as unknown as { relayPolicy: (inputs: readonly unknown[]) => string[] }).relayPolicy = () => {
      throw boom
    }
    const internals = device as unknown as { runHistory(): Promise<HistoryRun[]> }
    let escaped: unknown = null
    let pending: Promise<HistoryRun[]> | undefined
    try {
      pending = internals.runHistory()
    } catch (err) {
      escaped = err
    }
    expect(escaped).toBeNull()
    const runs = await pending!
    expect(runs).toEqual([])
    expect(logs.some((line) => line.includes('history failed'))).toBe(true)
    expect(logs.join('\n')).not.toContain('PRIVATE_DECRYPTED_CANARY')
  })

  it('returns a no-op report from syncOnce after close, without touching the store or the pool', async () => {
    const { mine, device } = await setup()
    device.start()
    await until(() => mine.frames.some((f) => f[0] === 'REQ'))
    await device.close()
    const framesBefore = mine.frames.length
    const report = await device.syncOnce({ maxMs: 5_000 })
    expect(report).toEqual({ history: [], published: { published: 0, failed: 0, postponed: 0, lost: 0 }, timedOut: false })
    expect(mine.frames.length).toBe(framesBefore)
  })
})
