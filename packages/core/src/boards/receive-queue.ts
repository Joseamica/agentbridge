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
      this.notifyPressure(source, true)
      while (this.items.length >= this.options.max) {
        await new Promise<void>((resolve) => this.capacityWaiters.push(resolve))
      }
      this.notifyPressure(source, false)
    }
    this.items.push({ source, item })
    void this.drain()
  }

  idle(): Promise<void> {
    if (!this.draining && this.items.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  // Ruling 15a: onPressure is an observer, not part of delivery. A throwing callback must not lose
  // the item it was called about (which has already passed precheck) and must not stop other
  // waiters from being woken. There is no logger on this class, so the error is simply dropped.
  private notifyPressure(source: string, waiting: boolean): void {
    try {
      this.options.onPressure?.(source, waiting)
    } catch {
      // ignored — see comment above
    }
  }

  // Ruling 15a: onError is an observer too. `drain` is started fire-and-forget via `void`, so a
  // throwing onError would otherwise escape as an unhandled rejection and stop draining entirely.
  private notifyError(err: unknown, source: string): void {
    try {
      this.options.onError?.(err, source)
    } catch {
      // ignored — see comment above
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.items.length > 0) {
        const next = this.items.shift()!
        this.capacityWaiters.shift()?.()
        try {
          // Ruling 15a: wrapping in Promise.resolve().then(...) turns even a synchronous throw
          // from a non-async `process` into a promise rejection, so `await` always yields the
          // microtask queue at least once before this loop re-checks `items.length`. Without that
          // yield, a producer just woken by the `capacityWaiters.shift()` above (whose own
          // continuation is also a microtask) might not have pushed its item yet, and this loop
          // could wrongly conclude the queue is idle before that push lands.
          await Promise.resolve().then(() => this.options.process(next.item, next.source))
        } catch (err) {
          this.notifyError(err, next.source)
        }
      }
    } finally {
      this.draining = false
      for (const resolve of this.idleWaiters.splice(0)) resolve()
    }
  }
}
