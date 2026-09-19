import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Device, acquireChannelLock, loadOrCreateIdentity, openStore, setProfile, type Store } from '@agentbridge/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plainSocketFactory, startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { AskerService } from '../src/asker/service'
import { openAskerSession, withAsker, withResponderSession } from '../src/asker/session'
import { memoryOutput, type CliContext } from '../src/context'

// Fix round 1, Important I1. `session.ts` had zero tests and zero callers before this: nothing
// defended its "always closes, whatever happens inside" contract, or P10's "never takes the channel
// lock, never starts a dispatcher." These drive the real functions against a temporary home and a
// local fake board, the same way asker-service.test.ts already does for AskerService itself.

let board: FakeBoard
let home: string
let ctx: CliContext

const allowAnyRelay = (inputs: readonly unknown[]): string[] =>
  inputs.filter((value): value is string => typeof value === 'string' && value.startsWith('ws')).slice(0, 5)

beforeEach(async () => {
  board = await startFakeBoard()
  home = join(await mkdtemp(join(tmpdir(), 'ab-asker-session-')), 'home')
  await loadOrCreateIdentity(home)
  // Seeded through a throwaway connection to the same file, then closed: openAskerSession and
  // withResponderSession each open their own Store from `home`, so the profile has to already be on
  // disk before either of them does. Without a relay of its own, getProfile() falls back to the
  // real public defaults, and a test may never reach one.
  const seed = await openStore(home, { relayPolicy: allowAnyRelay })
  setProfile(seed, { name: 'Beto', relays: [board.url], now: 2_000_000_000 })
  seed.close()
  ctx = { home, out: memoryOutput(), env: {}, relayPolicy: allowAnyRelay, createSocket: plainSocketFactory }
})

afterEach(async () => {
  await board.close()
})

describe('withAsker', () => {
  it('opens, syncs, runs fn, syncs again, and closes the device — the happy path', async () => {
    const closeSpy = vi.spyOn(Device.prototype, 'close')
    const result = await withAsker(
      ctx,
      async (service) => {
        expect(service).toBeInstanceOf(AskerService)
        return 'ok'
      },
      { firstSyncMs: 500, lastSyncMs: 500 },
    )
    expect(result).toBe('ok')
    expect(closeSpy).toHaveBeenCalledTimes(1)
    closeSpy.mockRestore()
  })

  it('still closes the device when fn throws', async () => {
    const closeSpy = vi.spyOn(Device.prototype, 'close')
    await expect(
      withAsker(
        ctx,
        async () => {
          throw new Error('fn boom')
        },
        { firstSyncMs: 500, lastSyncMs: 500 },
      ),
    ).rejects.toThrow('fn boom')
    expect(closeSpy).toHaveBeenCalledTimes(1)
    closeSpy.mockRestore()
  })

  it('still closes the device when the first sync throws, and never calls fn', async () => {
    const closeSpy = vi.spyOn(Device.prototype, 'close')
    const syncSpy = vi.spyOn(AskerService.prototype, 'sync').mockRejectedValueOnce(new Error('sync boom'))
    const fn = vi.fn()
    await expect(withAsker(ctx, fn, { firstSyncMs: 500, lastSyncMs: 500 })).rejects.toThrow('sync boom')
    expect(fn).not.toHaveBeenCalled()
    expect(closeSpy).toHaveBeenCalledTimes(1)
    syncSpy.mockRestore()
    closeSpy.mockRestore()
  })

  // AskerService.close() is written to swallow the device's own close failures (it never throws
  // today), so this drives openAskerSession's own close() directly, on the assumption that it might:
  // store.close() is in a finally specifically so a close failure there can never skip it. A
  // reopen-based check does not prove this — WAL-mode SQLite happily opens a second connection to a
  // file another handle in the same process still has open — so this spies on the real Store's own
  // close() instead.
  it('still releases the store from openAskerSession when close() itself throws', async () => {
    const session = await openAskerSession({ home, relayPolicy: allowAnyRelay, createSocket: plainSocketFactory })
    const store = (session.service as unknown as { store: Store }).store
    const storeCloseSpy = vi.spyOn(store, 'close')
    vi.spyOn(session.service, 'close').mockRejectedValueOnce(new Error('close boom'))

    await expect(session.close()).rejects.toThrow('close boom')
    expect(storeCloseSpy).toHaveBeenCalledTimes(1)
  })
})

