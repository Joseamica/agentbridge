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
        longest = Math.max(longest, queue.length)
        await sleep(1)
        processed++
      },
    })
    const producer = async (source: string, count: number) => {
      for (let n = 0; n < count; n++) await queue.push(source, n)
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
})
