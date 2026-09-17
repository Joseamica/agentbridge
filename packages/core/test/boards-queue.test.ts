import { describe, expect, it } from 'vitest'
import { ReceiveQueue } from '@agentbridge/core'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('ReceiveQueue', () => {
  it('processes one item at a time, in arrival order', async () => {
    let running = 0
    let maxRunning = 0
    const seen: number[] = []
    const queue = new ReceiveQueue<number>({
      max: 100,
      process: async (n) => {
        running++
        maxRunning = Math.max(maxRunning, running)
        await sleep(2)
        seen.push(n)
        running--
      },
    })
    for (let n = 0; n < 20; n++) await queue.push('a', n)
    await queue.idle()
    expect(seen).toEqual([...Array(20).keys()])
    expect(maxRunning).toBe(1)
  })

  it('never holds more than max items: producers wait for room, and nothing is dropped', async () => {
    const signals: Array<[string, boolean]> = []
    let processed = 0
    let longest = 0
    const queue = new ReceiveQueue<number>({
      max: 10,
      onPressure: (source, waiting) => signals.push([source, waiting]),
      process: async () => {
        await sleep(1)
        processed++
      },
    })
    const producer = async (source: string, count: number) => {
      for (let n = 0; n < count; n++) {
        await queue.push(source, n)
        // Measured right after push() returns, not inside process(): process() runs after the
        // item has already been shifted off the internal array, so reading queue.length there
        // cannot catch an overshoot by one.
        longest = Math.max(longest, queue.length)
      }
    }
    await Promise.all([producer('a', 40), producer('b', 40)])
    await queue.idle()
    expect(processed).toBe(80)
    expect(longest).toBeLessThanOrEqual(10)
    expect(queue.length).toBe(0)
    expect(signals).toContainEqual(['a', true])
    expect(signals).toContainEqual(['a', false])
  })

  it('reports processing errors and keeps going', async () => {
    const errors: string[] = []
    const done: number[] = []
    const queue = new ReceiveQueue<number>({
      max: 10,
      onError: (err) => errors.push((err as Error).message),
      process: async (n) => {
        if (n === 1) throw new Error('boom')
        done.push(n)
      },
    })
    for (const n of [0, 1, 2]) await queue.push('a', n)
    await queue.idle()
    expect(errors).toEqual(['boom'])
    expect(done).toEqual([0, 2])
  })

  it('keeps every item when onPressure throws', async () => {
    const processed: number[] = []
    const queue = new ReceiveQueue<number>({
      max: 1,
      onPressure: () => {
        throw new Error('pressure boom')
      },
      process: async (n) => {
        await sleep(1)
        processed.push(n)
      },
    })
    const producer = async (source: string, values: number[]) => {
      for (const n of values) await queue.push(source, n)
    }
    await Promise.all([producer('a', [0, 1, 2]), producer('b', [3, 4])])
    await queue.idle()
    expect(processed).toHaveLength(5)
    expect(new Set(processed)).toEqual(new Set([0, 1, 2, 3, 4]))
  })

  it('survives a throwing onError', async () => {
    const done: number[] = []
    const queue = new ReceiveQueue<number>({
      max: 10,
      onError: () => {
        throw new Error('onError boom')
      },
      process: async (n) => {
        if (n === 1) throw new Error('boom')
        done.push(n)
      },
    })
    for (const n of [0, 1, 2]) await queue.push('a', n)
    await queue.idle()
    expect(done).toEqual([0, 2])
  })

  it('waits for a synchronous process throw like an async one', async () => {
    const order: string[] = []
    const queue = new ReceiveQueue<number>({
      max: 1,
      process: (n) => {
        if (n === -1) return sleep(20).then(() => {})
        if (n === 0) throw new Error('sync boom')
        return sleep(1).then(() => {
          order.push('done-1')
        })
      },
    })
    void queue.push('a', -1)
    await sleep(5)
    void queue.push('a', 0)
    const waitingForRoom = queue.push('a', 1)
    await queue.idle()
    expect(order).toEqual(['done-1'])
    await waitingForRoom
  })
})
