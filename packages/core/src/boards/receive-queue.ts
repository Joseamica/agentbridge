export type ReceiveQueueOptions<T> = {
  max: number
  process: (item: T, source: string) => Promise<void>
  onPressure?: (source: string, waiting: boolean) => void
  onError?: (err: unknown, source: string) => void
}

// Step 5 of the receive pipeline: decryption and everything after it happen one item at a time, and
// the queue never holds more than `max` items. A producer that finds it full waits; because the
// board connection awaits this push before reading its next frame, a slow consumer stops the socket
// from reading instead of dropping or buffering without bound.
export class ReceiveQueue<T> {
  private readonly items: Array<{ source: string; item: T }> = []
  private readonly capacityWaiters: Array<() => void> = []
  private readonly idleWaiters: Array<() => void> = []
  private draining = false

  constructor(private readonly options: ReceiveQueueOptions<T>) {}

  get length(): number {
    return this.items.length
  }

  async push(source: string, item: T): Promise<void> {
    if (this.items.length >= this.options.max) {
      this.options.onPressure?.(source, true)
      while (this.items.length >= this.options.max) {
        await new Promise<void>((resolve) => this.capacityWaiters.push(resolve))
      }
      this.options.onPressure?.(source, false)
    }
    this.items.push({ source, item })
    void this.drain()
  }

  idle(): Promise<void> {
    if (!this.draining && this.items.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.items.length > 0) {
        const next = this.items.shift()!
        this.capacityWaiters.shift()?.()
        try {
          await this.options.process(next.item, next.source)
        } catch (err) {
          this.options.onError?.(err, next.source)
        }
      }
    } finally {
      this.draining = false
      for (const resolve of this.idleWaiters.splice(0)) resolve()
    }
  }
}
