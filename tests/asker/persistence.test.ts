import { afterEach, describe, expect, it } from 'vitest'
import { startFakeBoard, testIdentity, type Cleanups, type FakeBoard } from '../responder/support'
import { seedApprovedPair, startAsker, type AskerHarness } from './support'

const ana = testIdentity(81) // answers
const beto = testIdentity(82) // asks
const cleanups: Cleanups = []

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

// Both sides already know each other, so these tests are about writing and publishing, not about
// the connection dance.
async function askerReadyToAsk(board: FakeBoard): Promise<AskerHarness> {
  const { askerHome } = await seedApprovedPair({ board, ana, beto, cleanups })
  return startAsker({ identity: beto, relays: [board.url], cleanups, home: askerHome })
}

// Only the envelopes this person published, not the reads, the auth or the subscriptions.
function publishedFrames(board: FakeBoard): unknown[][] {
  return board.frames.filter((frame) => frame[0] === 'EVENT')
}

describe('a database that cannot be written to', () => {
  it('refuses to store the question and publishes nothing', async () => {
    const board = await startFakeBoard()
    cleanups.push(() => board.close())
    const asker = await askerReadyToAsk(board)

    // What a restored backup, a synced folder or a read-only volume produces, without depending on
    // file permissions — chmod would not revoke the handle this connection already holds.
    asker.store.db.exec('PRAGMA query_only = 1')

    const error = await asker.service.ask('ana', '¿sigue en pie lo de mañana?').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)

    // And publishing afterwards still sends nothing: there is no row to send.
    await asker.sync().catch(() => undefined)
    expect(publishedFrames(board)).toEqual([])

    // Put it back so the harness can close cleanly.
    asker.store.db.exec('PRAGMA query_only = 0')
  })
})

describe('a disk that fills up mid-write', () => {
  it('rolls both tables back and publishes nothing, and a healthy ask right after still works', async () => {
    const board = await startFakeBoard()
    cleanups.push(() => board.close())
    const asker = await askerReadyToAsk(board)

    // Real node:sqlite reports a full disk as ERR_SQLITE_ERROR with errcode 13 — not a `SQLITE_FULL`
    // code — and it surfaces from the write itself. Injecting it at the outbox insertion is
    // deterministic and exercises the same ordering a real full disk would: store the question and
    // its outgoing row in one transaction, publish only afterwards.
    const realPrepare = asker.store.db.prepare.bind(asker.store.db)
    let injected = false
    let armed = true
    Object.defineProperty(asker.store.db, 'prepare', {
      configurable: true,
      value: (sql: string) => {
        const statement = realPrepare(sql)
        if (armed && /INSERT INTO outbox\b/i.test(sql)) {
          return new Proxy(statement, {
            get(target, prop, receiver) {
              if (prop !== 'run') return Reflect.get(target, prop, receiver)
              return () => {
                injected = true
                armed = false
                const err = new Error('database or disk is full') as Error & { code?: string; errcode?: number }
                err.code = 'ERR_SQLITE_ERROR'
                err.errcode = 13
                throw err
              }
            },
          })
        }
        return statement
      },
    })

    const error = await asker.service.ask('ana', '¿me confirmas la dirección?').catch((e: unknown) => e)
    // Without this the test would also pass if `ask` had failed for an unrelated reason — a missing
    // contact, say — and proved nothing about ordering.
    expect(injected).toBe(true)
    expect(error).toBeInstanceOf(Error)

    await asker.sync().catch(() => undefined)
    expect(publishedFrames(board)).toEqual([])
    // Both halves rolled back together: a question with no outgoing row would sit in `sending`
    // forever, which is the same inconsistency seen from this side.
    expect((asker.store.db.prepare('SELECT COUNT(*) AS n FROM outbox_questions').get() as { n: number }).n).toBe(0)
    expect((asker.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n).toBe(0)

    // The control: with the fault gone, the very same call stores and publishes. Without it, a test
    // that asserts "nothing was published" passes just as well against a product that never
    // publishes anything at all.
    const question = await asker.service.ask('ana', '¿ahora sí?')
    expect(question.state).toBe('sending')
    await asker.sync()
    expect(publishedFrames(board).length).toBeGreaterThan(0)
  })
})
