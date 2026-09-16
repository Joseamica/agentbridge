import { makeAuthEvent } from 'nostr-tools/nip42'
import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeBoard, type FakeBoard } from './support/fake-board'
import { testIdentity } from './support/keys'

const alice = testIdentity(1)
const boards: FakeBoard[] = []
afterEach(async () => {
  await Promise.all(boards.splice(0).map((b) => b.close()))
})

async function board(options = {}) {
  const b = await startFakeBoard(options)
  boards.push(b)
  return b
}

async function client(url: string) {
  const ws = new WebSocket(url)
  const inbox: unknown[][] = []
  ws.on('message', (data) => inbox.push(JSON.parse(String(data))))
  await new Promise((r) => ws.once('open', r))
  const next = async (predicate: (f: unknown[]) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const found = inbox.find(predicate)
      if (found) {
        inbox.splice(inbox.indexOf(found), 1)
        return found
      }
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('frame not received')
  }
  return { ws, next, inbox, send: (frame: unknown[]) => ws.send(JSON.stringify(frame)) }
}

const note = (content: string, created_at: number, p = 'b'.repeat(64)): NostrEvent =>
  finalizeEvent({ kind: 1059, created_at, tags: [['p', p]], content }, alice.secretKey)

describe('fake board', () => {
  it('stores events, answers OK, reports duplicates and serves them newest first with EOSE', async () => {
    const b = await board()
    const c = await client(b.url)
    const older = note('a', 100)
    const newer = note('b', 200)
    c.send(['EVENT', older])
    expect(await c.next((f) => f[0] === 'OK')).toEqual(['OK', older.id, true, ''])
    c.send(['EVENT', newer])
    await c.next((f) => f[0] === 'OK')
    c.send(['EVENT', older])
    expect(await c.next((f) => f[0] === 'OK')).toEqual(['OK', older.id, true, 'duplicate: already have this event'])
    c.send(['REQ', 's1', { kinds: [1059], '#p': ['b'.repeat(64)], limit: 10 }])
    expect((await c.next((f) => f[0] === 'EVENT'))[2]).toMatchObject({ id: newer.id })
    expect((await c.next((f) => f[0] === 'EVENT'))[2]).toMatchObject({ id: older.id })
    expect(await c.next((f) => f[0] === 'EOSE')).toEqual(['EOSE', 's1'])
    c.ws.close()
  })

  it('pushes new matching events to live subscriptions', async () => {
    const b = await board()
    const c = await client(b.url)
    c.send(['REQ', 'live', { kinds: [1059], since: 50 }])
    await c.next((f) => f[0] === 'EOSE')
    b.inject(note('later', 300))
    expect((await c.next((f) => f[0] === 'EVENT'))[1]).toBe('live')
    c.ws.close()
  })

  it('requires NIP-42 auth when configured, and accepts a valid AUTH event', async () => {
    const b = await board({ requireAuthToRead: true, requireAuthToWrite: true })
    const c = await client(b.url)
    const challenge = (await c.next((f) => f[0] === 'AUTH'))[1] as string
    c.send(['REQ', 's', { kinds: [1059] }])
    expect(await c.next((f) => f[0] === 'CLOSED')).toEqual(['CLOSED', 's', 'auth-required: reading requires authentication'])
    const auth = finalizeEvent(makeAuthEvent(b.url, challenge), alice.secretKey)
    c.send(['AUTH', auth])
    expect(await c.next((f) => f[0] === 'OK')).toEqual(['OK', auth.id, true, ''])
    expect(b.authenticated.has(alice.publicKey)).toBe(true)
    c.send(['REQ', 's', { kinds: [1059] }])
    expect(await c.next((f) => f[0] === 'EOSE')).toEqual(['EOSE', 's'])
    c.ws.close()
  })

  it('can reject reads, reject oversize frames and pretend to store events it drops', async () => {
    const b = await board({ rejectReads: true, maxFrameBytes: 600, dropIncoming: () => true })
    const c = await client(b.url)
    const big = note('x'.repeat(700), 1)
    c.send(['EVENT', big])
    expect(await c.next((f) => f[0] === 'OK')).toEqual(['OK', big.id, false, 'invalid: event too large'])
    const small = note('y', 1)
    c.send(['EVENT', small])
    expect(await c.next((f) => f[0] === 'OK')).toEqual(['OK', small.id, true, ''])
    expect(b.events).toHaveLength(0)
    c.send(['REQ', 'r', {}])
    expect(await c.next((f) => f[0] === 'CLOSED')).toEqual(['CLOSED', 'r', 'restricted: reads are disabled'])
    c.ws.close()
  })

  it('caps results at its own maximum limit', async () => {
    const b = await board({ maxLimit: 3 })
    for (let i = 0; i < 5; i++) b.inject(note(String(i), 1000 + i))
    const c = await client(b.url)
    c.send(['REQ', 'cap', { limit: 100 }])
    await c.next((f) => f[0] === 'EOSE')
    expect(c.inbox.filter((f) => f[0] === 'EVENT')).toHaveLength(3)
    c.ws.close()
  })
})
