import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REQUEST_NOTICE_INTERVAL_SECONDS, markRequestNoticePending, openStore, type Store } from '@agentbridge/core'
import { REQUEST_NOTICE_TEXT, notifyNewRequests } from '../src/notify'

const T0 = 2_000_000_000
let store: Store
let runs: Array<{ file: string; args: readonly string[] }>
const recordRun = async (file: string, args: readonly string[]) => {
  runs.push({ file, args })
}

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-notify-')), 'home'))
  runs = []
})
afterEach(() => store.close())

describe('notifyNewRequests', () => {
  it('does nothing while no request is waiting for a notice', async () => {
    expect(await notifyNewRequests({ store, now: T0, platform: 'darwin', run: recordRun })).toBe(false)
    expect(runs).toEqual([])
  })

  it('shows a fixed-text macOS notification without a shell', async () => {
    markRequestNoticePending(store, T0)
    expect(await notifyNewRequests({ store, now: T0, platform: 'darwin', run: recordRun })).toBe(true)
    expect(runs).toEqual([{ file: 'osascript', args: ['-e', `display notification "${REQUEST_NOTICE_TEXT}" with title "AgentBridge"`] }])
  })

  it('uses notify-send on Linux', async () => {
    markRequestNoticePending(store, T0)
    expect(await notifyNewRequests({ store, now: T0, platform: 'linux', run: recordRun })).toBe(true)
    expect(runs).toEqual([{ file: 'notify-send', args: ['AgentBridge', REQUEST_NOTICE_TEXT] }])
  })

  it('shows at most one notice every 10 minutes', async () => {
    markRequestNoticePending(store, T0)
    await notifyNewRequests({ store, now: T0, platform: 'darwin', run: recordRun })
    markRequestNoticePending(store, T0 + 1)
    expect(await notifyNewRequests({ store, now: T0 + REQUEST_NOTICE_INTERVAL_SECONDS - 1, platform: 'darwin', run: recordRun })).toBe(false)
    expect(await notifyNewRequests({ store, now: T0 + REQUEST_NOTICE_INTERVAL_SECONDS, platform: 'darwin', run: recordRun })).toBe(true)
    expect(runs).toHaveLength(2)
  })

  it('does nothing, and keeps the slot free, on other platforms', async () => {
    markRequestNoticePending(store, T0)
    expect(await notifyNewRequests({ store, now: T0, platform: 'win32', run: recordRun })).toBe(false)
    expect(await notifyNewRequests({ store, now: T0, platform: 'darwin', run: recordRun })).toBe(true)
  })

  it('reports a failed notification without throwing', async () => {
    const logs: string[] = []
    const failing = async () => {
      throw Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' })
    }
    markRequestNoticePending(store, T0)
    expect(await notifyNewRequests({ store, now: T0, platform: 'linux', run: failing, log: (line) => logs.push(line) })).toBe(false)
    expect(logs).toEqual(['request notice failed (Error (ENOENT))'])
  })

  it('never rejects when the store fails', async () => {
    const logs: string[] = []
    const busy: Store = {
      ...store,
      tx: () => {
        throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' })
      },
    }
    expect(await notifyNewRequests({ store: busy, now: T0, platform: 'darwin', run: recordRun, log: (line) => logs.push(line) })).toBe(false)
    expect(logs).toEqual(['request notice failed (Error (ERR_SQLITE_ERROR))'])
  })

  it('keeps third-party text out of the notification', () => {
    expect(REQUEST_NOTICE_TEXT).toBe('AgentBridge: tienes solicitudes nuevas')
  })
})
