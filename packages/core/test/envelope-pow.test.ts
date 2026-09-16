import { getEventHash } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { leadingZeroBits, mineEvent, type UnsignedEvent } from '@agentbridge/core'

const base: UnsignedEvent = {
  pubkey: 'e9451985e285d64afb4594cf538593e53e9fedfbec8bdaec8e9399df40ea41b8',
  created_at: 1_700_000_000,
  kind: 1059,
  tags: [['p', 'a'.repeat(64)], ['expiration', '1700604800']],
  content: 'x'.repeat(4_000),
}

describe('mineEvent', () => {
  it('finds a nonce whose NIP-01 id has the requested leading zero bits, without touching the date or other tags', async () => {
    const mined = await mineEvent(base, 16)
    expect(mined.id).toBe(getEventHash(mined))
    expect(leadingZeroBits(mined.id)).toBeGreaterThanOrEqual(16)
    expect(mined.created_at).toBe(base.created_at)
    expect(mined.tags.slice(0, 2)).toEqual(base.tags)
    expect(mined.tags[2]).toEqual(['nonce', expect.stringMatching(/^\d+$/), '16'])
    expect(base.tags).toHaveLength(2)
  })

  it('mines 16 bits over a 4 KB event in well under ten seconds', async () => {
    const started = Date.now()
    await mineEvent(base, 16)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('keeps the event loop responsive while mining', async () => {
    let ticks = 0
    const timer = setInterval(() => ticks++, 10)
    await mineEvent(base, 18)
    clearInterval(timer)
    expect(ticks).toBeGreaterThan(3)
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    const mining = mineEvent(base, 32, { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await expect(mining).rejects.toThrow(/aborted/)
  })

  it('rejects impossible difficulties', () => {
    expect(() => mineEvent(base, 33)).toThrow(RangeError)
    expect(() => mineEvent(base, -1)).toThrow(RangeError)
  })
})
