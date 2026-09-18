import {
  LIMITS,
  answerQuestion,
  describeError,
  expireAttempt,
  getAttemptState,
  reserveNextQuestion,
  type AnswerOutcome,
  type AttemptCancelReason,
  type Confidence,
  type Identity,
  type Store,
} from '@agentbridge/core'

export type QuestionNotice = { code: string; fromName: string; text: string }
export type CancelReason = 'timeout' | AttemptCancelReason
export type ReplyArgs = { code: string; answer: string; source: string; confidence: Confidence }

export type DispatcherOptions = {
  store: Store
  identity: Identity
  epoch: number
  deliver(question: QuestionNotice): Promise<void>
  cancel(code: string, reason: CancelReason): Promise<void>
  onEnqueued?(): void
  onFenced?(): void
  attemptTimeoutMs?: number
  pollMs?: number
  nowMs?: () => number
  log?: (line: string) => void
}

type Tracked = { attemptId: string; code: string; deadlineMs: number }

// Hands Claude one question at a time. Every store call re-checks this channel's epoch, so a channel
// that lost the lock stops instead of confirming anything. It polls the store, because other processes
// (a CLI revoke, a CLI sync that admits questions) change it too.
export class Dispatcher {
  private tracked: Tracked | null = null
  private timer: NodeJS.Timeout | null = null
  private chain: Promise<void> = Promise.resolve()
  private stopped = false
  private readonly attemptTimeoutMs: number
  private readonly pollMs: number
  private readonly nowMs: () => number
  private readonly log: (line: string) => void

  constructor(private readonly options: DispatcherOptions) {
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? LIMITS.attemptTimeoutMs
    this.pollMs = options.pollMs ?? 1_000
    this.nowMs = options.nowMs ?? Date.now
    this.log = options.log ?? (() => {})
  }

  start(): void {
    this.schedule(0)
  }

  wake(): void {
    this.schedule(0)
  }

  reply(args: ReplyArgs): AnswerOutcome {
    if (this.stopped) return { kind: 'fenced' }
    const outcome = answerQuestion(this.options.store, {
      epoch: this.options.epoch,
      code: args.code,
      nowMs: this.nowMs(),
      identity: this.options.identity,
      text: args.answer,
      source: args.source,
      confidence: args.confidence,
    })
    if (outcome.kind === 'fenced') {
      this.fence()
    } else if (outcome.kind === 'answered') {
      if (this.tracked?.code === outcome.code) this.tracked = null
      this.options.onEnqueued?.()
      this.wake()
    } else if (outcome.kind === 'late') {
      this.wake()
    }
    return outcome
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.chain
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.chain = this.chain
        .then(() => this.tick())
        .catch((err: unknown) => this.log(`dispatch failed (${describeError(err)})`))
        .finally(() => {
          // A tick that threw never reached its own scheduling: the next poll must still happen.
          if (!this.stopped && this.timer === null) this.schedule(this.pollMs)
        })
    }, Math.max(0, delayMs))
  }

  // Handing something to Claude goes through stdio, which waits for the pipe to drain. It is started,
  // never awaited, so a stuck write cannot hold up deadlines, fencing or stop().
  private notify(what: string, send: () => Promise<void>): void {
    void Promise.resolve()
      .then(send)
      .catch((err: unknown) => this.log(`could not ${what} (${describeError(err)})`))
  }

  private fence(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.log('another channel took the lock for this identity; stopping')
    this.options.onFenced?.()
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    const { store, identity, epoch } = this.options

    if (this.tracked) {
      const tracked = this.tracked
      const attempt = getAttemptState(store, tracked.attemptId)
      if (attempt?.state === 'cancelled') {
        this.tracked = null
        this.notify('tell Claude a question was cancelled', () => this.options.cancel(tracked.code, attempt.cancelReason ?? 'revoked'))
      } else if (attempt?.state === 'active' && tracked.deadlineMs <= this.nowMs()) {
        const expired = expireAttempt(store, { epoch, attemptId: tracked.attemptId, nowMs: this.nowMs(), identity })
        if (expired.kind === 'fenced') return this.fence()
        if (expired.kind === 'requeued' || expired.kind === 'rejected_unanswered') {
          this.tracked = null
          this.notify('tell Claude a question timed out', () => this.options.cancel(tracked.code, 'timeout'))
          if (expired.kind === 'rejected_unanswered') this.options.onEnqueued?.()
        }
      } else if (attempt?.state !== 'active') {
        this.tracked = null
      }
    }

    if (!this.tracked && !this.stopped) {
      const reserved = reserveNextQuestion(store, { epoch, nowMs: this.nowMs(), attemptTimeoutMs: this.attemptTimeoutMs, identity })
      if (reserved.kind === 'fenced') return this.fence()
      if (reserved.kind === 'reserved') {
        const { attempt } = reserved
        this.tracked = { attemptId: attempt.attemptId, code: attempt.code, deadlineMs: attempt.deadlineMs }
        // If Claude never gets it, the attempt's deadline brings the question back.
        this.notify('hand a question to Claude', () => this.options.deliver({ code: attempt.code, fromName: attempt.fromName, text: attempt.text }))
      }
    }

    const untilDeadline = this.tracked ? Math.max(0, this.tracked.deadlineMs - this.nowMs()) : this.pollMs
    this.schedule(Math.min(this.pollMs, untilDeadline))
  }
}