describe('withResponderSession', () => {
  it('opens, syncs, runs fn, syncs again, and closes the device — the happy path', async () => {
    const closeSpy = vi.spyOn(Device.prototype, 'close')
    const result = await withResponderSession(ctx, async () => 'ok')
    expect(result).toBe('ok')
    expect(closeSpy).toHaveBeenCalledTimes(1)
    closeSpy.mockRestore()
  })

  it('still closes the device when fn throws', async () => {
    const closeSpy = vi.spyOn(Device.prototype, 'close')
    await expect(
      withResponderSession(ctx, async () => {
        throw new Error('fn boom')
      }),
    ).rejects.toThrow('fn boom')
    expect(closeSpy).toHaveBeenCalledTimes(1)
    closeSpy.mockRestore()
  })

  it('still closes the device when the first sync throws, and never calls fn', async () => {
    const closeSpy = vi.spyOn(Device.prototype, 'close')
    const syncOnceSpy = vi.spyOn(Device.prototype, 'syncOnce').mockRejectedValueOnce(new Error('sync boom'))
    const fn = vi.fn()
    await expect(withResponderSession(ctx, fn)).rejects.toThrow('sync boom')
    expect(fn).not.toHaveBeenCalled()
    expect(closeSpy).toHaveBeenCalledTimes(1)
    syncOnceSpy.mockRestore()
    closeSpy.mockRestore()
  })

  // As above: a reopen-based check would not prove this (WAL-mode SQLite allows it either way), so
  // this spies on the real Store — captured from what fn() itself is handed — instead.
  it('still releases the store when device.close() itself throws', async () => {
    let storeCloseSpy: ReturnType<typeof vi.spyOn> | undefined
    const deviceCloseSpy = vi.spyOn(Device.prototype, 'close').mockRejectedValueOnce(new Error('close boom'))

    await expect(
      withResponderSession(ctx, async ({ store }) => {
        storeCloseSpy = vi.spyOn(store, 'close')
      }),
    ).rejects.toThrow('close boom')

    expect(storeCloseSpy).toHaveBeenCalledTimes(1)
    deviceCloseSpy.mockRestore()
  })

  // P10: this is the responder's own cursors/handler, but it must never take the channel lock or
  // start a dispatcher — only the channel does either of those. Seeded and checked through a second,
  // independent connection to the same home, so this observes the lock table exactly as another
  // process (the channel) would, rather than trusting anything withResponderSession returns.
  it('never touches the channel lock', async () => {
    const seed = await openStore(home, { relayPolicy: allowAnyRelay })
    try {
      const before = acquireChannelLock(seed, { self: { pid: 111, start: 'channel' }, isAlive: () => true, now: 2_000_000_000 })
      expect(before).toMatchObject({ kind: 'acquired' })

      await withResponderSession(ctx, async ({ store }) => {
        // If withResponderSession had acquired the lock itself under a third identity, this would
        // come back 'acquired' (a foreign, dead-per-isAlive owner loses) instead of still finding
        // pid 111 in possession.
        const attempt = acquireChannelLock(store, { self: { pid: 222, start: 'someone-else' }, isAlive: () => true, now: 2_000_000_001 })
        expect(attempt).toMatchObject({ kind: 'held', holder: { pid: 111, start: 'channel' } })
      })

      // Still held by the original owner afterwards too: nothing released or re-acquired it either.
      const after = acquireChannelLock(seed, { self: { pid: 333, start: 'another' }, isAlive: () => true, now: 2_000_000_002 })
      expect(after).toMatchObject({ kind: 'held', holder: { pid: 111, start: 'channel' } })
    } finally {
      seed.close()
    }
  })
})
